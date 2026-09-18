# Deploying Notted to production with Docker

This guide covers a single Linux host running the stack in `compose.prod.yaml`
behind a reverse proxy you already operate on that host. It is the
authoritative procedure for the first deployment and for every subsequent
release.

What you get:

| Service       | Image                                       | Reachable from                     |
| ------------- | ------------------------------------------- | ---------------------------------- |
| `web`         | `docker/Dockerfile.web`                     | host port `NOTTED_WEB_PORT` (3200) |
| `api`         | `docker/Dockerfile.api` (`runtime`)         | host port `NOTTED_API_PORT` (3201) |
| `migrate`     | `docker/Dockerfile.api` (`migrate`)         | one-shot, exits                    |
| `postgres`    | pgvector, patched (`docker/patched-images`) | `backend` network only             |
| `redis`       | `redis` (pinned, password required)         | `backend` network only             |
| `meilisearch` | patched (`docker/patched-images`)           | `backend` network only             |
| `minio`       | built from source (`docker/minio-source`)   | `backend` network only             |
| `minio-init`  | creates the two private buckets, exits      | one-shot, exits                    |

Only two ports are published — **3200** (web) and **3201** (API + WebSocket),
bound to `127.0.0.1` unless `NOTTED_BIND` says otherwise. Everything else is
private to the Compose network. BullMQ workers run inside `api`; there is no
separate worker container.

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

**TLS is your proxy's job and it is not optional.** The API refuses to start
unless `APP_URL`, `API_URL` and `BETTER_AUTH_URL` are `https://`, and the web
bundle is built for `https://`/`wss://` origins, so the browser must reach both
hostnames over HTTPS through the proxy. Plain `http://host:3200` will not work.

---

## 1. First-time deployment

### 1.1 Host requirements

- Linux, x86_64 or arm64 (Raspberry Pi 4/5 works; every base image is a
  multi-arch digest). 4 GB RAM minimum, 8 GB recommended — `api` carries
  Chromium for PDF export.
- 25 GB free on **Docker's data root**, not on the project directory. The
  build compiles MinIO from source (two Go module caches), installs Chromium
  and produces two ~2 GB Node images; the finished stack is about 6 GB.
  Check where that is before building — on a Pi it is usually the SD card:

  ```bash
  docker info -f '{{.DockerRootDir}}' | xargs df -h
  ```

  If it is too small, move it once with `"data-root": "/mnt/data/docker"` in
  `/etc/docker/daemon.json` (stop Docker, `rsync -a` the old directory over,
  start Docker).
- Docker Engine 27+ with the Compose plugin (`docker compose version` ≥ 2.30).
- Host ports 3200 and 3201 free (change `NOTTED_WEB_PORT`/`NOTTED_API_PORT`
  if not). They are loopback-only; nothing to open in the firewall.
- A reverse proxy on the host (nginx, Traefik, Caddy, …) with certificates for
  both hostnames. Requirements are in section 1.7.
- A non-root user in the `docker` group (the commands below assume it).

```bash
docker version && docker compose version
```

### 1.2 DNS

Create **two** records pointing at the host's public IP:

| Record                    | Purpose                              |
| ------------------------- | ------------------------------------ |
| `app.example.com` A/AAAA  | Web app (`APP_DOMAIN`)               |
| `api.example.com` A/AAAA  | API + WebSocket (`API_DOMAIN`)       |

Both are served by your proxy; issue certificates for them the way you do for
your other sites.

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

- `APP_DOMAIN`, `API_DOMAIN` (ports `NOTTED_WEB_PORT`/`NOTTED_API_PORT`
  default to 3200/3201; change them only if taken; `TRUST_PROXY_HOPS` stays
  `1` for a single proxy on the host)
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

Set `NOTTED_IMAGE_TAG` to the commit you are deploying so images are traceable:

```bash
sed -i "s/^NOTTED_IMAGE_TAG=.*/NOTTED_IMAGE_TAG=$(git rev-parse --short HEAD)/" .env.production
```

### 1.5 Build the images

Build as a separate foreground step, before starting anything. The API and web
builds compile the whole workspace and take several minutes on first run.

```bash
docker compose --env-file .env.production -f compose.prod.yaml build
```

That builds all seven images in parallel. On a small host (Raspberry Pi, a
VPS with 4 GB RAM or a tight disk) build in stages instead, so the Go and
Node compilations do not run at the same time, then drop the intermediate
layers before starting:

```bash
docker compose --env-file .env.production -f compose.prod.yaml build postgres meilisearch
```

```bash
docker compose --env-file .env.production -f compose.prod.yaml build minio minio-init
```

```bash
docker compose --env-file .env.production -f compose.prod.yaml build migrate api
```

```bash
docker compose --env-file .env.production -f compose.prod.yaml build web
```

```bash
docker builder prune -af
```

`docker builder prune` removes only BuildKit cache, never images or
containers, so it is safe on a daemon shared with other projects; it just
means the next build starts from scratch.

`web` bakes `https://$APP_DOMAIN`, `https://$API_DOMAIN` and
`wss://$API_DOMAIN` into its bundle at this point.

