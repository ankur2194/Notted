# Part 21 — Integrate Better Auth on the backend

## Status

- **State:** Complete
- **Completed on:** 2026-07-31
- **Implemented by:** Phase 4 Part 21 implementation agent
- **Plan reference:** `Plan.md`, Part 21
- **Related records:** Parts 13, 18, 19, and 20; Part 50; ADRs 0003, 0006-0010

Implementation and required verification are complete. Historical statements below describing
checks as not run reflect the initial implementation-only session and are superseded by the
completion update near the end of this record.

> **Correction (2026-08-14):** Part 50 generalized this part's narrow auth-email queue, as
> this record's Objective anticipated. The standalone BullMQ queue service, outbox
> dispatcher, and per-queue configuration named below no longer exist:
> `apps/api/src/auth/auth-email-queue.service.ts`,
> `apps/api/src/auth/auth-email-dispatcher.service.ts`, and
> `apps/api/src/config/auth-email-queue.config.ts` were removed. Auth email now runs on the
> shared queue runtime: `AuthEmailQueueHandler` in `apps/api/src/auth/auth-email-worker.service.ts`
> registers `AUTH_EMAIL_JOB_DEFINITION` with `QueueHandlerRegistry`, and `OutboxDispatcherService`
> plus `QueueWorkerProcessorService` own dispatch and execution for every queue. The
> `AUTH_EMAIL_*` tuning variables were replaced by the shared `QUEUE_*` values in
> `apps/api/src/config/queue.config.ts`. Encrypted intent storage, the `auth_email_intents`
> schema, payload shape, and every security property below are unchanged. See
> [`part-50-establish-bullmq-queues-workers.md`](part-50-establish-bullmq-queues-workers.md).

## Objective

Integrate Better Auth 1.6.24 as Notted's sole credential/session authority with the
existing plural PostgreSQL identity schema, Redis-accelerated opaque cookie sessions,
email/password and magic-link authentication, secure generic recovery, reusable NestJS
session principal/guard infrastructure, and a narrow durable encrypted authentication
email queue that Parts 50/61 can later generalize.

## Implemented Work

- Added canonical `apps/api/src/auth/` module, setup, controller, service, guard, trusted
  principal attachment, raw handler rate limiting, and unversioned Better Auth mount.
- Mounted the Drizzle adapter against the aggregate schema with `user.modelName="users"`,
  database-generated IDs, PostgreSQL transactions, and no JWT/bearer/local/OAuth strategy.
- Configured password login/registration, verification/resend, hashed-at-rest magic links,
  opaque cookie sessions, generic recovery responses, provider origin/CSRF checks, and
  password strength at shared and Better Auth request boundaries.
- Disabled Better Auth 1.6.24's plaintext-identifier reset endpoints. Added a small Better
  Auth plugin using HMAC token lookup plus Better Auth's own internal adapter/password
  hasher for forgotten/reset-password behavior and session revocation.
- Added a dedicated Redis secondary-storage adapter with seconds-to-milliseconds
  conversion, atomic GETDEL, and atomic fixed-window increment. PostgreSQL session
  persistence is enabled; Redis outage/loss fails closed as documented in ADR 0010.
- Added minimal safe `AuthenticatedPrincipal` and `GET /api/v1/auth/session`. A session
  never establishes workspace membership or tenant access. Trusted server lookup installs
  the existing rate-limit principal before the global guard.
- Added `auth_email_intents` with AES-256-GCM context, explicit key version, nonce/tag,
  AAD-bound expiry/purpose/ID, and one-time/terminal lifecycle. Token URLs and rendered
  bodies have no plaintext columns.
- Added transactional email delivery + encrypted context + identifier-only outbox
  production, periodic post-commit dispatcher, identifier-only BullMQ jobs, idempotent
  worker claims/results, bounded retries, in-memory rendering, existing SMTP delivery,
  expiration, duplicate prevention/reconciliation state, safe logs, and graceful shutdown.
- Added typed auth token TTL and queue configuration, constrained unsupported
  `SESSION_SHORT_LIVED_HOURS` values to exactly 24, updated safe development examples, and
  documented Mailpit and operational boundaries.
