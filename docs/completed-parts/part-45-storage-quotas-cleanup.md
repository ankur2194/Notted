# Part 45 — Add storage quotas and cleanup

## Status

- **State:** Complete
- **Completed on:** 2026-08-08
- **Implemented by:** backend-platform-engineer agent, auditing and completing an earlier interrupted session that had left the backend, contracts, and frontend untracked in the working tree, then two independent review rounds and a fix pass.
- **Plan reference:** `Plan.md`, Part 45 (final part of Phase 7)
- **Related records:** `part-44-generic-attachments.md` (the `uploadFile` path this part meters, the `format-bytes.ts` formatter reused, and the document-unreferenced orphan class it identified), `part-43-image-manipulation-ui.md`, `part-42-editor-image-insertion.md`, `part-41-image-ingestion-processing.md` (the reprocessing behaviour that produces `unclaimed_variant` orphans), `part-40-secure-object-storage.md` (the `ObjectStore` contract extended here and `parseAttachmentObjectKey`, pre-placed as this part's reconciliation entry point), `part-26-workspace-lifecycle-apis.md` (the `storage_limit_bytes` override this part gives meaning to), `part-19-tenant-protection-and-retention.md` (the retention windows this part is the first consumer of), `part-24-centralized-authorization.md` (the policy layer both new routes use). ADRs 0001, 0002, 0005, 0006, 0009.

## Objective

Give the workspace a real, enforced storage budget and a safe way to reclaim space. Usage is calculated from committed objects, in-flight uploads hold a reservation so concurrent uploads cannot jointly exceed the limit, and both numbers are visible in the product. Four idempotent sweeps reclaim abandoned uploads, orphaned objects and rows, expired exports, and notes past their plan's deletion-retention window — every one of them with a dry-run report mode, because this is the first code in the product that deletes bytes no user asked it to delete.

## Implemented Work

### Derived usage accounting (`apps/api/src/storage/`)

- `storage-quota.ts` is the pure half: `resolveEffectiveLimitBytes`, `buildWorkspaceStorageUsage`, `fitsWithinQuota`, and the `QUOTA_CHARGED_STATUSES` / `QUOTA_RESERVED_STATUSES` sets. Total functions over plain numbers, so "the deployment ceiling can only lower the limit" and "in-flight uploads count against the quota" are provable with no database.
- `storage-quota.service.ts` is the single place the aggregate SQL lives, serving two callers with different locking:
  - `reserve(tx, bytes)` — inside the caller's transaction, `SELECT … FOR UPDATE` on the workspace row. That lock is the whole concurrency story: two simultaneous uploads serialize, and the second reads the first's already-inserted `pending` row.
  - `readUsage(...)` — no lock, no transaction. A settings page refreshing a usage bar can never block an upload.
- `AttachmentsService.reserveQuota` now delegates to `reserve` instead of holding its own copy of the SQL. Behaviour is unchanged: same lock, same statuses, same 413 `PAYLOAD_TOO_LARGE`.
- **There is still no `storage_used_bytes` column.** Usage is `sum(size_bytes)` over the workspace's own rows, every time.

### Cleanup (`apps/api/src/maintenance/`)

- `storage-maintenance.selection.ts` holds every selection predicate as a pure function — `decideAbandonedUpload`, `decideOrphanObject`, `shouldMarkMissingObject`, `decideExportSweep`, `deletedNoteRetentionDays`, `shouldPurgeDeletedNote` — plus `SweepAccumulator`, which bounds report samples at `SWEEP_SAMPLE_LIMIT` (50). The service is deliberately boring: select candidates, ask a predicate, act. A candidate no predicate approves is never deleted regardless of what the query returned.
- `storage-maintenance.service.ts` runs the four sweeps. `runForWorkspace` is the authorized per-workspace entry point; `runSystemSweeps` is the scheduler's deployment-wide pass. Every sweep takes `{ dryRun }` and returns counts, bounded UUID samples, and note codes.
- `storage-maintenance.scheduler.ts` copies `auth-email-dispatcher.service.ts` exactly: `setInterval(...).unref()`, a `running` re-entrancy flag, `clearInterval` in `onApplicationShutdown`. It deliberately does **not** kick at startup — a cleanup sweep is not latency-sensitive, and running destructive work on every boot and rolling restart is a bad trade.
- `maintenance.constants.ts` fixes the audit action and the closed vocabulary of note codes. Codes are literal strings, never interpolated and never derived from an exception message.

### Object plane (`apps/api/src/infrastructure/minio/`)

- `ObjectStore` gains `listObjects(bucket, { prefix, limit })` returning `{ objects, truncated }`. MinIO exposes listing as an unbounded stream; the wrapper stops at `limit`, destroys the stream, and reports truncation, so memory is capped by configuration rather than by bucket size. An empty prefix is refused outright. Keys are returned but never logged.

### Transports

- `GET /api/v1/workspaces/:workspaceId/storage` — usage, `settings.read` (every role).
- `POST /api/v1/workspaces/:workspaceId/storage/maintenance` — cleanup, `settings.update` (owner/admin only), body `{ dryRun }`.
- tRPC `workspace.storageUsage` — a query, mirroring the GET through the same service and the same policy. Maintenance is deliberately REST-only.

### Configuration and tooling

- `storage.config.ts` is new: per-plan defaults, the abandoned-upload window, and the maintenance budget (enabled, dry-run, interval, batch limit, object-scan limit). Registered in `config.module.ts` and, unlike `retention.config.ts`, added to `validate-api-environment.ts` because its defaults decide whether a destructive sweep runs.
- `apps/api/scripts/storage-report.ts` + `pnpm --filter @notted/api storage:report` — dry-run report CLI. `runSystemSweeps` is called with a literal `true`, and the argument parser rejects every option, so no input can make the script destructive.

### Frontend (`apps/web`)

- `WorkspaceStorageUsage.tsx` renders the bar from native elements and Tailwind (there is no shadcn `progress` primitive). Segmented used/pending track, `role="progressbar"` with `aria-valuetext` carrying exact byte counts, concise value `aria-hidden` with the exact count in `.sr-only`.
- `WorkspaceStorageUsagePanel.tsx` is the client island for settings, supplying loading, error+retry, and permission states.
- `lib/workspaces/storage-usage.ts` holds the presentation arithmetic (segment widths, severity thresholds, value text) so the server-rendered overview and the client settings island cannot drift.
- The `WorkspaceSettings.tsx` placeholder sentence ("This value is read-only. Storage usage accounting and quota controls are managed separately.") is gone, replaced by the real display; the settings page intro copy was updated to match.

## Important Decisions

- **Usage stays derived; no counter was added.** The `FOR UPDATE` + `SUM` path makes double-spend structurally impossible. A counter would need transactional maintenance on every upload, failure, compensation, cascade delete, and sweep — five places to drift. Part 40 deferred it for this reason and Part 45 keeps that decision.
- **Per-plan defaults are free 1 GiB, pro 10 GiB, enterprise 100 GiB** (`STORAGE_QUOTA_{FREE,PRO,ENTERPRISE}_BYTES`). `Notted.md` specifies no byte quotas, so these are chosen, not derived. Reasoning: free sits an order of magnitude above the 50 MB per-file ceiling so a free workspace can hold a real working set without becoming a cheap object-storage host; pro matches the existing `MAX_WORKSPACE_STORAGE_BYTES` default of 10 GiB so the shipped default deployment behaves for pro exactly as it did before this part; enterprise is 10× pro. `MAX_WORKSPACE_STORAGE_BYTES` remains an absolute ceiling that clamps both the plan default and any per-workspace override downward — a workspace value can only ever lower the limit, never raise it. **These numbers are a product decision a reviewer should confirm rather than inherit.**
- **`StorageQuotaService` lives in `src/storage/`, not `src/attachments/`.** Two modules need it and neither should own the other: attachments needs the write path, the workspace storage transport needs the read path. Leaving it in `attachments/` would force the storage transport to import the whole upload stack to ask for a number. A neutral module keeps the dependency arrows one-directional.
- **"Abandoned multipart uploads" is read as abandoned `pending`/`processing` attachment rows.** The API performs no S3 multipart upload — uploads are buffered and committed in one saga — so there is no multipart session to abort. The equivalent leak is a row that reserved quota and never reached `ready`, which is what the sweep reclaims (default window 24 h, against uploads that complete in seconds).
- **The orphan race is closed by an age guard, not by ordering or locking.** The dangerous interleaving is: upload writes object → listing observes it → upload's transaction has not committed → sweep finds no row → deletes bytes a live row is about to claim. An object written during the run has age ≈ 0 and is refused as `too_recent`; nothing younger than `orphanedObjectCleanupDays` (7 days) is deletable at all, and no upload takes seven days to commit. The reverse interleaving (row deleted after the listing) makes the sweep *skip* a genuine orphan — the safe direction, collected next pass. Consequently the listing needs no consistency guarantee.
- **`decideOrphanObject` has four refusals and only two approvals.** Refuses `unparsable_key` (not the Part 40 layout — could be a future key family or an operator's own object), `too_recent`, `claimed_by_row`, and `workspace_mismatch` (a key whose workspace partition disagrees with its row is a corruption signal, not a cleanup task — reported, never guessed at). Approves only `no_owning_row` and `unclaimed_variant` (what Part 41 reprocessing leaves behind, since variant keys are immutable).
- **Part 44's document-unreferenced attachment class is DETECTED AND REPORTED, NEVER DELETED.** A `media_type = 'file'` row can lose its card through an ordinary edit — select+Delete, undo/redo, paste-over. Deleting on that signal would destroy bytes that a Ctrl+Z is expected to bring back, and no grace period fixes it: undo has no deadline, and the note document is not a reliable liveness signal in the first place (a card can exist in a version snapshot, in an unsaved buffer, or in a concurrent editor's pending transaction). Reclaiming it would make undo silently lossy, which is worse than holding the bytes. The sweep counts them and emits `unreferenced_attachments_detected`; reclaiming requires the existing confirmation dialog. **This is a judgement call and the most reviewable decision in the part.**
- **Maintenance is REST-only; usage is on both transports.** Reading a number is safe to expose as a tRPC query. Hard-deleting rows and bytes should need the REST surface's explicit, auditable, OpenAPI-documented POST rather than a procedure the first-party client can call as easily as it reads a number.
- **Both routes reuse existing policy actions** (`settings.read` / `settings.update`) rather than introducing storage-specific ones. A bespoke role comparison would be a second, untested copy of the permission matrix.
- **The scheduler is off by default and there is no test-only branch.** `STORAGE_MAINTENANCE_ENABLED=false` is what keeps sweeps out of the test suites and the disposable e2e stack.
- **Object keys are attribution, never authorization** (ADR 0005). A parsed key only attributes an object to a candidate row; the row inside its workspace remains the sole authority. `parseAttachmentObjectKey` is still not imported by anything under `src/authorization/`, and the existing test asserting that still holds.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/src/storage/storage-quota.ts` | Pure quota arithmetic: effective limit, usage projection, fit check, charged/reserved status sets |
| `apps/api/src/storage/storage-quota.service.ts` | The one place usage SQL lives; `reserve` (locked, in-transaction) and `readUsage` (unlocked) |
| `apps/api/src/storage/storage.controller.ts` | `GET …/storage` and `POST …/storage/maintenance`, both authorized through `@RequireAuthorization` |
| `apps/api/src/storage/storage.module.ts` | Exports `StorageQuotaService` to the attachments write path |
| `apps/api/src/storage/index.ts` | Module barrel |
| `apps/api/src/maintenance/storage-maintenance.selection.ts` | Every sweep predicate as a pure function, plus the sample-bounding `SweepAccumulator` |
| `apps/api/src/maintenance/storage-maintenance.service.ts` | Runs the four sweeps; `runForWorkspace` (authorized) and `runSystemSweeps` (scheduled) |
| `apps/api/src/maintenance/storage-maintenance.scheduler.ts` | `setInterval().unref()` driver with re-entrancy guard and shutdown clear; off by default |
| `apps/api/src/maintenance/maintenance.constants.ts` | Audit action/entity and the closed note-code vocabulary |
| `apps/api/src/maintenance/maintenance.module.ts`, `index.ts` | Module wiring and barrel |
| `apps/api/src/config/storage.config.ts` | Plan defaults, abandoned-upload window, maintenance budget and switches |
| `apps/api/src/infrastructure/minio/object-storage.service.ts` | Adds bounded `listObjects`; refuses an empty prefix, reports truncation |
| `apps/api/src/attachments/attachments.service.ts` | `reserveQuota` now delegates to `StorageQuotaService.reserve`; private `variantKeys` delegates to the shared helper |
| `apps/api/src/attachments/attachment-object-keys.ts` | `attachmentObjectKeys` — extracted from `variantKeys` so the sweeps and the upload path cannot drift on which objects a row owns |
| `apps/api/src/workspaces/workspaces.trpc.ts` | Adds the `workspace.storageUsage` query |
| `apps/api/src/config/config.module.ts`, `validate-api-environment.ts` | Registers and validates the storage config |
| `apps/api/src/app.module.ts` | Registers `StorageModule` and `MaintenanceModule` |
| `apps/api/scripts/storage-report.ts` | Report-only dry-run CLI; destructive by no reachable input |
| `packages/shared-types/src/workspace.ts` | `WorkspaceStorageUsage`, sweep/report types, the two new API paths |
| `packages/shared-validators/src/workspace.schema.ts` | `workspaceStorageUsageSchema` and the strict maintenance report contracts |
| `apps/web/src/components/workspaces/WorkspaceStorageUsage.tsx` | The accessible usage bar (native elements; no `progress` primitive exists) |
| `apps/web/src/components/workspaces/WorkspaceStorageUsagePanel.tsx` | Settings client island with loading, error+retry, and permission states |
| `apps/web/src/components/workspaces/WorkspaceSettings.tsx` | Placeholder sentence replaced by the real usage panel |
| `apps/web/src/lib/workspaces/storage-usage.ts` | Presentation arithmetic shared by the server overview and the client island |
| `apps/web/src/lib/workspaces/requests.ts`, `server-workspaces.ts`, `paths.ts`, `query-keys.ts` | Client and server data access for the usage route |
| `apps/web/src/app/(dashboard)/workspaces/[workspaceId]/page.tsx` | Server-rendered usage on the overview, degrading only its own card |

## Database and Data Changes

**No schema change and no migration.** This was a deliberate goal: usage is derived from existing `attachments` rows, and every sweep reads columns that already exist (`attachments.processing_status` / `created_at`, `exports.object_expires_at`, `notes.is_deleted` / `deleted_at`, `workspaces.plan` / `storage_limit_bytes`). `pnpm --filter @notted/api db:generate` was **not** run and no file under `apps/api/src/database/migrations/` changed.

Data *effects* are significant even though the schema is unchanged, and they are why every sweep is off by default:

- Abandoned `pending`/`processing` attachment rows and their objects are hard-deleted after `STORAGE_ABANDONED_UPLOAD_HOURS` (24).
- Orphaned objects are hard-deleted after `RETENTION_ORPHANED_OBJECT_DAYS` (7); rows whose objects are gone are marked, not silently dropped.
- Expired `exports` rows and their objects are released after `RETENTION_EXPORT_OBJECT_DAYS` (7).
- Soft-deleted notes past their plan window are **hard-deleted, irreversibly**, with attachment objects removed before/alongside the row cascade so the cascade cannot manufacture orphans. Pro and enterprise are `unlimited` by default, so only free-tier notes are purged at all under shipped defaults.

Rollback: there is no restore path for a purged note or a deleted object. Recovery is off-host backups (Part 72). This is the reason for the staged enablement below.

## API, Configuration, and Operational Changes

**Routes** — `GET /api/v1/workspaces/:workspaceId/storage` (`settings.read`, all roles) and `POST /api/v1/workspaces/:workspaceId/storage/maintenance` (`settings.update`, owner/admin) with body `{ dryRun }`. tRPC gains `workspace.storageUsage` (query). No existing route changed shape.

**New environment variables**, all added to `apps/api/.env.example` with comments:

| Variable | Default | Effect |
|---|---|---|
| `STORAGE_QUOTA_FREE_BYTES` | 1 GiB | Free-plan default limit when `storage_limit_bytes` is NULL |
| `STORAGE_QUOTA_PRO_BYTES` | 10 GiB | Pro-plan default |
| `STORAGE_QUOTA_ENTERPRISE_BYTES` | 100 GiB | Enterprise-plan default |
| `STORAGE_ABANDONED_UPLOAD_HOURS` | 24 | Age at which an unfinished upload is reclaimed |
| `STORAGE_MAINTENANCE_ENABLED` | **false** | Master switch for the scheduler |
| `STORAGE_MAINTENANCE_DRY_RUN` | **true** (code and `.env.example` agree) | Report-only scheduled passes |
| `STORAGE_MAINTENANCE_INTERVAL_MS` | 3600000 | Sweep interval (60 s–24 h) |
| `STORAGE_MAINTENANCE_BATCH_LIMIT` | 200 | Max rows any one sweep may touch per pass |
| `STORAGE_MAINTENANCE_OBJECT_SCAN_LIMIT` | 5000 | Max keys one bucket listing may buffer |

The previously-unread `RETENTION_*` windows from Part 19 now have their first consumer; their defaults and names are unchanged.

**Are the defaults safe?** For development and for the e2e stack, yes: `STORAGE_MAINTENANCE_ENABLED=false` means no sweep runs, nothing is deleted, and no test is perturbed. For production the rollout is staged and deliberate: (1) run `pnpm --filter @notted/api storage:report` and read what would be deleted against real data; (2) set `STORAGE_MAINTENANCE_ENABLED=true` and watch the logged counts for several cycles — the code default keeps this report-only; (3) only then set `STORAGE_MAINTENANCE_DRY_RUN=false`. The code default and `.env.example` now agree on `true`. They did not in the first draft, and the review round classified that asymmetry as a data-loss path: a deployment that set `STORAGE_MAINTENANCE_ENABLED=true` in a secrets manager without defining `STORAGE_MAINTENANCE_DRY_RUN` got an irreversible cascade purge on the next interval. Destroying bytes now requires two explicit acts, in either direction.

**Disabling the scheduler:** `STORAGE_MAINTENANCE_ENABLED=false` (the default). The guard is checked both in `onModuleInit` and in `kick()`, so no timer is created and no pass would run even if one were.

**New command:** `pnpm --filter @notted/api storage:report`.

## Security and Tenant-Isolation Notes

- Both routes authorize through `AuthorizationEntryService` / `@RequireAuthorization` with existing actions; no bespoke role check exists in the transport. `settings.update` denies editor and viewer, so an ordinary member cannot trigger a destructive sweep.
- `readUsage` and `reserve` are workspace-scoped through the tenant repository, so one workspace's usage cannot include or reveal another's. A `workspace_mismatch` between an object key's partition and its row's `workspace_id` is refused and reported rather than resolved by guessing.
- Reports carry counts, bounded UUID samples, and a fixed vocabulary of snake_case note codes. The Zod contract is `.strict()`, so a report structurally cannot carry a filename, an object key, a signed URL, or document content. Sweep logs carry counts only; the scheduler's failure log deliberately does not interpolate the exception message, because a storage-client error can contain an endpoint or a key.
- `listObjects` refuses an empty prefix, bounds memory by configuration, and never logs keys.
- Object keys attribute, never authorize (ADR 0005). DB-first deletion and idempotent object removal are preserved: removing an absent object succeeds, so a partially-completed pass is safe to repeat.
- Deleting an attachment row removes its objects via the shared `attachmentObjectKeys` helper, so no variant is missed.
- Negative-authorization and cross-tenant tests are written (see below) but **not executed** in this unit.

## Verification Evidence

Run by the fix pass after the first review round. Every row below was executed and watched.

| Check | Result | Notes |
|---|---|---|
| `pnpm build:packages` | Pass | Run first. |
| `pnpm format:check` | Pass | After `pnpm format`. |
| `pnpm lint` | Pass | After `pnpm lint:fix`. |
| `pnpm type-check` | Pass | The `TS2352` on `subtreeNoteIds`'s `result.rows` assertion is gone; `apps/api` compiles and the dev container's `tsc --watch` is healthy again. |
| `pnpm test` | Pass | 6/6 tasks. |
| `pnpm build` | **Fail (environment, not code)** | `@notted/web` only: `NEXT_PUBLIC_APP_URL must use a secure protocol in production`, from the dev `apps/web/.env.local`. `pnpm --filter @notted/api build` passes standalone, and `next build` passes with production-shaped env. |
| `apps/api` unit suites (quota, selection, scheduler, service, config, controller) | Pass | 129/129 in a targeted run: `storage-quota` 15, `storage-maintenance.selection` 33 (incl. the new reconciliation-exemption case), `.service` 23, `.scheduler` 9, `storage.config` 22. |
| `apps/api/test/storage-quota.integration.test.ts` (live PostgreSQL) | Pass | 3/3, verified running rather than skipping. |
| `apps/api/test/storage-maintenance.integration.test.ts` (live PostgreSQL + MinIO) | Pass | 6/6, including *"keeps a row marked failed by reconciliation across the next sweep pass"* — previously a deliberately failing test, now passing **as written**, with the shipped seven-day windows. |
| `apps/api/test/attachments.integration.test.ts` (concurrent-upload quota) | Pass | *"serializes concurrent uploads on the workspace row so quota cannot be double-spent"* genuinely exercises `SELECT … FOR UPDATE`: one upload fulfilled, one `PAYLOAD_TOO_LARGE`. |
| `apps/api` full suite + 70 % coverage (**inside the `api` container**) | Pass | 998 passed, 4 skipped; 83.45 / 76.83 / 86.27 / 85.16; exit 0. Host runs skip 73 DB/MinIO-gated tests, so only the container run is decisive. |
| `apps/web` workspace settings / overview / storage-usage suites | Pass | Part of the green 1162/1162 web run. |
| `pnpm --filter @notted/api storage:report` | Not run | Requires an operator pointing it at real data; still owed. |
| `pnpm --filter @notted/api db:generate` | Not applicable | No schema change; deliberately not run. |

Tests written in this part cover: plan-default resolution and the `MAX_WORKSPACE_STORAGE_BYTES` clamp; `pending`/`processing` counted as reserved and `failed` excluded; every sweep predicate exhaustively, including the "never approves a live row" and "second run is a no-op" properties; dry-run mutating nothing; cross-workspace usage isolation; an unauthorized role failing to trigger maintenance; and the frontend loading, error+retry, permission, and viewer-read states. Integration suites follow the existing `describe.skipIf(!HAS_DATABASE_URL)` / `!HAS_MINIO` gating with a reachability probe, use `minio-test-helpers.ts`, and generate fixtures at test time — no binary fixture is committed.

## Known Limitations and Follow-up Work

- **The per-plan byte quotas are invented here** and should be confirmed as a product decision. Changing them is a one-line config edit with no data migration.
- **`STORAGE_MAINTENANCE_DRY_RUN` now defaults to `true` in code**, matching `.env.example`. The review round found the previous `false` default a data-loss path: an operator who set only `STORAGE_MAINTENANCE_ENABLED=true` in a secrets manager that never saw `.env.example` got a real `sweepDeletedNotes` one interval later. Destroying bytes now takes two explicit acts.
- **The reconciliation sweep's `failed` rows are exempt from the abandoned-upload reaper, permanently.** Both windows are measured from `created_at` and a row can only be marked `storage_object_missing` once it is already older than the orphan window, so without the exemption 100 % of reconciliation records were hard-deleted on the next pass. `decideAbandonedUpload` and the sweep-1 SQL both hold the rule (`is distinct from`, so a `failed` row with a NULL `processing_error` is still reaped). These rows own no reclaimable bytes — their object is the thing that vanished — so they accumulate at one row per lost file, and there is no automatic expiry for them. If that ever matters, the fix is a `failed_at` column and a window measured from it.
- **`reportUnreferencedAttachments` uses a non-sargable leading-wildcard `LIKE` over `notes.content::text`.** The `LIMIT` bounds the result, not the scan, so this query sets the sweep's latency floor and will dominate it on a large workspace. Report-only, hourly, and cannot corrupt anything; the reference-table upgrade above removes it. Marked `ponytail:` in the source.
- **The 50 MiB upload route has no dedicated rate limit — scheduled, not merely noted.** `RateLimitService` has exactly one authenticated bucket (`AUTH_RATE_LIMIT_PER_MINUTE`, 1000/min) and no per-route policy, so a route-scoped tightening needs a policy decorator, guard metadata resolution, and a config value — more than the decorator this pass was scoped for. **Concrete worst case: ~1000 × 50 MiB per minute of buffer churn — heap, not storage** — from a single already-authenticated actor holding `file.upload` on their own note. It is self-inflicted exhaustion inside one tenant's deployment, not a cross-tenant or unauthenticated vector, and the workspace quota bounds what is *kept*. Mitigations in place: the parser's `maxBytes` ceiling refuses a body before it is fully buffered, an `Idempotency-Key` is required, and `file.upload` is authorized against the target note before a body byte is read. **Owner: the part that introduces per-route rate-limit policy (Part 74 hardening at the latest); do not let it slip past that.** Marked `ponytail:` at `attachments.controller.ts`.
- **`notes` has no composite `(workspace_id, parent_id)` foreign key.** `notes_parent_id_notes_id_fk` (migration `0003_cute_maria_hill.sql:87`) is a plain self-reference with `ON DELETE CASCADE`, so a cross-workspace parent edge is representable and Postgres would cascade across it regardless of any predicate this service writes. That is why the subtree traversal is deliberately *unscoped* — see Important Decisions. The durable fix is a composite key that makes the bad edge unrepresentable, which is a schema change for a later part, not a Part 45 change.
- **Document-unreferenced file attachments are reported, never reclaimed.** Bytes for a card removed by an ordinary edit are held indefinitely. A real solution needs a durable reference signal that survives undo — most naturally a reference count maintained on note save, which is a larger change than this part should make.
- **The scheduler is in-process with a per-process re-entrancy guard.** Two API replicas will both sweep. That is safe because every sweep is idempotent and bounded (duplicated work, not corrupted state) but it is wasteful. Part 50's BullMQ queue is where this work eventually belongs.
- **Sweeps are bounded per pass** (`BATCH_LIMIT` 200, `OBJECT_SCAN_LIMIT` 5000) and report truncation; a large backlog needs several passes to drain.
- **`presignedGetUrl` remains unused** — still Part 54's.
- No per-plan *per-file* size limit was added; `Notted.md`'s "configurable per workspace plan" for the 50 MB ceiling is still deployment-wide via `MAX_UPLOAD_SIZE_BYTES`.

## Handoff Notes

- **Most of this part arrived as untracked working-tree files from an interrupted session**, so it was audited rather than written in one pass. It has since been executed end to end: two independent review rounds and a fix pass, with the full `apps/api` suite and both integration suites green inside the `api` container. The caveat that once stood here — "nothing in it has ever been executed" — no longer applies.
- **Do not add a `storage_used_bytes` column** without revisiting the reasoning in `storage-quota.ts`'s header. Every write path would need to maintain it transactionally.
- **Put new sweep logic in `storage-maintenance.selection.ts`, not in the service.** The part's two acceptance properties are properties of the predicates, and keeping them pure is what makes them provable without infrastructure.
- **The sweeps hard-delete.** When changing one, verify the dry-run path first and re-check that a candidate must be *approved* by a predicate rather than merely *returned* by a query.
- `parseAttachmentObjectKey` must stay unimported by `src/authorization/`; a test asserts it.
- Integration suites need `DATABASE_URL` and MinIO, and `apps/api/vitest.config.ts` sets `fileParallelism: !hasDatabase` because suites share `SEED_IDS` — the new suites respect that and no new suite fights it.
- Verify `STORAGE_MAINTENANCE_ENABLED` is unset or `false` before running any test or e2e stack.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-07 | backend-platform-engineer agent | Initial record; part implemented, no quality gate executed |