### 1.6 Start the stack

```bash
docker compose --env-file .env.production -f compose.prod.yaml up -d
```

Compose starts services in dependency order: infrastructure becomes healthy,
`migrate` applies the Drizzle migrations and exits, `minio-init` creates the
buckets and exits, then `api` and `web` start and pass their health checks.

Check the containers before touching the proxy:

```bash
docker compose --env-file .env.production -f compose.prod.yaml ps
```

Expected: every long-running service `Up (healthy)`; `migrate` and
`minio-init` `Exited (0)`.

```bash
curl -fsS http://127.0.0.1:3201/health/ready
```

```bash
curl -fsSI http://127.0.0.1:3200 | head -1
```

### 1.7 Configure the reverse proxy

Two virtual hosts, both HTTPS, forwarding to the loopback ports. What the
proxy must do:

| Requirement                                      | Why                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| `app.example.com` → `127.0.0.1:3200`             | Next.js web app                                                        |
| `api.example.com` → `127.0.0.1:3201`             | API, Better Auth, `/socket.io`                                         |
| WebSocket upgrade on the API host                | Realtime editing and presence use `/socket.io`                         |
| No idle/read timeout on the API host, or ≥ 120 s | Long-lived sockets; the API pings every 30 s                           |
| Body size ≥ 64 MB on the API host                | Attachment uploads (`MAX_UPLOAD_SIZE_BYTES`, 50 MB default)            |
| Pass `X-Forwarded-For` / `X-Forwarded-Proto`     | Rate limits and audit rows key on the client IP (`TRUST_PROXY_HOPS=1`) |
| Do not expose `/metrics` publicly                | `docs/standards/operations.md`                                         |
| HTTP → HTTPS redirect                            | The app only works over HTTPS                                          |

nginx example for the API host (the web host is the same without the body
size and timeout lines):

```nginx
server {
    listen 443 ssl http2;
    server_name api.example.com;
    # ssl_certificate / ssl_certificate_key as for your other sites

    client_max_body_size 64m;

    location = /metrics { return 404; }

    location / {
        proxy_pass http://127.0.0.1:3201;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

If the proxy runs in another container on the same Docker host, either set
`NOTTED_BIND=0.0.0.0` and firewall the ports, or attach the proxy to the
`notted_backend` network and target `web:3000` / `api:3001` directly (then
no ports need publishing at all).

### 1.8 Verify end to end

```bash
curl -fsS https://api.example.com/health/ready
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
docker compose --env-file .env.production -f compose.prod.yaml up -d api
```

### 1.10 Back up from day one

Persistent state lives in four named volumes: `notted_postgres-data`,
`notted_redis-data`, `notted_meilisearch-data`, `notted_minio-data`.
PostgreSQL and MinIO are the data of record; Meilisearch can be rebuilt
(search reindex) and Redis holds sessions and queues only.

Nightly database dump (run from cron on the host):

```bash
docker compose --env-file .env.production -f compose.prod.yaml exec -T postgres \
  pg_dump -U notted -d notted -Fc > /var/backups/notted/db-$(date +%F).dump
```

Object storage copy (MinIO data directory is plain files; stop-free snapshot):

```bash
docker run --rm -v notted_minio-data:/data:ro -v /var/backups/notted:/backup alpine \
  tar czf /backup/minio-$(date +%F).tgz -C /data .
```

Also back up `.env.production` (it holds `DATA_ENCRYPTION_KEYS`; without it
encrypted provider credentials in the database are unrecoverable). Encrypt
backups and copy them off-host.

---

## 2. Recurring deployment (releasing a new version)

Each release is: pull, build, migrate, roll. Compose replaces only the
containers whose image or configuration changed, so infrastructure services
keep running and their data volumes are untouched.

### 2.1 Pull the release

```bash
cd /opt/notted
git fetch --tags
git checkout <new-tag-or-commit>
```

Read the release notes / diff for two things: new environment variables (add
them to `.env.production`) and new migrations under
`apps/api/src/database/migrations/`.

### 2.2 Back up before migrating

Always take a fresh dump before a release that contains a migration:

```bash
docker compose --env-file .env.production -f compose.prod.yaml exec -T postgres \
  pg_dump -U notted -d notted -Fc > /var/backups/notted/pre-deploy-$(date +%F-%H%M).dump
