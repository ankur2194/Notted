# Part 11 — Implement Configuration and Dependency Clients

## Status

- **State:** Complete
- **Completed on:** 2026-07-27
- **Implemented by:** Phase 2 work-in-progress checkpoint
- **Plan reference:** `Plan.md`, Part 11
- **Related records:** `part-05-nestjs-api-scaffold.md`; `part-08-environment-contracts.md`; `part-09-development-compose-stack.md`; `part-10-developer-commands-onboarding.md`; Part 12 Drizzle implementation

## Objective

Provide narrowly scoped NestJS adapters for PostgreSQL, Redis, MinIO, Meilisearch, and SMTP
with bounded lifecycle behavior and dependency-aware readiness without exposing raw clients
throughout the application.

## Implemented Work

- Added Redis, MinIO, Meilisearch, and SMTP NestJS modules/services with typed
  configuration, startup retry, bounded timeouts, readiness state, and graceful shutdown.
- Added PostgreSQL connection/query/readiness timeouts and a safe pool error listener.
- Redis uses lazy connection, no offline queue, bounded jittered reconnect, and narrow
  get/set/delete/publish methods.
- MinIO keeps its raw client and keep-alive agent private and verifies both required buckets.
- Meilisearch uses one typed native dynamic-import boundary because `meilisearch@0.60.0`
  is ESM-only while the NestJS output is CommonJS.
- SMTP uses a bounded pool with provider logging/debug disabled and narrow send/verify
  behavior.
- Readiness now evaluates API, database, Redis, MinIO, Meilisearch, and SMTP in deterministic
  order. Disabled optional dependencies are ready; enabled failures return HTTP 503 with
  generic messages and duration metadata. Liveness remains dependency-free.
- Added unit/E2E source coverage for retry, timeout, state logging, disabled behavior,
  mocked failure/recovery, shutdown, readiness shape, and error redaction.

## Important Decisions

- Exact client versions are `ioredis@5.11.1`, `minio@8.0.7`,
  `meilisearch@0.60.0`, `nodemailer@9.0.3`, and `@types/nodemailer@8.0.1`.
- Tooling additions are `tsx@4.23.1` for API validation and `@next/env@16.2.11` for web
  environment loading.
- Reviewed targeted overrides are `multer@2.2.0` under Nest and `postcss@8.5.18` plus
  `sharp@0.35.0` under Next. They remove the previously reported production high
  advisories without changing framework major lines.
- Raw dependency tokens are private to their modules; exported services expose narrow
  operations and readiness.
