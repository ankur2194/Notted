# Part 71 — Add audit logging and administrative views

## Status

- **State:** Complete
- **Completed on:** 2026-08-25
- **Implemented by:** Claude Code session (backend/platform implementer + six specialist subagents)
- **Plan reference:** `Plan.md`, Part 71
- **Related records:** [Part 18](part-18-operations-integration-tables.md) (the `audit_logs` table this part finally makes binding), [Part 24](part-24-centralized-authorization.md) (the policy layer the two new actions extend), [Part 55](part-55-version-snapshots-retention.md) (the retention service/queue pattern copied here), [Part 65](part-65-public-rest-api-api-keys.md) (the admin-surface shape: service, controller, `ApiKeys.tsx`), [Part 62](part-62-export-job-lifecycle.md) (the download header block and the newly audited export lifecycle)

## Objective

Turn `audit_logs` from a table thirteen services wrote to by hand into a real audit trail: one writer, immutable rows, captured request context, an administrative read/export surface that owners and admins alone can reach, and a retention sweep that is the single sanctioned way a row ever leaves.

The governing verification from `Plan.md` is that **sensitive mutations produce exactly one immutable event** and that **viewers and editors cannot access administrative logs**.

## Implemented Work

- **Request context (`common/request/request-context.ts`).** An `AsyncLocalStorage<RequestContext>` holding `{ requestId, ipAddress, userAgent }`, entered by `RequestContextMiddleware` around `next()`. This is the mechanism that finally populates `ip_address` and `user_agent`, which no writer had ever set. Both strings are truncated at the boundary to their column widths (45 / 512).
- **One writer (`audit/audit-record.ts`).** `recordAudit(db, event)` is a pure function, not a provider: it takes the caller's transaction so the audit row still commits with the mutation it describes (ADR 0006). It fills the request facts, defaults and redacts metadata, and falls back to the ambient request id. `redactAuditMetadata` blanks credential-shaped keys by exact name and by suffix, with a depth cap. `allowAuditDelete(tx)` sets the transaction-local purge flag.
- **All thirteen existing writers refactored** to call it, keeping their private method names and signatures so no caller changed. `api-keys` and `webhooks` renamed their private `recordAudit` to `writeAudit` to avoid shadowing the import.
- **Append-only in the database** (`0021_audit_logs_append_only`). A `BEFORE UPDATE OR DELETE` trigger raises SQLSTATE 42501 with exactly two exemptions: a referential action (recognised by `pg_trigger_depth() > 1`, covering the `workspace_id` CASCADE and the `user_id` SET NULL) and a DELETE under `notted.audit_purge = 'on'`.
- **Retention sweep.** `AuditLogRetentionService` + `AuditLogRetentionQueueService`, copied from the Part 55 note-version pair: 500-row batches, at most 10 per sweep, `for update skip locked`, a counting dry run, and `allowAuditDelete` inside each batch transaction. Job `audit.log.retention.sweep` on the maintenance lane, every 6 hours.
- **New events.** Comments (`comment.create`, `comment.delete`, `comment.resolve`, `comment.unresolve`) and exports (`export.create`, `export.cancel`, `export.download`). `ExportService.cancel` became transactional so its row commits only on a real state transition; an already-settled cancel audits nothing.
- **Authorization.** `audit.read` and `audit.export`, both over the `workspace` resource, owner/admin only, admin-scope only for API keys.
- **Read surface.** `GET /workspaces/{id}/audit-logs` (filtered, paged) and `GET .../audit-logs/export` (CSV, capped, sensitive rate-limit tier), sharing one query path so the file can never describe a different slice than the table.
- **Administrative view.** `AuditLog.tsx` in workspace settings, admin-gated presentationally, with filters, a semantic table, pagination and a CSV download link.

## Important Decisions