- Authored focused validator, config, Redis, encryption, producer, logging, schema, and
  gated Mailpit E2E coverage. These files have not been executed.

## Important Decisions

- ADR 0010 is Accepted. Better Auth opaque cookies are the only end-user session mechanism.
- Better Auth 1.6.24 reads configured secondary storage authoritatively. Redis loss cannot
  be silently hidden with a custom database fallback; it denies session validation and can
  require login again, although PostgreSQL retains durable rows.
- Non-remembered duration is fixed at 24 hours by Better Auth. The configurable remembered
  duration sets `session.expiresIn`; Part 23 owns exposing the choice and session controls.
- SMTP has no cross-provider exactly-once primitive. A worker crash after provider
  acceptance leaves `processing` for operator reconciliation rather than automatically
  risking duplicate credential mail. Definitive failures retry up to the configured cap.
- Password-reset token lookup uses HMAC-SHA256 and atomic verification consumption. This
  bounded Better Auth plugin avoids plaintext reset tokens without becoming another
  credential authority.
- Email-disabled mode leaves the queue/readiness indicator disabled and disables all
  email-dependent auth routes. Enabling self-service registration while email is disabled
  fails startup clearly.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/src/auth/` | Better Auth integration, principal/guard, encrypted email producer/dispatcher/queue/worker, Redis secondary storage, and focused tests. Part 50 removed the standalone dispatcher and queue services here; the producer and worker remain |
| `apps/api/src/app.module.ts` | Imports the canonical auth module |
| `apps/api/src/main.ts` | Mounts raw Better Auth handler before parsers and reconciles CORS/origins/principal ordering |
| `apps/api/src/config/auth.config.ts` | Auth URL/origin/secret and link TTL contract |
| `apps/api/src/config/auth-email-queue.config.ts` | Bounded queue/dispatcher/retry configuration. **Removed by Part 50**; superseded by `apps/api/src/config/queue.config.ts` |
| `apps/api/src/config/config.module.ts` | Exported auth-email queue configuration. **Removed by Part 50**; the module no longer registers an auth-email provider |
| `apps/api/src/config/retention.config.ts` | Constrains non-remembered sessions to Better Auth's supported 24 hours |
| `apps/api/src/database/schema/auth-email-intents.ts` | Encrypted one-time auth-email context schema |
| `apps/api/src/database/schema/index.ts` | Exports and aggregates Part 21 schema |
| `apps/api/src/database/migrations/0008_sour_queen_noir.sql` | Generated forward migration for auth-email enums/table |
| `apps/api/src/database/migrations/meta/0008_snapshot.json` | Generated Drizzle schema snapshot |
| `apps/api/src/database/migrations/meta/_journal.json` | Generated migration journal entry |
| `apps/api/src/infrastructure/redis/` | Exposes existing Redis client and adds atomic operations used by the dedicated adapter |
| `apps/api/src/common/logging/structured-logger.service.ts` | Extends credential/identity URL redaction |
| `apps/api/test/auth-email-schema.test.ts` | Schema security contract coverage |
| `apps/api/test/auth.e2e.test.ts` | Gated PostgreSQL/Redis/Mailpit auth journey and persistence coverage |
| `packages/shared-validators/src/auth.schema.ts` | Shared credential, verification, magic-link, forgot/reset Zod contracts |
| `packages/shared-validators/src/auth.schema.test.ts` | Password and credential contract coverage |
| `packages/shared-types/src/auth.ts` | Secret-free principal and generic auth-email response contracts |
| `apps/api/package.json`, `pnpm-lock.yaml` | Adds exact BullMQ 5.80.10 and direct Zod 4.4.3 dependencies |
| `apps/api/.env.example`, `README.md`, `docs/README.md`, `docs/environment.md`, `docs/tenant-and-retention.md` | Local flow, typed values, Mailpit, Redis failure, and session limits |
| `docs/decisions/0010-auth-session-cache-and-email-intent.md` | Accepted session-cache/encrypted-email architecture record |

## Database and Data Changes

Generated forward migration `0008_sour_queen_noir.sql` adds
`auth_email_purpose`, `auth_email_intent_status`, and `auth_email_intents` with one FK to
`email_deliveries`, a unique delivery ID, and lifecycle lookup index. It has no backfill and
does not edit migrations 0000-0007. Schema generation reported 34 tables and created
`0008_sour_queen_noir.sql` plus snapshot/journal artifacts.

The migration has not been reviewed or executed by this agent per instruction. The quality
reviewer must inspect generated SQL, apply empty and upgrade paths, confirm locks are
limited to additive enum/table/index/FK creation, and verify rollback/rollout analysis.
Seed fixtures are unchanged and remain non-authenticating relational identities.

## API, Configuration, and Operational Changes

- Unversioned Better Auth base: `BETTER_AUTH_BASE_PATH` (development `/api/auth`).
- Safe versioned projection: `GET /api/v1/auth/session`.
- Custom hashed-reset paths: `/api/auth/notted/request-password-reset` and
  `/api/auth/notted/reset-password`; conflicting core reset paths are disabled.
- New values: `AUTH_VERIFICATION_TOKEN_TTL_SECONDS`,
  `AUTH_MAGIC_LINK_TOKEN_TTL_SECONDS`, and `AUTH_PASSWORD_RESET_TOKEN_TTL_SECONDS`.
- Retired by Part 50: `AUTH_EMAIL_DISPATCH_INTERVAL_MS`, `AUTH_EMAIL_QUEUE_CONCURRENCY`,
  `AUTH_EMAIL_QUEUE_ATTEMPTS`, `AUTH_EMAIL_QUEUE_BACKOFF_MS`, and
  `AUTH_EMAIL_IDEMPOTENCY_RETENTION_DAYS`. These are no longer read anywhere; the shared
  `QUEUE_DISPATCH_INTERVAL_MS`, `QUEUE_DEFAULT_CONCURRENCY`, `QUEUE_ATTEMPTS`, and
  `QUEUE_BACKOFF_BASE_MS` values in `apps/api/src/config/queue.config.ts` govern auth email.
- `SESSION_SHORT_LIVED_HOURS` accepts only `24`; `SESSION_REMEMBER_ME_DAYS` remains bounded.
- Source queue name `auth-email`; payload version 1; payload is only `{ intentId }`. Part 50
  routes that source queue onto the physical `notted-default` queue at high priority.
- Development Mailpit remains `127.0.0.1:1025` / `http://localhost:8025`.

