# Deploying Notted on ARM64 with images built on a stronger machine

This guide covers a single Linux host running the stack in `compose.prod.yaml`.
The included Caddy gateway routes one public origin to the web and API
containers; an HTTPS terminator (for example Cloudflare Tunnel or a host proxy)
forwards that origin to the gateway's single loopback port. This is an alternative to [DEPLOYMENT.md](DEPLOYMENT.md), copied and adapted
for a Raspberry Pi running a 64-bit OS. Build and publish on a stronger
machine; pull and run on the Pi. The existing Dockerfiles and Compose file
are used as supplied.

**Where commands run:** sections 1.1–1.4 and 1.6 onward run on the Pi unless
marked otherwise. Section 1.5 separates builder commands from Pi commands.
Commands use Bash. Replace example repository, registry and domain values.
The deployment uses a registry (GHCR in the examples), with write access on
the builder and read access on the Pi. Production secrets stay on the Pi.

All eight custom images must be published, including infrastructure and the
migration image. Redis is pulled directly from its pinned upstream reference.
On the Pi, registry images are tagged with the names the existing Compose
file expects; no Compose override file is needed.

What you get:

| Service       | Image                                       | Reachable from                     |
| ------------- | ------------------------------------------- | ---------------------------------- |
| `gateway`     | pinned Caddy image                          | host port `NOTTED_PORT` (3200)     |
| `web`         | `docker/Dockerfile.web`                     | `edge` network only                |
| `api`         | `docker/Dockerfile.api` (`runtime`)         | `edge` + `backend` networks        |
| `migrate`     | `docker/Dockerfile.api` (`migrate`)         | one-shot, exits                    |
| `postgres`    | pgvector, patched (`docker/patched-images`) | `backend` network only             |
| `redis`       | `redis` (pinned, password required)         | `backend` network only             |
| `meilisearch` | patched (`docker/patched-images`)           | `backend` network only             |
| `minio`       | built from source (`docker/minio-source`)   | `backend` network only             |
| `minio-init`  | creates the two private buckets, exits      | one-shot, exits                    |

Only one port is published — **3200** by default — and it is bound to
`127.0.0.1` unless `NOTTED_BIND` says otherwise. Caddy routes known API, auth,
health and WebSocket paths to `api` and everything else to `web`; it blocks
`/metrics` and Bull Board. Everything else is private to Compose networks.
BullMQ workers run inside `api`; there is no separate worker container.

## Tech stack

Versions are pinned in `package.json` files and the Dockerfiles; ADR 0008
(`docs/decisions/`) is the compatibility-tested matrix.

| Layer            | Technology                                                                 |
| ---------------- | -------------------------------------------------------------------------- |
| Runtime          | Node.js 22.23 (`node:22-bookworm-slim`), pnpm 10.34, Turborepo 2.10        |
| Language         | TypeScript 5.9, strict; Zod 4 contracts shared via `packages/*`            |
| Web              | Next.js 16 (App Router) · React 19 · Tailwind CSS 4 · shadcn/ui · TanStack Query 5 · Zustand |
| Editor           | TipTap 2 (ProseMirror) · Yjs 13 for live collaboration                     |
| API              | NestJS 10 · tRPC 11 (first-party) · REST `/api/v1` (OpenAPI)               |
| Auth             | Better Auth 1.6 (email/password, magic link, OAuth, passkeys, 2FA)         |
| Database         | PostgreSQL 16 + pgvector 0.8 · Drizzle ORM 0.45 (migrations via drizzle-kit) |
| Cache / queues   | Redis 7.2 · BullMQ 5 (workers in-process in `api`) · ioredis               |
| Realtime         | Socket.IO 4 (`/socket.io`, WebSocket)                                      |
| Search           | Meilisearch 1.45                                                           |
| Object storage   | MinIO (S3 API, built from source), private buckets                         |
| Email            | Nodemailer 9 over SMTP (TLS required in production)                        |
| Export           | Chromium + puppeteer-core 25 (PDF) · docx 9 · sharp 0.35 (image processing) |
| Observability    | pino 10 structured logs · Prometheus `/metrics` (`ops/`)                   |
| Tests            | Vitest 4 · Playwright 1.62                                                 |
| Containers       | Docker Compose; non-root, read-only rootfs for `api`/`web`, pinned digests |