- **A request AsyncLocalStorage, not the tenant context.** `AuthorizationEntryService.run()` rebuilds the tenant context from `{ workspaceId, userId }` alone; the Express `Request` never reaches the services that audit. One store entered by the middleware covers REST, tRPC and Better Auth. Jobs have no store, so they record `NULL` ip/user-agent — which is the truth, not a gap.
- **A pure function, not an injected audit service.** A provider would have added a constructor argument to thirteen classes and a stub to every one of their unit suites, to gain nothing a module-scoped function does not already give.
- **The trigger, not a convention.** The schema comment previously claimed immutability was "service-enforced". That was only true of well-behaved application code. A trigger also stops a migration, a `psql` session, and a bug.
- **`pg_trigger_depth() > 1` rather than a second GUC** for the referential path: a cascade genuinely runs deeper than a client statement, so the condition describes the real distinction instead of inventing a flag someone must remember to set.
- **`set_config(..., true)` — transaction-local.** The purge permission reverts on commit or rollback and cannot leak onto a pooled connection. The integration test asserts exactly that: a delete in the next savepoint is refused again.
- **Redaction is a backstop, not the control.** The control is that every caller passes identifiers by construction. The deny-list is exact-name plus suffix rather than substring, verified against every key the thirteen existing writers pass (`keyPrefix`, `encryptionKeyVersion`, `contentConsent`, `credentialChanged` would all have been destroyed by a substring rule).
- **`audit.` denied by prefix in the editor and viewer blocks.** Required, not defensive: the generic `.read` suffix rule below each block would otherwise have allowed `audit.read` for both roles. Same reasoning for the `adminAction` set in `decideApiKey`.
- **`audit.export` is not high-risk.** It reads data the same principal can already page through; re-authentication on a read is friction without a threat model.
- **The actor's display name is joined; the actor's email is not.** A table of raw UUIDs is a compliance artefact nobody can read, but an exportable CSV is the wrong place to duplicate personal data the members list already holds.
- **The export is materialised, not streamed.** It is bounded at 10 000 rows by the service, so a stream would add ceremony for a bound it already has.
- **Seed rows are inserted directly, not through `recordAudit`.** A seed is not a request, and the ids must be deterministic. They use `onConflictDoNothing` because the trigger refuses the `onConflictDoUpdate` every neighbouring table uses.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/src/common/request/request-context.ts` | Request ALS: `RequestContext`, `runWithRequestContext`, `getRequestContext` |
| `apps/api/src/common/request/request-context.middleware.ts` | Enters the store around `next()`, truncating IP and agent |
| `apps/api/src/audit/audit-record.ts` | `recordAudit`, `redactAuditMetadata`, `allowAuditDelete` — the only writer |
| `apps/api/src/audit/audit-logs.service.ts` | `list` / `exportRows`, one shared query path, workspace-scoped |
| `apps/api/src/audit/audit-csv.ts` | RFC 4180 encoder with formula-injection guarding |
| `apps/api/src/audit/audit-logs.controller.ts` | The two REST routes and the CSV download header block |
| `apps/api/src/audit/audit.module.ts` | Registered in `app.module.ts` |
| `apps/api/src/database/migrations/0021_audit_logs_append_only.sql` | The append-only trigger and its two exemptions |
| `apps/api/src/database/schema/audit-logs.ts` | Comment corrected: immutability is now database-enforced |
| `apps/api/src/maintenance/audit-log-retention.service.ts` | Batched purge under the transaction-local flag; dry run |
| `apps/api/src/maintenance/audit-log-retention-queue.service.ts` | 6-hour scheduler and maintenance-lane handler |
| `apps/api/src/authorization/authorization.contracts.ts` | `audit.read`, `audit.export` |
| `apps/api/src/authorization/authorization-policy.service.ts` | Resource kinds, editor/viewer prefix deny, API-key admin scope |
| `apps/api/src/comments/comments.service.ts` | Four comment events; the stale `comment.resolution` log line removed |
| `apps/api/src/export/export.service.ts` | Create/cancel/download events; `cancel` made transactional |
| `packages/shared-validators/src/audit-log.schema.ts` | Query, entry and page contracts; `AUDIT_LOG_EXPORT_MAX_ROWS` |
| `packages/shared-types/src/audit-log.ts` | `AUDIT_LOG_API_PATHS` and the row/page/filter types |
| `apps/web/src/lib/audit-logs/requests.ts` | `listAuditLogs`, `auditLogExportUrl` |
| `apps/web/src/components/workspaces/AuditLog.tsx` | The administrative view |
| `apps/api/test/audit-logs.integration.test.ts` | Database-gated proof of the trigger, capture, authorization, paging, retention |

## Database and Data Changes

- **Migration `0021_audit_logs_append_only.sql`** (custom, generated by `drizzle-kit generate --custom`). Creates `audit_logs_append_only()` and the `audit_logs_append_only_trigger` `BEFORE UPDATE OR DELETE ... FOR EACH ROW`. No column, index, or data change; no backfill; no table rewrite. `CREATE TRIGGER` takes a brief SHARE ROW EXCLUSIVE lock for the duration of the DDL and does not block readers. **Rollback:** `DROP TRIGGER audit_logs_append_only_trigger ON audit_logs;` then `DROP FUNCTION audit_logs_append_only();`, returning to the previous application-only enforcement with no data loss.
- **Compatibility:** the trigger is strictly additive to running code — nothing in the application updated or deleted an audit row before this part. Three test cleanups that deleted audit rows directly now wrap themselves in `allowAuditDelete`.
- **Seed:** four fixed-id rows (`SEED_IDS.auditLogs`, three Alpha and one Beta), `SEED_EXPECTED_COUNTS.auditLogs = 4`, counted in `test/database.seed.test.ts`.
- **Retention:** rows older than `auditLogRetentionDays` (365) are deleted by the new sweep. This is the first code path that deletes an audit row.
- **Migration `0023_greedy_exiles.sql`** (review round 1). `CREATE INDEX "audit_logs_retention_scan_idx" ON "audit_logs" USING btree ("created_at","id")`, generated by `pnpm --filter @notted/api db:generate` from the added `index("audit_logs_retention_scan_idx").on(t.createdAt, t.id)` in `schema/audit-logs.ts` — snapshot and SQL in step, no hand-editing. Mirrors Part 55's `note_versions_retention_scan_idx` (migration 0018). Non-`CONCURRENTLY`, matching 0018: it takes a SHARE lock that blocks writes to `audit_logs` for the build. That is acceptable at current volume; on a large deployed table the release step should build it `CONCURRENTLY` out of band instead. No data change, no backfill. **Rollback:** `DROP INDEX "audit_logs_retention_scan_idx";` — the sweep degrades to the sequential scan it used before, nothing else changes. Verified with `DATABASE_URL=… pnpm --filter @notted/api db:check` → `Everything's fine`.