```

### 2.3 Tag and build

```bash
sed -i "s/^NOTTED_IMAGE_TAG=.*/NOTTED_IMAGE_TAG=$(git rev-parse --short HEAD)/" .env.production
```

```bash
docker compose --env-file .env.production -f compose.prod.yaml build api migrate web
```

The old containers keep serving traffic while this runs.

### 2.4 Migrate and roll

```bash
docker compose --env-file .env.production -f compose.prod.yaml up -d
```

This re-runs `migrate` (Drizzle applies only new files), then recreates `api`
and `web` with the new images. The proxy sees a few seconds of `502` while
each container restarts and passes its health check; nothing else changes.

### 2.5 Verify

```bash
docker compose --env-file .env.production -f compose.prod.yaml ps
```

```bash
curl -fsS https://api.example.com/health/ready
```

```bash
docker compose --env-file .env.production -f compose.prod.yaml logs --since 5m api web
```

### 2.6 Clean up old images

Superseded images keep their `notted-*:<sha>` tags, so a plain `prune` (which
only removes untagged images) leaves them behind. Remove every Notted image
that no container uses, and nothing else on the daemon:

```bash
docker image prune -af --filter "label=com.docker.compose.project=notted"
```

Do not run `docker system prune -a` or `docker image prune -a` without the
label filter on a shared daemon; they remove images belonging to other
projects.

---

## 3. Rollback

Images are tagged with the commit, so rolling back the application is a tag
change plus `up`:

```bash
sed -i "s/^NOTTED_IMAGE_TAG=.*/NOTTED_IMAGE_TAG=<previous-short-sha>/" .env.production
git checkout <previous-tag-or-commit>
docker compose --env-file .env.production -f compose.prod.yaml up -d --no-build api web
```

`--no-build` reuses the images tagged with the previous commit; if step 2.6
already pruned them, drop the flag and Compose rebuilds them from the checked
out source.

**Migrations are not rolled back automatically.** Notted migrations are
written to be backward-compatible with the previous release, so the old API
runs against the new schema. If a release notes an irreversible migration,
rolling back means restoring the pre-deploy dump:

```bash
docker compose --env-file .env.production -f compose.prod.yaml stop api
docker compose --env-file .env.production -f compose.prod.yaml exec -T postgres \
  pg_restore -U notted -d notted --clean --if-exists < /var/backups/notted/pre-deploy-<stamp>.dump
docker compose --env-file .env.production -f compose.prod.yaml up -d
```

---

## 4. Day-2 operations

| Task                       | Command                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| Status                     | `docker compose --env-file .env.production -f compose.prod.yaml ps`                      |
| Follow logs                | `docker compose --env-file .env.production -f compose.prod.yaml logs -f api`             |
| Restart one service        | `docker compose --env-file .env.production -f compose.prod.yaml restart api`             |
| Change an env var          | edit `.env.production`, then `... up -d api` (or `web`)                                  |
| Change a domain            | edit `APP_DOMAIN`/`API_DOMAIN`, then `... build web && ... up -d` (rebuild required)     |
| Change a host port         | edit `NOTTED_WEB_PORT`/`NOTTED_API_PORT`, `... up -d`, update the proxy                  |
| Stop everything            | `docker compose --env-file .env.production -f compose.prod.yaml down` (volumes kept)     |
| Reindex search             | `docker compose --env-file .env.production -f compose.prod.yaml run --rm migrate node --import tsx scripts/search-reindex.ts` |
| Metrics                    | set `METRICS_TOKEN`; scrape `http://127.0.0.1:3201/metrics` from the host — never via the proxy (`ops/README.md`) |

Resource limits (`*_MEMORY_LIMIT`, `REDIS_MAXMEMORY`) are variables in
`.env.production`; raise them for larger hosts. Container logs are capped at
10 MB × 5 files per service.

To avoid retyping the flags, export them once per shell:

```bash
export COMPOSE_FILE=compose.prod.yaml COMPOSE_ENV_FILES=.env.production
```

after which plain `docker compose ps`, `docker compose up -d`, etc. work.

---

## 5. Troubleshooting

- **Build fails with `No space left on device`** (in `apt-get`, `pnpm
  install`, or `failed to commit … metadata.db`) — Docker's data root is
  full, not the project disk. `docker builder prune -af`, check
  `docker info -f '{{.DockerRootDir}}' | xargs df -h`, move the data root or
  free space, then rebuild in stages (section 1.5).
- **`api` restarts in a loop** — configuration rejected. `docker compose logs
  api` prints the exact variable (`BETTER_AUTH_SECRET must be…`,
  `production SMTP must require TLS`, …).
- **`api` is `Up (unhealthy)` and never becomes healthy** — a dependency
  probe fails. `curl` the readiness endpoint from inside the container to see
  which: `docker compose ... exec api node -e 'fetch("http://127.0.0.1:3001/health/ready").then(r=>r.text()).then(console.log)'`.
  The usual culprit is `smtp: down` — wrong SMTP host, port or credentials.
- **`migrate` exits non-zero** — the migration failed; `api` will not start.
  Read `docker compose logs migrate`, fix the cause, `up -d` again. Drizzle
  records applied migrations, so it resumes at the failed file.
- **Browser shows the app but sign-in fails / WebSocket disconnects** — the
  web image was built for a different domain than `API_DOMAIN`. Rebuild `web`.
- **Every request is rate-limited or audit rows show the proxy's IP** — the
  proxy is not sending `X-Forwarded-For`, or `TRUST_PROXY_HOPS` does not
  match the number of proxies in front of the API.
- **Realtime editing drops every minute or so** — the proxy is closing idle
  WebSocket connections; raise its read timeout on the API host.
- **`421 Misdirected Request` from the API** — only when
  `CUSTOM_DOMAINS_ENABLED=true`; see `docs/custom-domains.md`.
