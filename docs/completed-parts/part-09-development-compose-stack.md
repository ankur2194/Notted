# Part 09 — Build the development Compose stack

## Status

- **State:** Complete
- **Completed on:** 2026-07-23
- **Implemented by:** lead-part-engineer
- **Plan reference:** `Plan.md`, Part 9
- **Related records:** ADR 0005 (Private Object Storage)

## Objective

Establish a one-click development infrastructure stack using Docker Compose. This provides the necessary data services (PostgreSQL, Redis, Meilisearch, MinIO, Mailpit) required for the application to run on the host machine during development, ensuring deterministic environments and fast iteration.

## Implemented Work

A complete development infrastructure stack was created. The stack includes:
- **PostgreSQL 16 with pgvector**: Configured for semantic search storage.
- **Redis 7**: Configured for sessions, caching, and BullMQ.
- **Meilisearch v1.11**: Configured for full-text search with a mandatory secure master key.
- **MinIO**: S3-compatible storage with two private buckets.
- **MinIO-init Sidecar**: A one-shot container that creates the required buckets idempotently.
- **Mailpit**: SMTP capture and web UI for development email testing.

Infrastructure is configured with named volumes for persistence, a dedicated bridge network, and loopback-only port bindings (`127.0.0.1`) to prevent accidental public exposure on the host.

## Important Decisions

- **Official pgvector Image**: Used `pgvector/pgvector:pg16` instead of deprecated community images to ensure stability and compatibility with PostgreSQL 16.
- **Private Buckets (ADR 0005)**: Explicitly avoided `mc anonymous set download` or `mc policy set public` as seen in the `Notted.md` production example. Both `notted-attachments` and `notted-exports` are created as **private**, requiring signed URLs for access.
- **Meilisearch Master Key**: Set a dev key of 26 characters to comply with the $\ge 16$ byte requirement of Meilisearch v1.3+.
- **Apps on Host**: The Compose stack contains only infrastructure. Application processes (`apps/api`, `apps/web`) are intended to run on the host for fast reloads and easier debugging.
- **Health-Gated Startup**: Used `service_healthy` conditions for `minio-init` to ensure buckets are created only after the MinIO server is ready.
- **Compose v2 Standard**: Omitted the obsolete `version` key.
- **Symmetric Fail-Fast on MinIO Credentials**: The `minio-init` sidecar uses `${MINIO_ROOT_PASSWORD:?...}` (matching the `minio` server) so a missing/mismatched secret fails loudly instead of silently using a wrong default.
- **Explicit Mailpit Healthcheck**: Added a `CMD-SHELL` healthcheck (tries `wget` then `curl` against `/api/v1/info`) for self-documentation and consistent health reporting alongside the other services.

## Files and Components

| Path | Purpose |
|---|---|
| `docker/docker-compose.dev.yml` | Development infrastructure definition. |
| `docker/.env.example` | Template for infrastructure-scoped environment variables. |
| `docker/init-scripts/init-postgres.sql` | SQL to enable `uuid-ossp` and `vector` extensions. |
| `docker/init-scripts/init-minio.sh` | Helper script for manual/CI bucket creation. |

## Database and Data Changes

- **Extensions**: Added `uuid-ossp` and `vector` via `init-postgres.sql`.
- **Persistence**: Created named volumes `notted_postgres_dev_data`, `notted_redis_dev_data`, `notted_meilisearch_dev_data`, and `notted_minio_dev_data`.

## API, Configuration, and Operational Changes

- **New Ports (127.0.0.1)**:
  - Postgres: 5432
  - Redis: 6379
  - Meilisearch: 7700
  - MinIO API: 9000
  - MinIO Console: 9001
  - Mailpit SMTP: 1025
  - Mailpit Web: 8025
- **Environment Variables**: Added infrastructure defaults in `docker/.env.example`.

## Security and Tenant-Isolation Notes

- **Network Isolation**: All services are on the `notted-dev-network` bridge.
- **Host Binding**: All published ports are bound to `127.0.0.1` to prevent external access.
- **Private Storage**: Confirmed that MinIO buckets are private; anonymous access is disabled.

## Verification Evidence

| Check | Result | Notes |
|---|---|---|
| `docker compose ... up -d` | Pass | All containers started. |
| `docker compose ps` | Pass | All services (postgres, redis, meilisearch, minio, mailpit) are `healthy` (Mailpit via explicit healthcheck). |
| `minio-init` exit code | Pass | Exited with code `0`. |
| `psql \dx` | Pass | `vector` and `uuid-ossp` extensions present. |
| `curl .../health` (Meili) | Pass | Returned `{"status":"available"}`. |
| `curl .../api/v1/info` (Mailpit) | Pass | Returned version info. |
| `mc anonymous get` (MinIO) | Pass | Both buckets reported as `private`. |
| `docker compose config` | Pass | YAML is valid (0 warnings). |
| Meili Key Length | Pass | Key is $\ge 16$ bytes (27 bytes). |
| Independent quality review | Pass | All 14 critical checkpoints PASS (read-only review by `quality-reviewer`); 3 low-severity polish items applied. |
| Repo health (lint/type) | Pass | (Ignored pre-existing `apps/web` lint errors; no new regressions introduced). |

## Known Limitations and Follow-up Work

- **Production Compose**: To be implemented in Part 80.
- **App Dockerfiles**: To be implemented in Part 79.
- **App Config Clients**: NestJS factories for these services are Part 11.
- **Makefile/Onboarding**: Developer commands to wrap these Compose calls are Part 10.

## Handoff Notes

Next parts (10, 11) will rely on this stack. To start: `cp docker/.env.example docker/.env && docker compose --env-file docker/.env -f docker/docker-compose.dev.yml up -d`.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-23 | lead-part-engineer | Initial record |
