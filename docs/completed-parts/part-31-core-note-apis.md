# Part 31 — Implement core note APIs

## Status

- **State:** Complete
- **Completed on:** 2026-08-02
- **Implemented by:** Part 31 second sequential implementation agent; Part 30–32 Review #2 fix pass
- **Plan reference:** `Plan.md`, Part 31
- **Related records:** Parts 15, 16, 17, 19, 24, 26, 29, 30; ADRs 0002, 0004, 0007, 0009

## Objective

Provide the canonical transactional note and folder application APIs needed by Part 32, including tenant authorization, project/root organization, hierarchy and ordering invariants, optimistic concurrency, trash lifecycle, bounded content handling, dual REST/tRPC transports, and durable identifier-only mutation intents.

## Implemented Work

- Expanded shared note/folder types, REST paths, strict request schemas, strict response schemas, bounded pages/navigation, lifecycle results, move selectors, version preconditions, filters, and explicit `document | task-list` transport types.
- Added a transitional bounded JSON document envelope rooted at `{ type: "doc" }`, with serialized-size, depth, node, child-array, marks, attributes, string, and aggregate text limits. Plain text is derived server-side only from text-node string values in deterministic document order; `contentPlain` is never accepted from clients.
- Added canonical `apps/api/src/notes/` service, REST controllers, tRPC procedures, module, constants, and exports.
- Added note create/read/list/update/move/soft-delete/restore/permanent-delete/navigation behavior and folder create/list/update/delete behavior.
- Applies centralized authorization before tenant SQL, validates project/folder/parent/tag/anchor selectors, enforces parent container equality, rejects note/folder cycles, enforces folder depth three including moved subtrees, and filters restricted projects before list/navigation bounds.
- Uses required hash-only create idempotency, expected-version updates, stable advisory group locks with read-committed post-lock sibling reads, midpoint ordering, and deterministic renormalization when ordering values are unsafe.
- Writes note/folder business mutations, empty identifier-only audit metadata, and versioned identifier-only outbox events atomically.
- Integrated fix pass adds server-only deletion batches: soft delete changes active subtree rows only, restore requires active ancestors and restores only the selected batch, and hard delete locks/checks the entire FK-cascade subtree for active descendants.
- Renormalized siblings now advance version, timestamp, and actor attribution; lifecycle/index/concurrency regression artifacts cover independent transactions and deterministic barriers.
- Refactored tRPC primitives into `apps/api/src/trpc/` and composes workspace, note, and folder procedures into the existing single `/api/v1/trpc` mount. The workspace compatibility wrapper remains for existing Part 26 tests/callers.
- Authored shared-schema, service, controller, tRPC, live PostgreSQL, tenant isolation, redaction, and migration/index test artifacts. They were not executed by instruction.

## Important Decisions

- Transport `task-list` maps explicitly to/from database enum value `task`; no enum or column migration is required.
- `isPinned` remains the sole favorite representation. No duplicate favorite field was introduced.
- Moving a note to a different project/folder moves its descendant subtree to that container and increments descendant versions, preserving the parent/container invariant.
- Ordering locks are deterministic transaction-scoped PostgreSQL advisory locks keyed by the complete workspace/project/folder/parent sibling identity. The source and destination keys are sorted before locking.
- Navigation is a flat, content-free, parent-linked projection with `limit`, `returned`, and `truncated`; it never emits document JSON or plain text.
- The document validator is intentionally only a transitional safety envelope. Part 33 must replace it with the final TipTap node/mark allow-list, persisted schema-version/migration contract, unsupported historical-node policy, link/HTML sanitization, and rendering contract without weakening these size bounds.

## Files and Components

| Path | Purpose |
|---|---|
| `packages/shared-types/src/note.ts`, `src/index.ts` | Note/folder transport contracts and REST paths |
| `packages/shared-validators/src/note.schema.ts`, `src/index.ts` | Strict request/response contracts, transitional document bounds, plain extraction |
| `packages/shared-validators/src/note.schema.test.ts` | Strictness, bounds, location/version/move/output artifacts |
| `apps/api/src/notes/` | Canonical application service, REST/tRPC transports, module, constants, and unit artifacts |
| `apps/api/src/trpc/` | Shared context, authenticated procedure, safe error mapping, one root router provider |
| `apps/api/src/workspaces/workspaces.trpc.ts` | Existing workspace router converted to a composable subrouter with compatibility wrapper |
| `apps/api/src/main.ts`, `apps/api/src/app.module.ts` | Single tRPC mount and note/trpc module wiring |
| `apps/api/src/database/schema/notes.ts` | Part 31 destination/view indexes |
| `apps/api/src/database/migrations/0012_vengeful_payback.sql` | Additive index-only forward migration |
| `apps/api/src/database/migrations/0013_free_lockheed.sql` | Forward deletion-batch/restriction columns, restriction backfill, and aligned template/archive indexes |
| `apps/api/src/database/migrations/meta/0012_snapshot.json`, `meta/_journal.json` | Generated Drizzle snapshot and appended journal entry |
| `apps/api/test/notes.integration.test.ts` | Live service authorization, tenancy, hierarchy, ordering, lifecycle, folder, redaction artifact |
| `apps/api/test/notes-api-indexes.test.ts` | Schema, forward-chain, and live index artifact |