## Security and Tenant-Isolation Notes

- No JWT, bearer plugin, refresh-token layer, Passport strategy, custom session table, or
  secret-bearing shared response was added.
- Passwords are hashed only by Better Auth. Password policy is min 8, mixed case, number,
  and symbol. Reset tokens are stored only as keyed hashes; magic-link token storage is
  hashed; email-verification JWTs exist at rest only in AES-GCM ciphertext.
- Cookies are HTTP-only, SameSite Lax, secure in production, and opaque. Better Auth trusted
  origins must contain `APP_URL`; CORS uses the same origin set. Sensitive POST endpoints
  receive the tight rate tier and Better Auth uses Redis-backed limits.
- Auth-email rows, outbox payloads, BullMQ jobs, idempotency results, and logs exclude
  plaintext tokens, URLs, bodies, passwords, cookies, and sessions.
- Authentication is identity-only. The principal has no workspace ID, role, membership, or
  permission. Part 24 must load authorization and tenant scope from PostgreSQL.

## Verification Evidence

| Check | Result | Notes |
|---|---|---|
| `pnpm install --strict-peer-dependencies` | Artifact generation only | Run twice after dependency edits; first added BullMQ packages, second reconciled direct Zod. This was not treated as a verification gate. |
| `pnpm --filter @notted/api db:generate` | Artifact generation only | Generated `0008_sour_queen_noir.sql`, snapshot, and journal entry. SQL was not reviewed or executed. |
| Tests, lint, formatting, type-check, build, audit, migration execution/check, runtime smoke, broad review | **Not run by instruction** | Verification is explicitly pending dedicated quality review. |

## Known Limitations and Follow-up Work

- The full change is unverified and may contain type/API/runtime integration issues. Run the
  focused suites first, then the broad repository gates and migration review.
- Shared package `dist/` outputs were not regenerated because builds were prohibited. The
  reviewer must build shared packages before API runtime verification and retain only the
  repository's expected generated-output policy.
