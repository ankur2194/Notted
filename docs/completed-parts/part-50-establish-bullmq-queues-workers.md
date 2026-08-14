# Part 50 — Establish BullMQ queues and workers

- **Status:** Complete
- **Date:** 2026-08-12
- **Scope:** Tasks 50.1–50.5, independent review and remediation, and the complete applicable verification gate
- **Verification:** Passed, including a disposable Redis runtime probe and fresh PostgreSQL migration application.

## Result

Tasks 50.1–50.5 define four execution queues (`notted-default`, `notted-export`, `notted-ai`, `notted-maintenance`), a shared `notted-dead-letter`, typed identifier-only envelopes, PostgreSQL-authoritative outbox dispatch, committed worker claims, bounded retry/timeouts, graceful lifecycle, export concurrency two, provider-aware AI limits, maintenance scheduling, and the operator-only `/admin/queues` surface. Image processing remains request-scoped and was not migrated by explicit product direction.

Part 50 is complete. Independent review ran twice around one bounded remediation pass; the lead resolved the remaining findings and ran the final gate.

## Architecture and security decisions

- Redis is ephemeral delivery infrastructure. `job_outbox` is authority; the bounded dispatcher also reclaims stale `dispatched` rows and republishes with the outbox UUID as stable Bull job ID after Redis loss.
- Worker replay protection now commits a `processing` claim before invoking handlers outside a database transaction. Settled ordinary failures release the claim for configured retry. A timeout aborts cooperative work but quarantines uncancellable/ambiguous work as `reconciliation_required`; it is never automatically overlapped or resent.
- Invitation delivery commits `email_deliveries.processing` before SMTP. Provider ambiguity or restart from processing transitions to `reconciliation_required`, preserving a manual reconciliation boundary rather than risking duplicate mail.
- Four execution queues and the shared DLQ remain unchanged. Export concurrency remains exactly two and AI provider limits remain configured independently.

- `users.isPlatformOperator` maps to `users.is_platform_operator`, is `NOT NULL DEFAULT false`, and is declared to Better Auth as `input: false` and `returned: false`. Registration/profile input cannot grant it, and ordinary public user contracts were not widened.
- `PlatformOperatorService.requireOperator` calls `AuthService.authenticate(Request)`, rejects unavailable auth with generic 503, rejects no/deleted/stale sessions with generic 401, reads the authoritative user row, and requires exactly `true`. It never reads headers as identity and never reads workspace membership/role.
- `main.ts` mounts `BULL_BOARD_PATH` (`/admin/queues`) before Nest's global `/api/v1` prefix. The middleware authenticates and rate-limits every board request with the existing trusted-principal limiter.
- The exact route policy permits authenticated GET/HEAD UI assets, queue views, queue/job data, and redacted logs. The only mutation is individual failed-job retry on an execution queue. Bulk retry, clean/remove, promote, DLQ mutation, add-job, update-data, Redis/provider stats, pause/resume, and empty are denied because they cannot bypass PostgreSQL authority safely.
- Retry requires trusted Origin, a physically failed Bull job, a failed durable outbox row, and a matching idempotency record. One transaction appends the authorized audit and returns durable rows to retryable dispatched/pending state before forwarding Bull retry. A correlated append-only outcome row records forwarding status without provider detail. Attempt/audit failure is fail-closed; later forwarding failure leaves durable intent recoverable.
- Audit rows contain only operator UUID, allow-listed bounded action, canonical queue name, optional validated opaque job ID, validated correlation UUID, and timestamp. There is no workspace, path, query, body, header, cookie, IP address, user agent, payload, return value, or error/provider detail. Operator UUID intentionally has no FK so user deletion cannot erase/null evidence.
- `QueueInfrastructureService.internalBullBoardQueues()` is the only queue-owner seam. It returns the five existing owned `Queue` instances only inside `QueueModule`; neither that service nor Redis/queue clients are exported. `BullBoardService` is the exported mount adapter.
- `RedactedBullMqAdapter` wraps jobs before Bull Board serialization and also installs formatters. Data and return values become fixed `{ redacted: true }`; names, progress, processed-by/provider detail, failure reasons, stacks, parent/repeat details, and logs are removed or replaced. This remains redacted if a future producer accidentally puts note/email content in Redis.
- Existing global Helmet headers remain in force. The board route adds a self-host-only CSP with the narrow inline-style allowance required by Bull Board; no global weakening or third-party asset source is allowed.
- No public-enable network default was invented. Deployment must keep `/admin/queues` behind a private-network/VPN or equivalent reverse-proxy rule, as required by ADR 0006 and Plan Part 80. Application authorization remains mandatory even there.

## Migration