**TLS is the external terminator's job and it is not optional.** The API refuses to start
unless `APP_URL`, `API_URL` and `BETTER_AUTH_URL` are `https://`, and the web
bundle is built for `https://`/`wss://` origins, so the browser must reach the
single hostname over HTTPS. Plain `http://host:3200` is only an internal gateway
check, not a supported browser entry point.

---

## 1. First-time deployment

### 1.1 Requirements for each machine

**Raspberry Pi (production):**

- A 64-bit Linux installation and ARM64 Docker Engine. Check `uname -m`
  reports `aarch64`, and Docker reports `aarch64` or `arm64`. A 32-bit
  Raspberry Pi OS installation is not suitable for these images.
- Docker Engine 27+ and Compose ≥ 2.30, and a user allowed to run Docker.
- Enough space in Docker's data root for current images, the next release,
  retained rollback images and growing database/object volumes. Start with
  at least 25 GB free and monitor it; this is planning headroom, not a measured
  ARM64 image size. SSD storage is preferable for the database and image I/O.
- 4 GB RAM remains a constrained runtime budget. Building elsewhere removes
  compilation pressure, but the stack still runs PostgreSQL, Redis,
  Meilisearch, MinIO, Next.js, NestJS and occasional Chromium processes.
  Compose's default memory ceilings total about 6 GB; they are not reservations
  or a guarantee that the stack fits. Measure actual usage with `docker stats`
  and host memory/swap usage before increasing workload.
- Host port 3200 free, loopback-only by default, and an HTTPS terminator.
- Registry read access and enough bandwidth to download the image layers.

```bash
uname -m
docker info --format '{{.Architecture}}'
docker info --format '{{.DockerRootDir}}' | xargs df -h
docker version
docker compose version
```

**Stronger machine (builder):**

- Docker with Buildx, registry write access and a clean checkout of the same
  Git commit as the Pi. Use a separate clean checkout to avoid copying local
  build artifacts into images.
- Prefer a native ARM64 machine (for example an ARM server or Apple Silicon
  with Docker Desktop). An x86_64 machine can also target `linux/arm64` through
  emulation, but compilation under QEMU can be substantially slower. Offloading
  keeps the Pi available; it does not guarantee that an emulated build is faster.
- As a practical starting point, allocate 8–16 GB RAM and at least 40 GB free
  Docker storage, allowing more as caches and retained images grow. These are
  planning recommendations, not benchmarked minimum requirements.

