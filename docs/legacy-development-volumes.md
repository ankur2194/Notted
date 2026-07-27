# Legacy development volume recovery

The current developer tooling derives a Compose project name from the checkout path.
Older Notted checkouts used the fixed project `notted-dev` and different volume keys.
`pnpm infra:up` detects those exact legacy names, warns, and leaves them untouched.

Do not run either stack's volume-reset command until you have classified and backed up
both sets. Normal `pnpm infra:down` never deletes volumes.

## 1. Inventory and stop writers

```bash
pnpm infra:project
pnpm infra:down
docker compose \
  --env-file docker/.env \
  --file docker/docker-compose.dev.yml \
  --project-name notted-dev \
  down --remove-orphans
docker volume ls --format '{{.Name}}' | sort
```

The legacy names are:

- `notted-dev_notted_postgres_dev_data`
- `notted-dev_notted_redis_dev_data`
- `notted-dev_notted_meilisearch_dev_data`
- `notted-dev_notted_minio_dev_data`

The current names start with the value printed by `pnpm infra:project`. If either
stack is still running, stop and identify it before continuing.

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

At this foundation stage the only committed database migration enables `uuid-ossp` and
`vector`, and no application tables or seed credentials exist. Later data-bearing
migrations must provide their own compatibility procedure.

## 4. Verify and retain rollback

After recovery, run:

```bash
pnpm infra:up
pnpm db:migrate
pnpm infra:status
curl --fail --silent http://127.0.0.1:7700/health
curl --fail --silent http://127.0.0.1:9000/minio/health/ready
```

Verify PostgreSQL extensions and the two private MinIO buckets before application work.
Keep the stopped legacy volumes and tested archives until the recovered stack has been
used successfully. Cleanup is deliberately not automated by Notted; remove legacy
volumes only after a separate, reviewed decision.