## API, Configuration, and Operational Changes

- **New routes:** `GET /api/v1/workspaces/{workspaceId}/audit-logs` and `GET /api/v1/workspaces/{workspaceId}/audit-logs/export`. Both documented in `docs/openapi.json` (regenerated) and `docs/API.md`. No tRPC counterpart.
- **New authorization actions:** `audit.read`, `audit.export`.
- **New job:** `audit.log.retention.sweep` on the `maintenance` physical lane, source queue `audit-log-retention`, 6-hour interval, `system` authority, idempotency key `audit-log-retention:<periodStart>`.
- **New audit actions:** `comment.create`, `comment.delete`, `comment.resolve`, `comment.unresolve`, `export.create`, `export.cancel`, `export.download`.
- **No new environment variable.** `RETENTION_AUDIT_LOG_DAYS` already existed and was previously unread; this part is its first consumer. **No new dependency.**
- Defaults are safe for development and production: the trigger is unconditional, the sweep is bounded and idempotent, and the export is capped.

## Security and Tenant-Isolation Notes

- Every audit read carries `whereWorkspace(auditLogs, tenantContext)`; a non-member is refused by the authorization entry before a row is touched, and a foreign workspace yields 404, never 403, so its existence does not leak.
- `audit.read` / `audit.export` are owner/admin only. Editors and viewers are denied by an explicit `audit.` prefix check placed *above* the generic `.read` suffix rule that would otherwise have allowed them — the regression is covered by both a unit and an integration test.
- An API key needs the `admin` scope for either action.
- Audit metadata is redacted before storage; the integration test asserts an API-key creation row contains neither the raw secret nor the hashing pepper, while still carrying the display prefix.
- The CSV export guards against formula injection and is served as `attachment` with `nosniff`, a sandbox CSP, `private, no-store` and `Vary: Cookie`.
- IP and user agent are bounded at the request boundary, so a hostile header cannot inflate a row.
- The export is on the `sensitive` rate-limit tier.

