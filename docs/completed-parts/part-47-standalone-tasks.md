# Part 47 — Implement standalone task CRUD and list view

## Status

- **State:** Complete with follow-up
- **Completed on:** 2026-08-10
- **Implemented by:** Claude Code session (implementation subagent, one fix pass, two independent review passes, orchestrator-applied final fixes)
- **Plan reference:** `Plan.md`, Part 47
- **Related records:** [Part 17](part-17-standalone-task-data.md) (task schema this activates), [Part 06](part-06-shared-types-validators.md) (the task contracts rewritten here), [Part 46](part-46-tags-and-templates.md) (shared HTTP client, `tagIdsSchema`, `TagPicker`), [Part 32](part-32-note-browsing-hierarchy-ui.md) (the dnd-kit reorder pattern copied here), [Disposable end-to-end stack](disposable-e2e-stack-2026-08-07.md)

## Objective

Turn the standalone task schema delivered structurally in Part 17 into a working feature: ordered task CRUD covering checkbox, text, due date and time, assignee, priority, tags, recurrence, status, and bulk actions; a defined timezone model for due dates and recurrence; and drag reorder with accessible alternatives and optimistic rollback. Part 48 builds board, calendar, and progress views on these contracts.

## Implemented Work

### Shared contracts — rewritten against the database

The Part-06 task contracts contradicted the Part-17 schema on four names and two value sets. The database is the authority, so `packages/shared-types/src/task.ts` and `packages/shared-validators/src/task.schema.ts` were rewritten. Full change list:

| Part-06 contract | Database | Applied change |
|---|---|---|
| `TaskStatus` includes `"cancelled"` | enum literal `canceled` | renamed to `"canceled"` |
| `TaskRecurrence = daily\|weekly\|monthly` | `none,daily,weekly,monthly,custom` | added `"none"` and `"custom"` |
| `recurrence: TaskRecurrence \| null` | NOT NULL, default `none` | null variant dropped; defaults to `"none"` |
| — | `recurrence_cron` | added `recurrenceCron: string \| null` |
| `dueAt` | `due_date` | renamed to `dueDate` |
| `position: z.number().int().min(0)` | `sort_order double precision` | renamed to `sortOrder`, typed `z.number().finite()` — midpoint inserts produce fractions |
| — | `custom_status_id` | added `customStatusId` plus a resolved `statusLabel` |
| — | `updated_by_id` | added `updatedById` to `TaskDetail` |
| `createTaskSchema.position` (required) | — | deleted; placement is the anchor `beforeTaskId` |
| `taskFilterSchema.workspaceId` in the body | path segment | deleted; schema renamed `taskListQuerySchema` |

Added: `TASK_API_PATHS`, `TaskGrouping`, `TaskPage`, `TaskCreateResult`, `TaskUpdateResult` (carrying `spawned`), `TaskDeleteResult`, `TaskReorderResult`, `TaskBulkResult` (carrying `skipped[].reason` and `affected`), `TaskStatusId`, `taskCronSchema`, `reorderTaskSchema`, `bulkTaskSchema`, `taskListInputSchema`, and response schemas. The only consumer of the old contracts was one test, which was updated.

### Backend

- New `apps/api/src/tasks/` — `tasks.service.ts`, `tasks.controller.ts`, `tasks.trpc.ts`, `tasks.constants.ts`, `task-recurrence.ts`, `tasks.module.ts`, `index.ts`.
- `task-recurrence.ts` is a pure module with no Nest decorator, so it unit-tests standalone. `daily` is +24h, `weekly` +168h, `monthly` the same UTC day-of-month next month clamped to that month's last day, `custom` delegates to `cron-parser` with `{ tz: "UTC" }`, and `none` or beyond a five-year horizon returns null.
- `TasksService` exposes seven methods — `list`, `read`, `create`, `update`, `reorder`, `remove`, `bulk` — each authorizing before any SQL. `create` and `bulk` are idempotent; `update`, `reorder`, `remove`, and `bulk` run `serializable`. Sibling groups are held with `pg_advisory_xact_lock`; placement is a midpoint with renormalisation when the gap is exhausted. Tag ids and custom-status names are batch-loaded, so listing is free of N+1.
- Reorder takes a **relative anchor**, never an absolute index. When `beforeTaskId` is non-null and no longer in the sibling group, the service answers `409 ORDER_CONFLICT` rather than guessing a placement.
- Completing a recurring task inserts its successor **in the same transaction** and returns it as `TaskUpdateResult.spawned`.
- `bulk` authorizes every id individually before the transaction and collapses denied and missing ids to a single `"unavailable"` reason, so the batch endpoint is not an existence oracle.
- REST at `/api/v1/workspaces/:workspaceId/tasks` with `POST /bulk` declared **before** the `:taskId` routes, plus a `task` tRPC subrouter.