Docker explains native builders and emulation in its
[multi-platform build documentation](https://docs.docker.com/build/building/multi-platform/).

### 1.2 DNS

Create one record pointing at the HTTPS terminator:

| Record                   | Purpose                                         |
| ------------------------ | ----------------------------------------------- |
| `app.example.com` A/AAAA | Web, API, authentication and WebSocket traffic  |

Issue a certificate for that hostname through the terminator.

### 1.3 Get the code

```bash
git clone <repository-url> /opt/notted
cd /opt/notted
git checkout <tag-or-commit-to-deploy>
```

### 1.4 Configure

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

Edit `.env.production` and fill every value marked REQUIRED:

- `APP_DOMAIN` (`NOTTED_PORT` defaults to 3200; `TRUST_PROXY_HOPS` defaults to
  `2` for the HTTPS terminator plus the Compose gateway)
- `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `MEILI_MASTER_KEY`,
  `MINIO_ROOT_PASSWORD`, `BETTER_AUTH_SECRET`, `DATA_ENCRYPTION_KEYS`
- SMTP: `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`, `EMAIL_SMTP_USER`,
  `EMAIL_SMTP_PASSWORD`, `EMAIL_FROM`

Generate every auto-generated secret in one go. This fills only keys that
are still empty, so it is safe to re-run after adding a new key to the file
and never rotates a value the running stack depends on:

```bash
for k in POSTGRES_PASSWORD REDIS_PASSWORD MEILI_MASTER_KEY MINIO_ROOT_PASSWORD BETTER_AUTH_SECRET; do grep -q "^$k=.\+" .env.production || sed -i "s|^$k=$|$k=$(openssl rand -hex 32)|" .env.production; done; grep -q "^DATA_ENCRYPTION_KEYS=.\+" .env.production || sed -i "s|^DATA_ENCRYPTION_KEYS=$|DATA_ENCRYPTION_KEYS=1:$(openssl rand -base64 32)|" .env.production; grep -E "^(POSTGRES_PASSWORD|REDIS_PASSWORD|MEILI_MASTER_KEY|MINIO_ROOT_PASSWORD|BETTER_AUTH_SECRET|DATA_ENCRYPTION_KEYS)=" .env.production | sed "s/=.*/=<set>/"
```

Passwords are hex (64 characters) because `POSTGRES_PASSWORD` and
`REDIS_PASSWORD` are embedded in connection URLs, where base64's `/`, `+`
and `=` would break parsing. `DATA_ENCRYPTION_KEYS` must be `1:` followed by
32 base64-encoded bytes. To rotate one value, blank it and re-run — but note
that rotating a database, Redis or MinIO password also requires changing it
inside that service, and rotating `DATA_ENCRYPTION_KEYS` requires appending a
new version rather than replacing (see `apps/api/.env.example`).

The API validates its configuration at startup and refuses to boot with
placeholder or weak values, non-HTTPS URLs, or SMTP without TLS. A wrong value
therefore shows up as `api` crash-looping in step 1.6, with the reason in
`docker compose logs api`.

Set a release tag on the Pi. Use the full commit plus a build revision; use
`r2`, `r3`, etc. if rebuilding the same commit for changed public URLs or
security package updates. Never overwrite a published release tag.

```bash
export NOTTED_RELEASE="$(git rev-parse HEAD)-r1"
sed -i "s/^NOTTED_IMAGE_TAG=.*/NOTTED_IMAGE_TAG=${NOTTED_RELEASE}/" .env.production
```

Use this exact release tag and Git commit on both machines. The public domain
is also part of the web build; one image cannot be reused for a different
domain without rebuilding it.

### 1.5 Build elsewhere, then pull on the Pi

#### A. Stronger machine: prepare the source and registry

Clone into a clean build directory and check out the same commit as the Pi:

```bash
git clone <repository-url> notted-arm64-build
cd notted-arm64-build
git checkout <tag-or-commit-to-deploy>
git status --short
```

The checkout should be clean. Set the following non-secret values. Use your
own lowercase registry namespace and the exact `APP_DOMAIN` configured on the
Pi; omit schemes and slashes from `APP_DOMAIN`.

```bash
export NOTTED_REGISTRY=ghcr.io
export NOTTED_IMAGE_PREFIX=ghcr.io/your-user-or-org/notted
export NOTTED_RELEASE="$(git rev-parse HEAD)-r1"
export APP_DOMAIN=app.example.com
docker login "$NOTTED_REGISTRY"
docker buildx version
```

`docker login` prompts for credentials; use credentials with package write
permission and keep registry packages private if required. The builder needs
no `.env.production`, database password, SMTP credential or encryption key.
The examples publish repositories such as
`ghcr.io/your-user-or-org/notted-api:<release>`.

#### B. Stronger machine: prepare an ARM64-capable builder

Create this named builder once:

```bash
docker buildx create --name notted-arm64-builder --driver docker-container
docker buildx inspect notted-arm64-builder --bootstrap
```

On subsequent releases, reuse it and run only the `inspect` command. Verify
its `Platforms` list contains `linux/arm64`. Docker Desktop supports emulation;
if an x86 Linux builder cannot execute ARM64 steps, follow Docker's
[QEMU setup instructions](https://docs.docker.com/build/building/multi-platform/#install-qemu-manually).
Installing binfmt handlers changes the builder host and requires privileged
access; it is unnecessary on a working native ARM64 builder.

All commands below explicitly select this builder and `linux/arm64`. The
existing Dockerfiles compile inside ARM64 stages, including MinIO and `gosu`;
on an x86 builder these stages execute through emulation.

#### C. Stronger machine: build and push all eight images

Run this complete block in Bash from the repository root. The subshell stops
on the first failure. Builds run sequentially and reuse the same builder cache.
`--push` publishes directly to the registry; it does not load the images into
the builder machine's ordinary local image store.

```bash
(
  set -euo pipefail
  : "${NOTTED_IMAGE_PREFIX:?Set the registry image prefix}"
  : "${NOTTED_RELEASE:?Set the release tag}"
  : "${APP_DOMAIN:?Set the production domain}"

  build_arm64() {
    local image_name="$1"
    shift
    docker buildx build --builder notted-arm64-builder \
      --platform linux/arm64 --pull --progress plain --push \
      --tag "${NOTTED_IMAGE_PREFIX}-${image_name}:${NOTTED_RELEASE}" "$@"
  }

  build_arm64 postgres --file docker/patched-images/Dockerfile \
    --target postgres docker/patched-images
  build_arm64 meilisearch --file docker/patched-images/Dockerfile \
    --target meilisearch docker/patched-images
  build_arm64 minio-server --file docker/minio-source/Dockerfile \
    --target minio-server docker/minio-source
  build_arm64 minio-client --file docker/minio-source/Dockerfile \
    --target minio-client docker/minio-source
  build_arm64 gateway --file docker/Dockerfile.gateway .
  build_arm64 api-migrate --file docker/Dockerfile.api --target migrate .
  build_arm64 api --file docker/Dockerfile.api --target runtime .
  build_arm64 web --file docker/Dockerfile.web \
    --build-arg "NEXT_PUBLIC_APP_URL=https://${APP_DOMAIN}" \
    --build-arg "NEXT_PUBLIC_API_URL=https://${APP_DOMAIN}" \
    --build-arg "NEXT_PUBLIC_WS_URL=wss://${APP_DOMAIN}" .
)
```

Continue only after all eight pushes succeed. Do not deploy a partially
published release. Keep the build cache between releases; do not routinely
run `docker builder prune -af` or remove this builder. Cached layers avoid
repeating unchanged compilation and downloads. `--pull` checks the pinned
base references; it does not force cached `apt`/`apk` steps to refresh. A
security rebuild may require targeted cache invalidation and a new release
tag. See Docker's [build cache guidance](https://docs.docker.com/build/cache/optimize/).

#### D. Pi: pull and map images to the existing Compose names

Run from `/opt/notted`. Set the same prefix and release as on the builder.
`NOTTED_IMAGE_TAG` in `.env.production` must match `NOTTED_RELEASE`; the shell
export below ensures Compose also uses that value for this session.

```bash
export NOTTED_REGISTRY=ghcr.io
export NOTTED_IMAGE_PREFIX=ghcr.io/your-user-or-org/notted
export NOTTED_RELEASE="$(git rev-parse HEAD)-r1"
export NOTTED_IMAGE_TAG="$NOTTED_RELEASE"
sed -i "s/^NOTTED_IMAGE_TAG=.*/NOTTED_IMAGE_TAG=${NOTTED_RELEASE}/" .env.production
docker login "$NOTTED_REGISTRY"
```

For a private registry use credentials with package read permission. Pull
all eight images and check their architecture before updating any local tags:

```bash
(
  set -euo pipefail
  : "${NOTTED_IMAGE_PREFIX:?Set the registry image prefix}"
  : "${NOTTED_RELEASE:?Set the release tag}"

  for image_name in postgres meilisearch minio-server minio-client gateway api-migrate api web; do
    image_ref="${NOTTED_IMAGE_PREFIX}-${image_name}:${NOTTED_RELEASE}"
    docker pull --platform linux/arm64 "$image_ref"
    test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image_ref")" = linux/arm64
  done

  for image_name in postgres meilisearch minio-server minio-client; do
    docker tag "${NOTTED_IMAGE_PREFIX}-${image_name}:${NOTTED_RELEASE}" "notted-${image_name}:local"
  done
  for image_name in gateway api-migrate api web; do
    docker tag "${NOTTED_IMAGE_PREFIX}-${image_name}:${NOTTED_RELEASE}" "notted-${image_name}:${NOTTED_RELEASE}"
  done

  docker compose --env-file .env.production -f compose.prod.yaml pull redis
)
```

Stop if this block fails; do not start or roll the stack until it succeeds.
Tags are local references to the downloaded images and do not copy their
layers. The mapping is required because Compose currently names custom
images `notted-*`, with fixed `:local` tags for infrastructure. Keep the
registry release tags as the traceable source of those infrastructure images.

The Pi performs no image builds. It only downloads layers, tags images and
runs the stack. Download and extraction time still depends on network and
storage speed.

### 1.6 Start the stack

```bash
docker compose --env-file .env.production -f compose.prod.yaml up -d --no-build --pull never
```

Compose starts services in dependency order: infrastructure becomes healthy,
`migrate` applies the Drizzle migrations and exits, `minio-init` creates the
buckets and exits, then `api` and `web` become healthy before `gateway` starts.

Check the containers before touching the proxy:

```bash
docker compose --env-file .env.production -f compose.prod.yaml ps -a
```

Expected: every long-running service `Up (healthy)`; `migrate` and
`minio-init` `Exited (0)`.

```bash
curl -fsS http://127.0.0.1:3200/health/ready
```

```bash
curl -fsSI http://127.0.0.1:3200 | head -1
```

### 1.7 Configure HTTPS forwarding

Configure one HTTPS hostname to forward all traffic to
`http://127.0.0.1:3200`. The external terminator does not need path rules:
`docker/Caddyfile.prod` owns them and preserves the host-only session cookie by
serving web, API and WebSockets from one browser origin.

| Requirement                                         | Why                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| `app.example.com` → `127.0.0.1:3200`                | One origin for web, API, auth and WebSockets                           |
| WebSocket forwarding enabled                       | Realtime editing and presence use `/socket.io`                         |
| No idle/read timeout, or at least 120 seconds       | Long-lived sockets; the API pings every 30 seconds                     |
| Body size at least 64 MB                            | Attachment uploads (`MAX_UPLOAD_SIZE_BYTES`, 50 MB default)            |
| Preserve client IP and original HTTPS information  | Rate limits, secure cookies and audit rows depend on forwarding headers |
| HTTP redirected to HTTPS                           | The application only supports HTTPS in production                      |

For Cloudflare Tunnel, one ingress rule is sufficient:

```yaml
ingress:
  - hostname: app.example.com
    service: http://127.0.0.1:3200
  - service: http_status:404
```

The gateway is deliberately loopback-only. If the HTTPS terminator is on a
different machine, set `NOTTED_BIND` to a private interface address and restrict
that port to the terminator with the host firewall. Never expose it generally.

This primary-host setup does not itself issue certificates for arbitrary tenant
domains. Keep `CUSTOM_DOMAINS_ENABLED=false` unless the external terminator is
also configured for the verified-host certificate flow in
`docs/custom-domains.md`; path routing alone is not enough.

### 1.8 Verify end to end

```bash
curl -fsS https://app.example.com/health/ready
```

```bash
curl -fsSI https://app.example.com | head -1
```

Then open `https://app.example.com` in a browser, register the first account,
and confirm the verification email arrives.

### 1.9 Lock down after the first admin exists (optional)

To close public sign-up, add `FEATURE_REGISTRATION_ENABLED=false` to
`.env.production` and restart the API:

```bash
docker compose --env-file .env.production -f compose.prod.yaml up -d --no-build --pull never api
```

### 1.10 Back up from day one

Persistent state lives in four named volumes: `notted_postgres-data`,
`notted_redis-data`, `notted_meilisearch-data`, `notted_minio-data`.
PostgreSQL and MinIO are the data of record; Meilisearch can be rebuilt
(search reindex) and Redis holds sessions and queues only.

Create `/var/backups/notted` with restricted access for the backup operator.
Nightly database dump (run from cron on the host; adapt the user/database names
if you changed their defaults):

```bash
docker compose --env-file .env.production -f compose.prod.yaml exec -T postgres \
  pg_dump -U notted -d notted -Fc > /var/backups/notted/db-$(date +%F).dump
```

Object storage archive during a maintenance window: pause all application
writes and uploads, then stop API and MinIO before archiving. A tar of a live
MinIO volume is not a guaranteed consistent backup. Coordinate this archive
with the database dump at the same quiet point; the independent nightly dump
above alone is not a coordinated recovery point.

```bash
docker compose --env-file .env.production -f compose.prod.yaml stop api minio
```

Archive the stopped volume:

```bash
docker run --rm -v notted_minio-data:/data:ro -v /var/backups/notted:/backup alpine \
  tar czf /backup/minio-$(date +%F).tgz -C /data .
```

Restart and verify health after the coordinated backup:

```bash
docker compose --env-file .env.production -f compose.prod.yaml up -d --no-build --pull never
```

Also back up `.env.production` (it holds `DATA_ENCRYPTION_KEYS`; without it
encrypted provider credentials in the database are unrecoverable). Encrypt
backups and copy them off-host.

---

## 2. Recurring deployment (releasing a new version)

Each release is: build and publish on the stronger machine, pull on the Pi,
back up, migrate and roll. Build from the same Git commit checked out on the
Pi, using a fresh release tag and the correct public domain. Compose preserves
the named data volumes; changed infrastructure images may restart their
services, so review release compatibility before rolling them.

### 2.1 Pull the release

```bash
cd /opt/notted
git fetch --tags
git checkout <new-tag-or-commit>
```

Read the release notes / diff for two things: new environment variables (add
them to `.env.production`) and new migrations under
`apps/api/src/database/migrations/`.

For the first release that introduces the single-origin gateway, existing
deployments must also:

1. Set `NOTTED_PORT=3200` (or the chosen one published port).
2. Change `TRUST_PROXY_HOPS=1` to `TRUST_PROXY_HOPS=2`; add another hop for each
   trusted CDN/load balancer in front of the HTTPS terminator.
3. Keep the old `API_DOMAIN` value temporarily; the gateway uses it only to
   drain already-loaded clients after startup.
4. Rebuild `web`; its API and WebSocket origins are build-time values. Do not
   remove or reroute the old API hostname before the build and rollout finish.

After cutover, confirm audit/rate-limit client addresses are real client IPs,
not the terminator or gateway address.

### 2.2 Back up before migrating

Always take a fresh dump before a release that contains a migration:

```bash
docker compose --env-file .env.production -f compose.prod.yaml exec -T postgres \
  pg_dump -U notted -d notted -Fc > /var/backups/notted/pre-deploy-$(date +%F-%H%M).dump
```

### 2.3 Publish on the builder and pull on the Pi

On the builder, check out the release commit and repeat section 1.5 A–C,
reusing `notted-arm64-builder`. On the Pi, repeat section 1.5 D with the same
release tag. Do not run `docker compose build` on the Pi.

Before replacing the current release, record its Git commit, image tag and
public domain in your deployment records, and retain its registry images.
The running containers keep serving during image pulls and local retagging.
Take the section 2.2 backup immediately before the next step if the build or
transfer has taken significant time.

### 2.4 Migrate and roll

```bash
docker compose --env-file .env.production -f compose.prod.yaml up -d --no-build --pull never
```

This re-runs `migrate` (Drizzle applies only new files), then recreates `api`
and `web` with the new images. The gateway waits for both health checks; the
external terminator may see a brief `502` while the gateway is replaced.

On the first gateway rollout, wait until `gateway` is healthy, then point the
HTTPS terminator's **old API hostname** at the same gateway port 3200. Caddy
recognizes the retained `API_DOMAIN`, rewrites only that trusted legacy host for
Nest, and lets already-loaded clients keep using their API-host session cookie.
Newly built clients use `APP_DOMAIN` for every request. After a suitable drain
window, remove the old API route and `API_DOMAIN`; users who never established a
new application-host session will need to sign in once on the new origin.

### 2.5 Verify

```bash
docker compose --env-file .env.production -f compose.prod.yaml ps -a
```

```bash
curl -fsS https://app.example.com/health/ready
```

```bash
docker compose --env-file .env.production -f compose.prod.yaml logs --since 5m gateway api web
```

### 2.6 Retain rollback images and manage disk space

Keep the current and previous known-good releases in the registry and, when
space permits, on the Pi. Inspect disk use with `docker system df`. Remove
only explicitly selected obsolete image references after the rollback window;
avoid broad prune commands on a shared daemon. Preserve the builder's cache.

---

## 3. Rollback

This procedure rolls back API, web and gateway images to a previous release
using the same Compose layout. It keeps the current database and infrastructure
running. Confirm the previous application supports the current schema and
infrastructure versions before proceeding.

On the Pi, check out the previous matching Git revision, set its exact image
tag, and restore any relevant environment values. Use the public domain for
which that release's web image was built:

```bash
git checkout <previous-tag-or-commit>
export NOTTED_RELEASE=<previous-full-sha-and-build-revision>
export NOTTED_IMAGE_TAG="$NOTTED_RELEASE"
sed -i "s/^NOTTED_IMAGE_TAG=.*/NOTTED_IMAGE_TAG=${NOTTED_RELEASE}/" .env.production
```

Pull and tag only the three application images. `NOTTED_IMAGE_PREFIX` must
still identify the registry namespace used to publish that release:

```bash
(
  set -euo pipefail
  : "${NOTTED_IMAGE_PREFIX:?Set the registry image prefix}"
  : "${NOTTED_RELEASE:?Set the previous release tag}"
  for image_name in api web gateway; do
    image_ref="${NOTTED_IMAGE_PREFIX}-${image_name}:${NOTTED_RELEASE}"
    docker pull --platform linux/arm64 "$image_ref"
    test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image_ref")" = linux/arm64
  done
  for image_name in api web gateway; do
    docker tag "${NOTTED_IMAGE_PREFIX}-${image_name}:${NOTTED_RELEASE}" "notted-${image_name}:${NOTTED_RELEASE}"
  done
  docker compose --env-file .env.production -f compose.prod.yaml \
    up -d --no-build --pull never --no-deps api web gateway
)
```

`--no-deps` prevents this application rollback from starting the old migration
service or changing infrastructure. Because it also skips dependency startup,
verify health and browser behavior as in section 2.5. If the registry is
unreachable, cached matching local tags can be used with the final command;
never rebuild on the Pi as a fallback.

**Migrations are not rolled back automatically.** If the old API cannot use
the current schema, stop application writes and use the tested database and
object-storage restore procedure with the matching pre-deploy backups.
Infrastructure downgrades and releases from before the gateway existed require
a separate compatibility/restore plan; the three-image rollback above does
not cover those changes.

---

## 4. Day-2 operations

| Task                       | Command                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| Status                     | `docker compose --env-file .env.production -f compose.prod.yaml ps`                      |
| Follow logs                | `docker compose --env-file .env.production -f compose.prod.yaml logs -f api`             |
| Restart one service        | `docker compose --env-file .env.production -f compose.prod.yaml restart api`             |
| Change an env var          | edit `.env.production`, then `... up -d --no-build --pull never api` (or `web`)                                  |
| Change the domain          | build and publish a new release for the new domain on the builder; update `APP_DOMAIN`, pull/tag on the Pi, then roll                  |
| Change the gateway port    | edit `NOTTED_PORT`, run `... up -d --no-build --pull never gateway`, update the HTTPS terminator                 |
| Stop everything            | `docker compose --env-file .env.production -f compose.prod.yaml down` (volumes kept)     |
| Reindex search             | `docker compose --env-file .env.production -f compose.prod.yaml run --rm --no-deps --pull never migrate node --import tsx scripts/search-reindex.ts` |
| Metrics                    | set `METRICS_TOKEN`; attach the scraper to `notted_backend` and target `http://app.example.com:3001/metrics` (replace with `APP_DOMAIN`) — the trusted internal alias avoids `421`, while the gateway returns 404 |

Resource limits (`*_MEMORY_LIMIT`, `REDIS_MAXMEMORY`) are variables in
`.env.production`; raise them for larger hosts. Container logs are capped at
10 MB × 5 files per service.

To avoid retyping the flags, export them once per shell:

```bash
export COMPOSE_FILE=compose.prod.yaml COMPOSE_ENV_FILES=.env.production
```

after which commands such as `docker compose ps -a` and
`docker compose up -d --no-build --pull never` work. Always keep both flags on
Pi startup/rollout commands; they prevent local builds and registry lookups
for Compose's local image names. Before running operator commands using
`migrate`, ensure its local tag matches the deployed application release.

---

## 5. Troubleshooting

- **`exec format error` / missing ARM64 platform** — check that the Pi runs
  a 64-bit OS, the builder supports `linux/arm64`, and the image inspection in
  section 1.5 D succeeds. On x86 builders, check emulation setup; prefer a
  native ARM64 builder if compilation is slow or emulation fails.
- **Registry says `denied`, `unauthorized` or `manifest unknown`** — check
  login, package visibility, prefix and exact release tag. All eight images
  must have been pushed successfully before deployment.
- **Compose reports a missing `notted-*` image** — repeat the pull/tag step
  and check `NOTTED_IMAGE_TAG` agrees in the shell and `.env.production`.
  Do not remove `--no-build` or `--pull never` to work around it.
- **Builds remain slow on an x86 machine** — the existing Dockerfiles run
  ARM64 compilation under emulation. Use a stronger native ARM64 builder and
  preserve its cache; moving to x86 alone does not ensure faster compilation.
- **`No space left on device`** — check Docker's data root on the machine
  reporting the error with `docker info -f '{{.DockerRootDir}}' | xargs df -h`.
  Retain rollback releases and remove only known obsolete artifacts, or expand
  storage. A Pi pulling images needs extraction space as well as download space.
- **Pi is slow or containers are killed after deployment** — check
  `docker stats`, `free -h` and host OOM logs. Offloading builds does not reduce
  runtime memory requirements. Review PDF/indexing load and memory settings;
  raising a container limit does not create physical RAM.
- **`api` restarts in a loop** — configuration rejected. `docker compose logs
  api` prints the exact variable (`BETTER_AUTH_SECRET must be…`,
  `production SMTP must require TLS`, …).
- **`api` is `Up (unhealthy)` and never becomes healthy** — a dependency
  probe fails. `curl` the readiness endpoint from inside the container to see
  which: `docker compose ... exec api node -e 'fetch("http://127.0.0.1:3001/health/ready").then(r=>r.text()).then(console.log)'`.
  The usual culprit is `smtp: down` — wrong SMTP host, port or credentials.
- **`migrate` exits non-zero** — the migration failed; `api` will not start.
  Read `docker compose logs migrate`, fix the cause, then run
  `up -d --no-build --pull never` again. Drizzle
  records applied migrations, so it resumes at the failed file.
- **Browser shows the app but sign-in fails / WebSocket disconnects** — the
  web image was built for a different `APP_DOMAIN`, or the HTTPS terminator is
  bypassing the Compose gateway. Rebuild and publish on the stronger machine
  with a new release tag, pull/tag on the Pi and confirm all paths use port 3200.
- **`gateway` is unhealthy** — inspect `docker compose logs gateway`, then
  verify both `api` and `web` are healthy. The gateway probe proves its API
  route and API liveness; `web` has its own container health check.
- **Every request is rate-limited or audit rows show the proxy's IP** — the
  proxy is not sending `X-Forwarded-For`, or `TRUST_PROXY_HOPS` does not
  match the number of proxies in front of the API.
- **Realtime editing drops every minute or so** — the proxy is closing idle
  WebSocket connections; raise its read timeout on the API host.
- **`421 Misdirected Request` from the API** — only when
  `CUSTOM_DOMAINS_ENABLED=true`; see `docs/custom-domains.md`.