## Verification Evidence

Gates were run serially by two independent review rounds and a final main-thread pass on 2026-08-25 (dev stack on the alternate-port root `.env`; the e2e stack was never started). Results below are from the final pass unless a note says otherwise.

| Check | Result | Notes |
|---|---|---|
| `pnpm lint` | **Pass** | Repo root, 2026-08-25 final run: `Tasks: 4 successful, 4 total`, `--max-warnings 0`, no problems |
| `pnpm format:check` | **Pass** | `All matched files use Prettier code style!` |
| `pnpm type-check` | **Pass** | `Tasks: 6 successful, 6 total` |
| `pnpm test` | **Pass** | api `204 passed \| 27 skipped (231)`, web `155 passed (155)`, shared-validators `16 passed`, shared-types `4 passed`; `node --test scripts/*.test.mjs` `# pass 21 / # fail 0` |
| `pnpm test:ci` | **Pass** | `DATABASE_URL` (postgres 5433) and `REDIS_URL` (6380) exported, dev stack on the alternate-port `.env`: api `224 passed \| 7 skipped`, coverage `85.57 / 77.07 / 86.73 / 87.81`; web `155 passed`, `79.9 / 72.82 / 81.42 / 82.35`; shared-validators branch `77.17`; shared-types branch `95.69` — every threshold ≥ 70 met. The 7 skipped API suites are MinIO/Meilisearch/Chromium/`AUTH_E2E`-gated |
| `pnpm build` | **Pass** | Prefixed with the three `NEXT_PUBLIC_*` values: `Tasks: 4 successful, 4 total` |
| `pnpm --filter @notted/api db:check` | **Pass** | `Everything's fine 🐶🔥` with migrations `0021`–`0023` in the journal |
| `pnpm --filter @notted/api openapi:generate` | Pass | Regenerated `docs/openapi.json`; the builder asserts documented and discovered routes match in both directions, so both audit routes are proven registered and documented |
| `drizzle-kit generate --custom --name=audit_logs_append_only` | Pass | Produced `0021_audit_logs_append_only.sql`, its journal entry and `0021_snapshot.json` |
| Live trigger / capture / authorization / retention behaviour | **Pass** | `test/audit-logs.integration.test.ts` ran against the live database inside `pnpm test:ci` and in reviewer round 2's focused run (`6 files / 53 tests passed`, zero skips); reviewer round 1 additionally probed the trigger by hand through `psql` (`UPDATE`/`DELETE` refused, flagged `DELETE` allowed, rolled back) |

## Known Limitations and Follow-up Work

