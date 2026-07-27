# Part 09 — Build the Development Compose Stack

## Status

- **State:** Complete
- **Completed on:** 2026-07-27
- **Implemented by:** Initial Part 9 implementation; rewritten during Phase 2 integration
- **Plan reference:** `Plan.md`, Part 9
- **Related records:** `part-08-environment-contracts.md`; `part-10-developer-commands-onboarding.md`; `part-11-configuration-dependency-clients.md`; `docs/decisions/0005-private-object-storage.md`; `docs/decisions/0008-runtime-and-package-compatibility.md`

## Objective

Provide a deterministic, health-checked development Compose stack for PostgreSQL with
pgvector, Redis, Meilisearch, MinIO plus private bucket initialization, and Mailpit while
keeping API and web processes runnable on the host.

## Implemented Work

- Defined five persistent services plus one-shot MinIO permission/init services with four
  named volumes, an internal service network, a separate loopback-publishing bridge,
  health checks, and dependency conditions.
- Pinned PostgreSQL/pgvector, Redis, Meilisearch, and Mailpit by exact tag and
  multi-architecture manifest digest.
- Replaced removed upstream MinIO Community Edition images with a reproducible source build
  for exact server/client commits, independently verified archive checksums, pinned build
  and runtime bases, and explicit build targets.
- Added idempotent creation of private attachment and export buckets. Anonymous access is
  not enabled.
- MinIO runs as fixed UID/GID `10001`; a bounded root-only one-shot permission service
  prepares fresh or existing development volumes before the unprivileged server starts.
- Kept application containers outside this development stack.
- Integrated Compose startup with the Part 10 wrapper, which derives a checkout-specific
  project name and waits up to 180 seconds for healthy services and successful bucket
  initialization.

## Important Decisions

| Component | Exact source |
|---|---|
| PostgreSQL/pgvector | `pgvector/pgvector:0.8.5-pg16@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb` |
| Redis | `redis:7.2.14-alpine@sha256:dfa18828cbc07b3ae6a95ec7343f6c214fdee2d836197b4be8e9904420762cd8` |
| Meilisearch | `getmeili/meilisearch:v1.45.1@sha256:ac40212f9e5a7526d8007586e3e46fb0441d29dd36c7b02fa2341d2c9a1f6493` |
| Mailpit | `axllent/mailpit:v1.30.0@sha256:0059ef81e492a7192af3816281eed6859eb078bd7bdc58b76757c13e10e53a7d` |
| MinIO server | Commit `7aac2a2c5b7c882e68c1ce017d8256be2feea27f`; archive SHA-256 `71794c2df26aad0cc99e8421c58b7aa2dd55969f979b0e7d1e931042e9fabcd6` |
| MinIO client | Commit `77f82e18b5401a65958f1619df6ebb994634bd88`; archive SHA-256 `167415edd21bc29f5360943dac64272aa5cda0a39f3070b15cfeca671c43d975` |
| MinIO build base | `golang:1.24.5-alpine3.22@sha256:daae04ebad0c21149979cd8e9db38f565ecefd8547cf4a591240dc1972cf1399` |
| MinIO runtime base | `alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1` |

- Redis remains on the BSD-licensed 7.2 line required by `Notted.md`.
- Private object storage follows ADR 0005 even though the original specification example
  showed public export policy commands.
- Floating images and the old fixed Compose project identity are not part of the current
  implementation.

## Files and Components

| Path | Purpose |
|---|---|
| `docker/docker-compose.dev.yml` | Development service graph, health checks, ports, volumes, and network. |
| `docker/minio-source/Dockerfile` | Reproducible source build for MinIO server and client. |
| `docker/.env.example` | Infrastructure-owned names and development placeholders. |
| `scripts/dev-tooling.mjs` | Project identity, Compose command construction, and startup health wait. |
| `docs/decisions/0008-runtime-and-package-compatibility.md` | Exact container/source compatibility baseline. |

## Database and Data Changes

- The stack persists PostgreSQL, Redis, Meilisearch, and MinIO in four Compose volumes.
- PostgreSQL uses the Part 12 migration workflow. This Phase 2 checkpoint does not modify
  the committed extension migration or its metadata.
- The renamed volume keys and checkout-derived project name do not automatically attach
  data created by the older fixed `notted-dev` stack.

## API, Configuration, and Operational Changes

- Loopback ports are PostgreSQL `5432`, Redis `6379`, Meilisearch `7700`, MinIO API `9000`,
  MinIO console `9001`, Mailpit SMTP `1025`, and Mailpit web `8025`.