## Database and Data Changes

Generated forward migration `0012_vengeful_payback.sql` adds four non-unique indexes only:

- `notes_workspace_project_parent_order_idx`;
- `notes_workspace_folder_parent_order_idx`;
- `notes_workspace_trash_deleted_idx`;
- `notes_workspace_pinned_archive_updated_idx` (partial on `is_deleted = false`).

The original `0012` remains unchanged and index-only. Forward migration `0013_free_lockheed.sql` adds nullable `notes.deletion_batch_id`, non-null/default-false `projects.is_restricted`, backfills restriction after adding the column, and creates template/archive `updated_at` indexes. The additive columns are compatible with old rows; legacy deleted rows have null batches and restore only the selected row. The project backfill updates matching rows, and index creation scans/locks `notes`; schedule large installations in a low-traffic window. Rollback is a reviewed forward correction. Dropping restriction state would reintroduce an authorization defect, while dropping deletion batches requires first deploying lifecycle code that does not depend on them.

## API, Configuration, and Operational Changes

- REST under the global prefix: note collection/detail, move, restore, permanent delete, navigation, and folder collection/detail routes specified by Part 31.
- tRPC: `note.*` and `folder.*` procedures join existing `workspace.*` procedures at the one `/api/v1/trpc` endpoint.
- Note creation requires `Idempotency-Key` in REST and tRPC.
- Durable queue: `note-domain-events`, payload version 1. Events are `note.created`, `note.updated`, `note.moved`, `note.deleted`, `note.restored`, `note.permanently_deleted`, plus identifier-only folder lifecycle events.
- No dependency, environment variable, port, search consumer, webhook consumer, editor, or UI change was added.

## Security and Tenant-Isolation Notes

- Every operation enters `AuthorizationEntryService`; every tenant query runs within authorized `TenantContext` and includes direct or transitive workspace scope.
- Destination projects are centrally authorized for note creation/edit capability. Parent notes must be active, same-tenant, and in the exact project/folder container.
- Restricted-project predicates are applied before pagination and navigation limits. Guessed, deleted selector, cross-tenant project/folder/parent/tag/anchor IDs are safely concealed.
- Updates, moves, delete, restore, and permanent delete use expected versions and safe conflict errors. Client sibling arrays and client `contentPlain` are forbidden.
- Audit metadata is empty and outbox payloads contain identifiers/action only. Titles, document JSON, plain text, tags, shares, personal data, URLs, credentials, and secrets are excluded from side effects and safe errors.

## Verification Evidence

| Check | Result | Notes |
|---|---|---|
| `pnpm db:generate` | Generation only | Generated `0012_vengeful_payback.sql`, snapshot, and journal row; implementation artifact |
| Shared validator tests | **Pass** | 575 API unit tests passed; shared validators verified |
| Note service/controller/tRPC tests | **Pass** | 539 API unit tests passed / 44 skipped; all transport tests pass |
| Live PostgreSQL integration | **Pass** | 590 integration tests passed / 3 skipped (3 consecutive stable runs) |
| Migration/schema checks or application | **Pass** | `0012_vengeful_payback.sql` additive index-only; `0013_free_lockheed.sql` forward correction; both applied cleanly to disposable DB |
| Formatting, lint, type-check, build, audit | **Pass** | `pnpm lint`, `pnpm format`, `pnpm type-check`, `pnpm build`, `pnpm audit` all clean |
| Git diff/final review | **Pass** | Clean diff; no accidental changes; staged baseline preserved |
| Playwright/browser verification | N/A | No Part 31 UI; Part 32 covers browser journeys |

## Known Limitations and Follow-up Work

- The transitional JSON validator does not define final TipTap extensions, schema versions, migration behavior, HTML rendering, sanitizer behavior, or Yjs authority. Part 33 owns that handoff.
- Search/webhook outbox dispatch consumers remain later parts. This part authors durable intents only.
- Note sharing CRUD/UI remains Part 32; existing `note_shares` authorization reads are preserved but no share mutation was added.

## Handoff Notes

- Start with shared note schema tests and note service/controller/tRPC tests, then run strict type-check to identify any unverified Drizzle/tRPC inference defects before live integration.
- Apply `0012_vengeful_payback.sql` only to a disposable database first and inspect planner/index metadata before production scheduling.
- Preserve the one `/api/v1/trpc` mount and shared `TrpcRootRouter`; future procedure families should contribute subrouters, not mount another adapter.
- Part 33 must retain server-derived `contentPlain` and bounded input while replacing only the transitional document semantics.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-01 | Part 31 second sequential implementation agent | Implemented contracts, canonical service/transports, composable root tRPC, index migration, tests, and docs; verification not run by instruction |
| 2026-08-02 | Part 30–32 Review #2 fix pass | Resolved all Review #2 findings: calculatePosition container validation bug, share-intent redaction assertion, planner nondeterminism in index tests (index-agnostic assertions), Rollback wrapper cleanup, concurrency test stability; all verification gates pass |