- **Authentication events are NOT written to `audit_logs`** — a deliberate, user-confirmed decision. Sign-in, sign-out, password reset and two-factor events have no workspace, and `audit_logs.workspace_id` is `NOT NULL`. They remain in the structured application log. Recording them would require either a nullable workspace column or a separate account-scoped table; neither is in scope for this part.
- ~~**The retention sweep has no supporting index.**~~ **Closed in review round 1** by migration `0023_greedy_exiles.sql` (`audit_logs_retention_scan_idx` on `(created_at, id)`), taken exactly the way Part 55 took it in 0018. The remaining, much smaller ceiling is the `MAX_BATCHES_PER_SWEEP = 10` cap: a backlog larger than 5 000 rows drains over several six-hourly sweeps rather than one. Marked with a `ponytail:` comment in the service.
- **Queue administration remains in `platform_admin_audits`**, not `audit_logs` — it is a platform-scoped concern with no workspace. Considered satisfied, not deferred.
- **Branding events (Part 72)** will call `recordAudit` for `workspace.logo.update` / `workspace.logo.delete`; nothing here needs to change to accommodate them.
- **No Playwright journey** for the administrative view; browser coverage is deferred as it was for Parts 67–70.
- **The list offset-pages.** Deep pages are bounded at 10 000 by the schema, as with API keys; a keyset cursor is the upgrade if a workspace's trail ever makes deep paging routine.

## Handoff Notes

- **`recordAudit` is the only sanctioned way to write an audit row.** A direct `insert(auditLogs)` skips the request capture and the redaction. The seed is the one deliberate exception, and it says so in place.
- **Never delete or update an audit row without `allowAuditDelete` inside the same transaction.** The flag is transaction-local; setting it outside a transaction grants nothing. A test fixture that cleans up audit rows must use it — three already do.
- **Do not edit `0021_audit_logs_append_only.sql`.** It is deployed migration history. A change to the trigger is a new migration.
- **Adding an index to `audit_logs` requires touching the Drizzle schema and generating a migration together.** Hand-writing `CREATE INDEX` into a custom migration would drift from `0021_snapshot.json` and make the next `db:generate` emit a spurious statement (the trap `0020_happy_epoch.sql` documents).
- **The `audit.` prefix denies in `editorAllowed` and `viewerAllowed` are load-bearing.** They sit above a generic `.read`/`.list` suffix rule that would allow the action. Deleting them silently grants every editor and viewer the workspace's audit trail.
- **A new audit action needs no registration** — `action` is a `varchar(50)`, not an enum. Follow the `<entity>.<verb>` lowercase convention and keep metadata to identifiers.
- `pnpm test:ci` needs `DATABASE_URL` exported and the dev stack up, or the audit integration suite skips silently and reads as a coverage regression that is not one.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-25 | Claude Code session | Initial record — implementation complete, quality gates deferred to the session reviewer |
| 2026-08-25 | Claude Code session | Review round 1 fixes. **C1:** `AuditLogRetentionService.countExpired` used an unsound `as` on a `QueryResult`, which failed `tsc` and therefore `type-check`, `build` and the dev API container's `tsc --watch` entrypoint; replaced with the Drizzle query builder (`select({ count: sql<number>\`count(*)::int\` })`), and the cutoff predicate is now a shared `expiredBefore` getter so the dry-run count and the delete batch read the same database clock. Unit test updated (it stubbed raw `execute`). **M1:** added `audit_logs_retention_scan_idx` and migration `0023`. **H6:** `test/audit-logs.integration.test.ts` — Drizzle 0.45.2 wraps driver errors, so the `42501` assertions moved to `{ cause: { code } }`; step 4 no longer claims to prove transaction scoping (a released SAVEPOINT keeps a `set_config(..., true)` for the rest of the enclosing transaction, so the old assertion was testing PostgreSQL, not the trigger) and instead clears the flag and re-checks, with the pooled-connection property asserted after the rollback; step 5 now deletes a throwaway actor, because every seeded user authors notes and `notes.created_by_id` is RESTRICT. |
| 2026-08-25 | Claude Code session | Review round 2 and final gates. Round 2 raised no findings against this part; all 18 round-1 findings were verified closed. Final serial run from the repo root: lint, format, type-check, test, build, `test:ci` (live database), `db:check` all pass — table updated. Status moved to Complete. |