- Normal shutdown preserves volumes.
- Startup waits for PostgreSQL, Redis, Meilisearch, MinIO, and Mailpit health plus successful
  `minio-init`.
- A failed startup leaves the partial stack for inspection.

## Security and Tenant-Isolation Notes

- Published ports bind to `127.0.0.1`, and both MinIO buckets are explicitly set and
  verified private.
- Dependency and one-shot traffic uses the `internal: true` infrastructure network.
  Persistent services also join a development-only bridge so Docker can publish their
  loopback ports to host-run applications.
- Development examples reuse MinIO root credentials and the Meilisearch master key only
  for local onboarding. Production contracts require explicit application credentials.
- The source-built MinIO server and client targets use fixed UID/GID `10001`.
- No tenant data contract is added; later services must enforce workspace scoping.

## Verification Evidence

The previous record's 2026-07-23 runtime results applied to a superseded floating-image
stack and are not evidence for this rewrite. Current evidence from 2026-07-27 is:

| Check | Result | Notes |
|---|---|---|
| `docker compose --env-file docker/.env.example --file docker/docker-compose.dev.yml --project-name notted-audit config` | Pass | Current Compose configuration rendered successfully. |
| Docker daemon access | Unavailable | Runtime inspection/startup was denied by daemon permissions. |
| Source MinIO image build | Not run | No current build result is claimed. |
| Clean `infra:up` and health wait | Not run | Five service health checks and `minio-init` require Docker recovery. |
| PostgreSQL extension/migration verification | Not run | Must be proved against an empty current stack. |
| MinIO bucket existence/privacy | Not run | Current bucket policy has not been verified against a running service. |
| Meilisearch and Mailpit HTTP checks | Not run | Runtime endpoints were unavailable. |
| Shutdown/restart persistence and partial-failure recovery | Not run | Required operational gates remain. |
| `pnpm format:check` | Fail | `docker/docker-compose.dev.yml` and other Phase 2 files require formatting. |

### 2026-07-27 final completion verification

| Check | Result | Notes |
|---|---|---|
| Compose render and MinIO source build | Pass | Current service graph rendered and both checksum/source-pinned targets built. |
| Clean isolated startup | Pass | Five persistent services became healthy; permission/init one-shots exited 0. |
| Networking and ports | Pass | Service traffic used the internal bridge and every published port bound only to alternate `127.0.0.1` ports for host verification. |
| PostgreSQL | Pass | Fresh volume accepted Part 12 migration, preserved a pre-existing probe row, enabled `uuid-ossp`/`vector`, and answered health queries. |
| MinIO | Pass | Server UID was `10001`; both buckets existed and reported private; data survived restart. |
| Redis, Meilisearch, Mailpit | Pass | Health checks and direct/API probes passed. |
| Persistence and recovery | Pass | Each persistent service was stopped/restarted; the unchanged API reported 503 during loss and returned to 200 after recovery. |

## Known Limitations and Follow-up Work

- A detector and `docs/legacy-development-volumes.md` preserve the exact older volume
  names and document inventory, backup, service-native recovery, verification, rollback,
  and deliberately manual cleanup. No legacy volume was deleted.
- Final isolated-stack verification built both MinIO targets, started every service,
  observed all health checks, confirmed both one-shot services exited 0, verified UID
  `10001`, private buckets, Meilisearch/Mailpit responses, PostgreSQL extensions, empty
  migration, persistence, stop/start recovery, and host loopback access.
- Scoped MinIO/Meilisearch application identities and production network policy belong to
  the owning feature/deployment hardening parts; this development stack does not claim
  production least privilege.

## Handoff Notes

- Do not rely on the old `notted-dev` volumes being automatically reused.
- Do not make either MinIO bucket anonymous.
- Do not modify the Part 12 migration/config/schema implementation during Phase 2 recovery;
  protected hashes are recorded in the Part 11 record.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-23 | `lead-part-engineer` | Recorded the initial floating-image Compose implementation and its then-current runtime verification. |
| 2026-07-27 | `/root` | Replaced obsolete image, credential, volume, startup, and verification claims with the current source-built in-progress stack and its unresolved operational gates. |
| 2026-07-27 | `/root` | Added internal/loopback networks, non-root MinIO permission handoff, readiness retry/private policy, legacy recovery guidance, passed isolated runtime/persistence gates, and marked Part 9 complete. |