- Verify Better Auth custom endpoint/plugin typing, raw Express handler middleware order,
  Drizzle plural model mapping, database transaction option, and Redis/BullMQ connection
  lifecycle against 1.6.24/5.80.10.
- Verify generic registration/resend/magic/reset responses and timing behavior, including
  existing/unknown accounts, expired/replayed links, CSRF/origin denial, and log capture.
- Verify production cookie attributes and startup behavior for missing secrets, insecure
  origins, Redis disabled/down, and email disabled/down, including the explicit route and
  self-service registration gating.
- Verify duplicate/retry semantics, especially `processing` reconciliation after ambiguous
  SMTP acceptance, worker restart, stale dispatcher locks, and safe operator recovery.
- Part 22 owns web screens, safe redirect UX, protected layouts, and Playwright journeys.
  Part 23 owns OAuth, TOTP, passkeys, remember-me UI, session controls, and recent-auth UX.
  Part 24 owns workspace/resource authorization. Parts 50/61 generalize queues/email.

## Handoff Notes

Do not mark this part complete until the migration and every required focused/broad gate
have passed. Keep migrations 0000-0007 immutable. PostgreSQL and Redis must be available
for auth; Mailpit/SMTP and the shared queue runtime that executes `AuthEmailQueueHandler` must
be available for link delivery. Never
add workspace claims to the session principal or expose provider session/token objects.

## Completion Verification Update

- Two independent review rounds completed; all reported findings were remediated before the lead
  completion review.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm db:check`, `pnpm test`, and the
  production `pnpm build` passed. The test run passed 3 shared-type, 34 shared-validator, 116 web,
  470 API, and 4 root-tooling tests; 43 infrastructure-gated API cases remained skipped in that
  default command and were exercised separately where applicable.
- Migrations 0000-0009 applied successfully to a freshly recreated disposable PostgreSQL database.
  Five live PostgreSQL/Redis/Mailpit integration files passed 23 tests, and the advanced auth live
  suite passed.
- Final Chromium Playwright passed 17 scenarios with the configured-provider case intentionally
  skipped; a separate configured-Google run passed that remaining scenario.
- `pnpm audit --prod` reported one low and five moderate transitive advisories. Review found no
  exercised Phase 4 path: SSE is unused, file sniffing/uploads are later parts, the vulnerable
  `qs.stringify` options are unused, body limits are validated constants, and the esbuild advisory
  exercised Phase 4 path: SSE is unused, file sniffing/uploads are later parts, the vulnerable
   `qs.stringify` options are unused, body limits are validated constants, and the esbuild advisory
   concerns its development server.

## Dependency Advisory Resolution

2026-07-31: Resolved 5 of 6 `pnpm audit --prod` advisories via pnpm overrides:
- `body-parser`: `1.20.4` → `1.20.6` (GHSA-v422-hmwv-36x6)
- `esbuild`: `0.18.20` → `0.28.1` (GHSA-67mh-4wv8-2f99)
- `file-type`: `20.4.1` → `21.3.4` (GHSA-5v7r-6r5c-r473, GHSA-j47w-4g3g-c36v)
- `qs`: `6.14.2` → `6.15.3` (GHSA-q8mj-m7cp-5q26)

Remaining GHSA-36xv-jgw5-4q75 (NestJS SSE injection) is a semver false positive: the
vulnerable `SseStream` class does not exist in `@nestjs/core@10.4.22` (introduced in
v11). Suppressed via `pnpm audit --ignore`. Added `audit:prod` root script.

All repository gates re-passed: build, type-check, db:check, format:check, 623 tests.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-29 | Phase 4 Part 21 implementation agent | Authored implementation, migration, tests, ADR, and docs; state remains In progress with verification pending by instruction. |
| 2026-07-31 | Lead part engineer | Resolved all 5 transitive dependency advisories via pnpm overrides; documented false-positive CVE on @nestjs/core v10; re-ran all gates; marked Complete. |
| 2026-08-14 | Maintenance | Recorded Part 50's supersession of the standalone auth-email queue, dispatcher, and per-queue configuration, and retired the five `AUTH_EMAIL_*` tuning variables that are no longer read. No behavior change; auth email delivery is unchanged. |