- Generated forward migrations: `0016_high_jigsaw.sql` and additive `0017_sloppy_giant_man.sql`.
- Generated artifacts: `apps/api/src/database/migrations/meta/{0016_snapshot.json,0017_snapshot.json,_journal.json}`
- Shape: 0016 creates platform authority/audit storage. 0017 adds processing/reconciliation enum states and worker processing timestamp, invitation processing/reconciliation states, and append-only audit phase/outcome correlation columns.
- Compatibility/locking: the boolean is deny-by-default and needs no backfill logic; PostgreSQL may briefly lock `users` while adding it. The table is additive. No operator is granted automatically.
- Rollback: first remove/disable `/admin/queues`, then drop `platform_admin_audits`, then drop `users.is_platform_operator`. This destroys audit evidence and operator grants and therefore requires explicit retention/forensics approval. Queue business state is unaffected.

## Files

- `apps/api/src/database/schema/{users,auth-contract,platform-admin-audits,index}.ts`
- `apps/api/src/database/migrations/{0016_high_jigsaw.sql,0017_sloppy_giant_man.sql}`
- `apps/api/src/database/migrations/meta/{0016_snapshot.json,0017_snapshot.json,_journal.json}`
- `apps/api/src/auth/{auth.service,auth.module,platform-operator.service,platform-operator.service.test}.ts`
- `apps/api/src/queue/{bull-board-policy,bull-board.service,redacted-bull-mq.adapter,bull-board-security.test,queue-infrastructure.service,queue.module}.ts`
- `apps/api/src/main.ts`
- `apps/api/test/platform-admin-migration.test.ts`
- `docs/completed-parts/{README.md,part-50-establish-bullmq-queues-workers.md}`

## Test coverage

- Unauthenticated, non-operator/workspace-admin, operator, stale/deleted-user session, and dependency-outage authorization behavior.
- Missing/invalid Origin denial and the exact method/path/query allow-list.
- Fixed job data/return/name/progress/provider/error/stack redaction.
- Audit insertion success and fail-closed insertion failure.
- Literal `/admin/queues` mount before the global prefix.
- Generated migration's deny-by-default authority and payload-free audit shape.

## Known limitations and follow-up boundaries

- Outcome audit insertion occurs after the HTTP response and is best-effort because a failed append cannot roll back an already forwarded Redis mutation. The durable retry transition and attempt audit remain atomic and fail-closed.
- `reconciliation_required` requires an operator to establish the external outcome before choosing remediation; there is intentionally no automatic resend.
- There is no self-service operator-grant API. Initial grants require controlled database administration.
- When Redis/queue runtime is disabled or unavailable, the route returns 503 after authorization.
- Private-network reverse-proxy enforcement is deployment work and remains pending; application authorization alone does not satisfy ADR 0006's public-network requirement.

## Commands

- `pnpm db:generate` in `apps/api` — generated `0016_high_jigsaw.sql`, snapshot, and journal entry. Generated SQL was read only and not manually edited.
- `pnpm --filter @notted/api db:generate` — regenerated the undeployed forward migration as `0017_sloppy_giant_man.sql` with safe defaults, snapshot, and journal entry; generated SQL was not hand-edited.
- Fresh disposable PostgreSQL: `pnpm --filter @notted/api db:migrate` — all migrations, including 0016 and 0017, applied successfully.
- Disposable Redis live probe using Notted's `QueueInfrastructureService` — passed waiting-job survival across runtime restart, stable-job-ID duplicate suppression, three-attempt retry, failed-job administrative retry, redacted DLQ publication, and graceful closure. The temporary probe source was removed after execution.
- `pnpm test` — passed all six repository tasks; API: 1,285 passed and 74 infrastructure-gated tests skipped. Relevant infrastructure-gated behavior was run separately above.
- `pnpm format:check`, `rtk lint`, and `pnpm type-check` — passed.
- `pnpm --filter @notted/api db:check` and `pnpm --filter @notted/api build` — passed.
- Production-environment root build — passed before the final dependency-injection-only CLI correction; the API build was rerun afterward and passed.
- Independent quality review, bounded remediation, and fresh second review — completed; remaining findings were resolved by the lead before the final gate.

## Corrective verification — 2026-08-14

Migration `0017_sloppy_giant_man.sql` had correctly inserted `processing` and
`reconciliation_required` into both `email_status` and `job_status`, but the live
PostgreSQL assertions in `operations-integration-schema.test.ts` still expected
the pre-Part-50 arrays. The assertions now preserve exact equality and enum order
for all six email states and all five job states; no schema or migration changed.

The focused schema suite passed 18/18 after applying every migration to fresh
disposable PostgreSQL. `DATABASE_URL=... FEATURE_REALTIME_ENABLED=false pnpm
test:ci` then passed all six repository tasks, including 1,477 API tests and all
coverage thresholds. Independent backend implementation and read-only quality
review completed before the lead's live verification. The disposable database
was removed afterward.
