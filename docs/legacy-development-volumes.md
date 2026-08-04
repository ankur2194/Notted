# Legacy development volume recovery

Two older layouts can leave volumes behind. The earliest Notted checkouts used the fixed
project `notted-dev` with `notted_*_dev_data` volume keys; a later revision derived a
`notted-dev-<checkout-path-hash>` project name. The current stack is back to the fixed
`notted-dev`, declared by `name:` in the root `compose.yaml`, with plain volume keys such
as `postgres-data`.

`pnpm infra:up` detects the exact earliest names, warns, and leaves them untouched. It
cannot detect the hash-derived set, so enumerate those yourself.

Nothing here is deleted implicitly. `docker compose down --volumes` removes only the
volumes declared in the compose file it was given, so neither legacy set is in scope; and
normal `pnpm infra:down` never deletes volumes at all. Still, do not run any volume-reset
command until you have classified and backed up every set.

## 1. Inventory and stop writers

```bash
pnpm infra:project
pnpm infra:down
docker volume ls --format '{{.Name}}' | sort
docker volume ls --filter name=notted-dev- --format '{{.Name}}'   # hash-derived set
```

The earliest legacy names are:

- `notted-dev_notted_postgres_dev_data`
- `notted-dev_notted_redis_dev_data`
- `notted-dev_notted_meilisearch_dev_data`
- `notted-dev_notted_minio_dev_data`

The hash-derived names look like `notted-dev-f80448ec7cf5_postgres-data`. The current
names are `notted-dev_postgres-data`, `notted-dev_redis-data`,
`notted-dev_meilisearch-data`, and `notted-dev_minio-data`, alongside the dependency and
state volumes `notted-dev_root-node-modules`, `notted-dev_pnpm-store`,
`notted-dev_api-dist`, `notted-dev_web-next`, `notted-dev_shared-types-dist`,
`notted-dev_shared-validators-dist`, and `notted-dev_db-init-state`. If any stack is still
running, stop and identify it before continuing.

## 2. Back up the legacy volumes

Choose an absolute directory outside the repository, ensure it has enough free space,
and set `NOTTED_LEGACY_BACKUP_DIR` to that directory. The command below mounts each
source read-only and uses the same checksum-pinned Alpine runtime base as the MinIO
development image.

```bash
mkdir -p "$NOTTED_LEGACY_BACKUP_DIR"
for volume in \
  notted-dev_notted_postgres_dev_data \
  notted-dev_notted_redis_dev_data \
  notted-dev_notted_meilisearch_dev_data \
  notted-dev_notted_minio_dev_data
do
  docker run --rm \
    --volume "$volume:/source:ro" \
    --volume "$NOTTED_LEGACY_BACKUP_DIR:/backup" \
    --workdir /source \
    alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1 \
    tar -czf "/backup/$volume.tar.gz" .
done
sha256sum "$NOTTED_LEGACY_BACKUP_DIR"/*.tar.gz
```

Store the checksum output with the archives and test extraction into a disposable
directory before relying on the backup. These archives contain development data and
may contain secrets or private content; protect them accordingly.

## 3. Choose recovery, do not merge blindly

If the legacy stack contains the authoritative development data, restore its database
and object-store data into fresh current volumes while both stacks are stopped. Do not
copy PostgreSQL files between different PostgreSQL major versions and do not merge two
non-empty volume trees. Prefer service-native export/import:

- PostgreSQL: start the legacy stack, create a custom-format `pg_dump`, stop it, start
  the current stack, and restore with `pg_restore`.
- MinIO: use `mc mirror` between separately started source and destination endpoints,
  then verify object counts, checksums, and private bucket policies.
- Redis and Meilisearch are disposable/rebuildable. Preserve their archives for
  rollback, but do not treat them as authoritative application data.

The current schema includes application tables and deterministic relational seed fixtures.
Those fixture identities are not login credentials. Review every migration added since a
legacy volume was last used before restoring data into the current schema.

## 4. Verify and retain rollback

After recovery, run:

```bash
pnpm env:init
pnpm infra:up:ports
pnpm infra:status
curl --fail --silent http://127.0.0.1:7700/health
curl --fail --silent http://127.0.0.1:9000/minio/health/ready
```

Verify PostgreSQL extensions and the two private MinIO buckets before application work.
Keep the stopped legacy volumes and tested archives until the recovered stack has been
used successfully. Cleanup is deliberately not automated by Notted; remove legacy
volumes only after a separate, reviewed decision.