- Dependency failures use redacted structured messages and never log credentials or
  provider responses.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/src/infrastructure/dependency-lifecycle.ts` | Shared timeout/retry/readiness lifecycle helpers. |
| `apps/api/src/infrastructure/redis/` | Narrow Redis adapter and module. |
| `apps/api/src/infrastructure/minio/` | Private-bucket MinIO adapter and module. |
| `apps/api/src/infrastructure/meilisearch/` | ESM-loaded Meilisearch adapter and module. |
| `apps/api/src/infrastructure/smtp/` | Bounded Nodemailer adapter and module. |
| `apps/api/src/infrastructure/infrastructure-clients.test.ts` | Mocked lifecycle and recovery coverage. |
| `apps/api/src/database/database.module.ts` | PostgreSQL pool lifecycle configuration. |
| `apps/api/src/database/database-readiness.indicator.ts` | Database readiness query and timeout mapping. |
| `apps/api/src/health/health.controller.ts` | Dependency-aware liveness/readiness response. |
| `apps/api/src/health/health.module.ts` | Readiness indicator registration and module wiring. |
| `pnpm-lock.yaml` | Exact client and targeted override resolutions. |
| `docs/decisions/0008-runtime-and-package-compatibility.md` | Reviewed package/container compatibility baseline. |

## Database and Data Changes

No schema or migration change is part of this work. Part 11 consumes the existing
PostgreSQL pool and health query only.

Part 12 was explicitly included in the final completion session. Its SQL migration,
snapshot, journal, schema barrel, Drizzle configuration, and database service remained
unchanged; only its live migration test was expanded under Part 12 ownership to prove
pre-existing data preservation. Current hashes and evidence are recorded in the Part 12
completion record.

## API, Configuration, and Operational Changes

- `/health/live` remains a local-process check.
- `/health/ready` now reports dependency entries and becomes HTTP 503 when an enabled
  dependency is unhealthy.
- Configured clients have bounded startup attempts, command/probe timeouts, and shutdown
  behavior.
- Optional disabled providers do not block readiness.

## Security and Tenant-Isolation Notes

- Provider credentials and raw clients stay behind configuration/adapters; logs use generic,
  redacted error metadata.
- MinIO readiness verifies the two private bucket names but does not make either public.
- This infrastructure part adds no tenant operations. Later service layers must still
  authorize and scope every Redis key, object, search index/document, and email action.
- Liveness alone is rate-limit-exempt. Readiness uses the ordinary unauthenticated tier,
  shares concurrent work through single-flight evaluation, and caches the result for one
  second. Driver/request timeouts and referenced timers keep probes and startup retries
  bounded.

## Verification Evidence

Evidence below applies to the current Phase 2 worktree audited on 2026-07-27.

| Check | Result | Notes |
|---|---|---|
| `pnpm type-check` | Pass | Root type-check passed; uncached API package type-check also passed. |
| `pnpm audit --prod --audit-level=high` | Pass | No production high vulnerability; one low and four moderate findings remain. |
| `pnpm audit --audit-level high` | Fail | Six high development/tooling advisories remain. |
| `pnpm format:check` | Fail | `minio.service.ts`, `redis.service.ts`, `docker-compose.dev.yml`, `scripts/dev-tooling.mjs`, and `turbo.json` require formatting. |
| Focused environment/client/health tests | Stalled / interrupted | Workers repeatedly stalled on the mounted filesystem; no passing test result is claimed. |
| API and web package tests | Stalled / interrupted | No conclusive current suite result. |
| Root lint | Stalled / interrupted | No conclusive current result. |
| Docker/live dependency verification | Unavailable | Docker daemon permission was denied. |
| Real dependency loss and recovery | Not run | Mock test source exists, but Part 11 requires realistic service failure/recovery proof. |
| `git diff --check` before staging | Pass | All non-ignored Phase 2 source and documentation changes passed the whitespace-error check. |
| `git diff --cached --check` after staging | Pass | The complete staged checkpoint passed the cached whitespace-error check. |
| Staged inventory | Pass | 66 files were staged: 39 additions and 27 modifications; no non-ignored unstaged or untracked Phase 2 file remained. |
| Ignore/exclusion review | Pass | Local environment files, dependencies, builds, coverage, caches, and test results remained ignored and unstaged. |
| Part 12 hash/status comparison | Pass | Protected files matched `HEAD` and had no staged or unstaged changes after the checkpoint was staged. |

### 2026-07-27 final completion verification

| Check | Result | Notes |
|---|---|---|
| Focused config/client/health tests | Pass | 34 focused tests passed, including retry bounds, timeouts, redaction, single-flight readiness, disabled providers, terminal Redis recovery, and shutdown. |
| API/repository behavior and coverage | Pass with reconciled evidence | The broad repository coverage suite passed during the audit. Changed API unit/E2E paths then passed focused tests; the one stale E2E rate-limit expectation was corrected and its eight-test file passed. |
| Build/runtime smoke | Pass | Built API started with all dependencies up, returned deterministic ready status, and terminated promptly on SIGINT. |
| Live loss/recovery matrix | Pass | PostgreSQL, Redis, MinIO, Meilisearch, and SMTP each produced 503/down during stop and 200/ready after restart. |
| Bucket/privacy and secret safety | Pass | Both MinIO buckets were private; responses/logs exposed no dependency credentials or provider errors. |
| Broad gates | Pass | Frozen install, format, lint, type-check, build, Drizzle consistency, and production audit passed. |

## Known Limitations and Follow-up Work

- Formatting, focused tests, broad tests/coverage, lint, type-check, builds, Drizzle checks,
  production audit, and built-process runtime smoke passed across the completion audit.
- Redis handles both `wait` and terminal `end` reconnection and suppresses reconnect after
  shutdown; focused regression coverage passes.
- Live isolated verification stopped PostgreSQL, Redis, MinIO, Meilisearch, and Mailpit one
  at a time. Each outage produced a redacted 503/down readiness state and each restart
  recovered the unchanged API process to 200/ready.
- Generic timeout races cannot cancel every third-party operation, but request rate
  limiting, single-flight/coalescing, short caching, driver timeouts, and bounded retries
  prevent the previously identified public amplification path. Driver-specific cancellation
  can be added with later observability/performance work if supported.

## Handoff Notes

- Preserve Part 12 migration immutability; correct deployed migrations only with a new
  forward migration as documented in `docs/database-migrations.md`.
- Keep raw clients private and dependency failures redacted.
- A mocked readiness recovery test is useful but does not satisfy the required live
  dependency recovery gate.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-27 | `/root` | Created an honest Phase 2 work-in-progress checkpoint with exact versions, verification limitations, audit findings, and frozen Part 12 hashes. |
| 2026-07-27 | `/root` | Added rate-limited single-flight readiness, referenced bounded timers, terminal Redis recovery, completed all live dependency loss/recovery gates, and marked Part 11 complete. |