### Frontend

- `apps/web/src/lib/tasks/` — `requests.ts`, `server-tasks.ts` (both on Part 46's shared client), and a pure `grouping.ts` providing `groupTasks`, `isOverdue`, and `dueLabel` via `Intl`, with no date library.
- `apps/web/src/components/tasks/` — `TaskListView` (grouping select, bulk selection and toolbar, one live region, manual optimistic mutations), `TaskRow` (checkbox, inline title, native date and time inputs, assignee, priority, tags via Part 46's `TagPicker`, recurrence with a conditional cron field), `TaskSortableList` (dnd-kit, structure copied from `NoteList.tsx`), and `CreateTaskForm`.
- `NoteDetailView` renders `TaskListView` below the paper editor for a task-list note, and `ConvertNoteTypeControl` switches a note between document and task list.

### Cross-cutting defect fixed en route

`AuthorizationDeniedError` raised *inside* a handler — for example `authorizeListScope` on a foreign `noteId` — had no REST translation at all. Only `AuthorizationHttpGuard` converted denials, and it runs before the handler, so every service-level denial on the REST surface returned **500 instead of 404**. `authorizationDenialToHttpException` was extracted into `authorization.errors.ts`, reused by the guard, and added to `ApiExceptionFilter`, closing the hole for every current and future service-raised denial rather than only for tasks.

## Important Decisions

- **No migration.** Every property `Notted.md` names already has a column. Explicitly rejected: `task_statuses.is_terminal` (terminal is the built-in `done`; a task with a `custom_status_id` retains its built-in `status`, which alone drives `completed_at` — **Part 48 inherits this**), `tasks.version` (see the reorder decision), `tasks.time_zone` (see the timezone model), a `(workspace_id, note_id, sort_order)` index (speculative — existing indexes cover every filter in `taskListQuerySchema`; this is the first thing to add if the list view is measured slow), and a `recurrence_cron` grammar CHECK (Part 17 recorded that the grammar belongs in the application layer).
- **Timezone model.** Storage is canonical UTC in one `due_date timestamptz`. **The client owns date↔instant conversion**: the UI composes a local date plus an optional time and sends a full ISO instant, and a date with no time resolves to 00:00 *local* in `Intl.DateTimeFormat().resolvedOptions().timeZone`, so "due today" means what the user sees. **Recurrence uses UTC interval arithmetic** on the stored instant with monthly day-clamping. **Custom cron fields are UTC fields**, and the UI says so in helper text next to the input — a silent timezone assumption in a cron field generates support tickets. **Overdue is computed client-side** against the browser clock, so it is always fresh; there is deliberately no `isOverdue` server field, which would be stale the moment it serialised. Named ceiling, marked with a `ponytail:` comment: a daily 09:00 task in a DST-observing zone drifts one hour across a DST boundary, and the upgrade path is a `tasks.time_zone` column.
- **Recurrence spawns synchronously, inside the completion transaction.** A job would need a queue, a worker, and a `job_outbox` consumer that does not exist today, and would put a visible delay between checking the box and seeing the next occurrence. The Verify bullet asks for an observable result.
- **Recurrence advances past `max(dueDate, now)`, not past `dueDate` alone.** Completing a five-months-overdue daily task would otherwise spawn an already-overdue successor. The horizon is still measured from the due date, so an abandoned recurrence stops rather than replaying.
- **Reorder conflicts are detected by anchor, with no version column.** The client sends `beforeTaskId`; the service takes the sibling-group advisory lock in a serializable transaction, reloads siblings, and answers `409 ORDER_CONFLICT` when the anchor has left the group. Two concurrent reorders against valid anchors both succeed deterministically, which is correct behaviour rather than a conflict. Field edits stay last-write-wins: adding `expectedVersion` plumbing to every inline checkbox toggle is a migration and a UX tax for a race a single-row inline edit almost never loses.
- **Task deletion is hard.** `tasks` has no `is_deleted` column and subtasks cascade through the self-FK. `TaskBulkResult.affected` therefore reports the true subtree count, not the click count, and the confirmation dialog names the cascade before it happens.
- **Creating a task does not call `task.assign`.** The row does not exist yet, so the authorization fact load would 404. Membership is validated inside the transaction; `task.assign` guards *reassignment* on an existing task.
- **The recurrence spawn drops a lapsed assignee to `null` rather than failing the completion.** Refusing would strand the user on a task they finished; carrying a non-member forward would assign work to someone who can no longer see the workspace.
- **Zero production authorization changes were required.** Every `task.*` action, the `"task"` resource kind, and the locator's `targetUserId` and `tagId` fields already existed from earlier parts. `editorAllowed` has no `task.delete` branch, so the trailing `return false` denies it — consistent with `note.delete` and `folder.delete`, and deliberately left alone.
- **The task list renders BELOW the paper editor, not instead of it.** `Notted.md` §4 says task-list notes get a "simplified editor (no rich text, just tasks)". The user explicitly chose the additive layout instead, so `PageContainer` and `NoteEditorSurface` stay mounted and the task list occupies its own labelled section underneath. This is a recorded deviation, commented in `NoteDetailView.tsx`; it is additive and reversible, so no ADR was raised.
- **`cron-parser@4.9.0` was promoted from a bullmq transitive to a declared dependency.** It was already resolved in the lockfile, so this adds no new supply-chain surface, and a regex cannot correctly evaluate ranges, steps, and aliases.
- **A tRPC subrouter ships even though the web app is REST-only**, for the same reason as Part 46: `docs/standards/api.md` mandates it and every existing module has one.

## Files and Components

| Path | Purpose |
|---|---|
| `packages/shared-types/src/task.ts` | Rewritten task contracts, `TASK_API_PATHS`, result types |
| `packages/shared-validators/src/task.schema.ts` | Rewritten task Zod schemas, cron and bulk validation |
| `packages/shared-types/src/common.ts` | `TaskStatusId` |
| `packages/shared-types/src/api.ts` | `TASK_HIERARCHY_INVALID`, `TASK_RECURRENCE_INVALID` |
| `apps/api/src/tasks/tasks.service.ts` | Task policy, SQL, ordering, recurrence spawn, bulk |
| `apps/api/src/tasks/task-recurrence.ts` | Pure cron and interval arithmetic with monthly clamping |
| `apps/api/src/tasks/tasks.controller.ts` | REST `/api/v1/workspaces/:workspaceId/tasks` |
| `apps/api/src/tasks/tasks.trpc.ts` | tRPC `task` subrouter |
| `apps/api/src/authorization/authorization.errors.ts` | `authorizationDenialToHttpException`, shared by guard and filter |
| `apps/api/src/common/errors/api-exception.filter.ts` | Translates service-raised denials to 404/403 |
| `apps/web/src/lib/tasks/grouping.ts` | `groupTasks`, `isOverdue`, `dueLabel` — pure, `Intl`-based |
| `apps/web/src/lib/tasks/requests.ts`, `server-tasks.ts` | Task data access |
| `apps/web/src/components/tasks/TaskListView.tsx` | List, grouping, bulk toolbar, optimistic mutations |
| `apps/web/src/components/tasks/TaskRow.tsx` | Per-task controls and accessible move alternatives |
| `apps/web/src/components/tasks/TaskSortableList.tsx` | dnd-kit reorder and group headings |
| `apps/web/src/components/tasks/CreateTaskForm.tsx` | Single-field quick add |
| `apps/web/src/components/notes/NoteDetailView.tsx` | Mounts the task list below the editor |
| `apps/web/src/components/notes/ConvertNoteTypeControl.tsx` | Document ↔ task-list conversion |
| `apps/web/e2e/task-list.spec.ts` | Real-stack coverage for all six Verify bullets |

## Database and Data Changes

**None.** No migration was generated and no schema file was modified. `pnpm --filter @notted/api db:check` reports `Everything's fine`. `tasks`, `task_statuses`, `task_tags`, and all three enums pre-date this part. No backfill, no retention change, no seed change. Rollback is a code revert.

Note for operators: task deletion is **hard** and cascades to subtasks. There is no trash and no restore for tasks, by schema design.

## API, Configuration, and Operational Changes

New REST routes, all under the existing `/api/v1` prefix and the existing authenticated rate-limit tier:

| Method | Path |
|---|---|
| `GET` | `/api/v1/workspaces/:workspaceId/tasks` |
| `POST` | `/api/v1/workspaces/:workspaceId/tasks` (201, `Idempotency-Key` required) |
| `POST` | `/api/v1/workspaces/:workspaceId/tasks/bulk` (`Idempotency-Key` required; declared before `:taskId`) |
| `GET` | `/api/v1/workspaces/:workspaceId/tasks/:taskId` |
| `PATCH` | `/api/v1/workspaces/:workspaceId/tasks/:taskId` |
| `POST` | `/api/v1/workspaces/:workspaceId/tasks/:taskId/reorder` |
| `DELETE` | `/api/v1/workspaces/:workspaceId/tasks/:taskId` |

New tRPC procedures: `task.list`, `task.read`, `task.create`, `task.update`, `task.reorder`, `task.delete`, `task.bulk`. The tRPC list input accepts a real boolean `isCompleted`, while the REST query path keeps string coercion.

**Behaviour change beyond this part's surface:** service-raised authorization denials on REST now return 404 or 403 instead of 500. This affects every module, and is a correctness fix.

New dependency: `cron-parser@4.9.0` in `apps/api/package.json`, with the corresponding `pnpm-lock.yaml` importer entry. **`pnpm install` is required** before building or testing a checkout that predates it.

**No new environment variables, ports, or feature flags.** Defaults are safe for development and production.

## Security and Tenant-Isolation Notes

- Every task query is scoped with `whereWorkspace` and filtered by a `projectVisibility` predicate against `tasks.projectId`; inserts go through `assertWorkspaceInsertValues`.
- A foreign task id **404s rather than 403s** on read, update, reorder, and delete. `bulk` collapses denied and missing ids to one `"unavailable"` reason, so it cannot be used to probe existence. Both proven against a real database in `task-list.spec.ts`.
- The assignee must be an active `workspace_members` row, and a custom status must belong to the workspace with `project_id IS NULL` or equal to the task's project. Both conceal a failure as 404.
- Reassignment requires `task.assign` in addition to `task.update`; retagging requires `task.tag`. Editors are restricted to tasks they created and may not delete.
- Cron input is validated by `cron-parser` server-side, not by a regex, and the five-year horizon bounds evaluation.
- The new `ApiExceptionFilter` branch converts a denial *before* the `status >= 500` fault-logging block, so a concealed 404 is never logged as a server fault and the log payload carries only `requestId`, `statusCode`, `errorType`, and `outcome` — no resource identifiers.
- `recordMutation` writes ids and an empty metadata object; no task titles, descriptions, assignee names, cookies, or signed URLs reach any log.
- The service unit suites record every `where` predicate and assert the workspace column and parameter through `PgDialect.sqlToQuery`, with a negative control proving the check is not vacuous — so deleting a `whereWorkspace` turns the suite red on a plain host run.

## Verification Evidence

Every command below was executed in this session. Gates were run one at a time.

| Check | Result | Notes |
|---|---|---|
| `pnpm install` | Pass | Linked `cron-parser@4.9.0`; lockfile importer entry added |
| `pnpm build:packages` | Pass | Both shared packages emit clean |
| `pnpm format:check` | Pass | All matched files Prettier-clean |
| `pnpm lint` | Pass | `--max-warnings 0`, 4/4 packages |
| `pnpm type-check` | Pass | 6/6 tasks |
| `pnpm test` | Pass | 2 + 9 + 88 + 100 test files; 11 API files skipped on the host (DB/MinIO-gated) |
| `pnpm --filter @notted/api build` | Pass | API compiles standalone |
| `pnpm build` | **Fail (known environment)** | `NEXT_PUBLIC_APP_URL must use a secure protocol in production` — `apps/web/.env.local` present. Recorded in [Part 45](part-45-storage-quotas-cleanup.md); not a code defect and not a pass |
| `pnpm --filter @notted/api db:check` | Pass | `Everything's fine` — no drift, no migration |
| `pnpm e2e:up` + `pnpm e2e:test apps/web/e2e/tags-templates.spec.ts apps/web/e2e/task-list.spec.ts` | Pass | **13/13** on a freshly reset `notted_e2e_test`; 8 are this part's |
| `docker compose exec api pnpm test:ci` | Pass | 97 files passed, 2 skipped; 83.15% statements / 75.91% branches / 87.11% functions — the decisive coverage gate |
| `pnpm e2e:down`, `node scripts/dev-tooling.mjs infra:down` | Pass | `docker ps` empty afterwards; no volume destroyed |

Plan Verify bullets, with the covering test:

| Bullet | Coverage | Where |
|---|---|---|
| Grouping | Covered | `grouping.test.ts`, `task-list-view.test.tsx`; `task-list.spec.ts:330` |
| Overdue state | Covered | `grouping.test.ts` (boundary at exactly `now`, closed tasks excluded); `task-list.spec.ts:364` |
| Assignment rules | Covered | `tasks.service.test.ts`, `authorization-policy.service.test.ts`; `task-list.spec.ts:388` proves a foreign user id 404s |
| Bulk changes | Covered | `tasks.service.test.ts`, `task-list-view.test.tsx`; `task-list.spec.ts:421` persists across a reload |
| Recurring completion | Covered | `task-recurrence.test.ts` (incl. Jan 31 → Feb 28/29 clamping, catch-up, horizon), `tasks.service.test.ts`; `task-list.spec.ts:453` |
| Concurrent reorder conflicts | Covered | `tasks.service.test.ts`, `task-sortable-list.test.tsx`; `task-list.spec.ts:489` runs a real two-session race and reconciles to the winner |

Two independent review passes ran. The first returned `failed` with eight blockers, all fixed and re-verified. The second returned `completed` with one major and four minor findings, resolved or recorded below.

## Known Limitations and Follow-up Work

- **Editors see enabled controls on tasks they did not create.** The policy restricts editor `task.update` and `task.tag` to `creatorId === actorId`, but the UI gates on note-level `canEdit`. A denied action degrades to an exact optimistic rollback and a live-region message — no data loss, no silent divergence — but the affordance is misleading. Two further cases share the cause: the delete button is enabled for editors on *every* row although editors are denied `task.delete` outright, and an editor can never clear an assignee, because the service omits `targetUserId` when `assigneeId` is null and the policy's editor branch requires an active target. The remedy is to project `createdById` onto `TaskSummary` **and** the viewer's role into the list, then gate the row controls on both. **Owner: a follow-up part, or Part 48 when it revisits task surfaces.**
- **`tasks.service.ts` is the least-covered new file at 68.58% statements / 58.19% branches**, against a repo floor of 70% that it clears only because the threshold is global. It also owns tenant scoping, serializable ordering, the recurrence spawn, and bulk authorization. Uncovered arms worth tests: `positionFor` renormalisation, `gapExhausted`, `assertNoCycle`, `effectiveCron`, `readIdempotentTask`'s 409, and the bulk idempotent-replay path.
- **No DB-backed 404-not-403 unit suite for task update, reorder, delete, or bulk.** The predicate-capture unit tests prove workspace scoping on every path, and Playwright proves 404-not-403 against a real PostgreSQL for task read and list, but the remaining four routes are covered only by inspection plus the shared `authorizeTask` path. A DB-gated Vitest suite would close it.
- **`TaskBulkResult.affected` is `0` on an idempotent replay**, by design — the call wrote nothing, and `updated` is recomputed from live authorization rather than replayed. The UI announces "already applied" in that case. If a replay should echo the original count, the count must be stored in the idempotency record.
- **`renormalize` still row-locks siblings inside a transaction that already holds the group advisory lock**, and `create` takes those two locks in that order while `update` now takes the group lock first. The inversion that made them deadlock is fixed, but neither path retries a 40P01, so a serialization failure surfaces as a 500 rendered as "could not reach Notted". A bounded serialization retry is a repo-wide gap, not a task-specific one — `notes.service.ts` has it too.
- **Inline TipTap checklists still do not become `tasks` rows**, per Part 17's recorded rule. Progress aggregation across both is Part 48's work.

## Handoff Notes

- **Run `pnpm install` first** on any checkout predating this part; `cron-parser` is newly declared and `type-check`, `test`, and `build` all fail on the import without it.
- The Part-06 task contracts are gone. Anything still referring to `dueAt`, `position`, `cancelled`, or `taskFilterSchema` is stale; the rename table above is the migration guide.
- Part 48 should read the "no `is_terminal`" decision before designing custom board columns: a task with a `custom_status_id` keeps its built-in `status`, and `completed_at` is driven by the built-in column alone.
- Reorder is anchor-based. Any new view that lets a user move a task must send `beforeTaskId` from a **complete** sibling projection; `TaskListView` disables dragging with an explanatory `role="note"` message whenever the list is grouped or is not the complete first page sorted by `sortOrder`, and a new surface needs the same guard.
- The timezone model is a contract, not an implementation detail: the client composes the instant, the server never reinterprets it, and cron fields are UTC. Changing any of those needs an ADR.
- `authorizationDenialToHttpException` is now shared by the HTTP guard and the exception filter. A service that raises `AuthorizationDeniedError` from inside a handler gets the correct 404 or 403 for free; do not re-implement the translation locally.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-10 | Claude Code session | Initial record after implementation, one fix pass, two review passes, and final orchestrator fixes |
