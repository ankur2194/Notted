# Part 48 — Add board, calendar, and progress views

## Status

- **State:** Complete with follow-up — implementation, two review passes, one fix pass, and coordinator-applied fixes for review pass 2's findings. Every gate passes except `pnpm build` (known environment failure) and end-to-end, which review pass 2 did not run
- **Completed on:** 2026-08-11
- **Implemented by:** Claude Code session (lead coordinator + one backend specialist, two parallel frontend specialists, one Playwright specialist; then review pass 1, one fix pass, review pass 2, and coordinator-applied final fixes)
- **Plan reference:** `Plan.md`, Part 48
- **Related records:** [Part 47](part-47-standalone-tasks.md) (task CRUD, timezone contract, anchor reorder, and the editor-affordance defect this part closes), [Part 17](part-17-standalone-task-data.md) (the `task_statuses` table activated here), [Part 46](part-46-tags-and-templates.md) (shared HTTP client), [Part 33](part-33-tiptap-document-contract.md) (the document node tree `countChecklist` walks), [Part 30](part-30-project-list-detail-ui.md) (the project progress bar reused), [Disposable end-to-end stack](disposable-e2e-stack-2026-08-07.md)

## Objective

Turn Part 47's single list view into three views over one shared state: a Kanban board with customizable columns and drag transitions, a calendar by due date, and consistent note and project progress computed from both task rows and inline TipTap checklists — plus a dashboard "My Tasks" widget with overdue highlighting. Part 49 builds project board and timeline views on the view-switching contract established here.

## Implemented Work

### 48.1 — Custom task status CRUD

`task_statuses` has existed since Part 17 and had **no CRUD API at all** — only reads. New `apps/api/src/tasks/task-statuses.service.ts` and `task-statuses.controller.ts`, deliberately kept out of the already-1472-line `tasks.service.ts`, wired through `tasks.module.ts` and `tasks/index.ts`.

Four REST routes under the existing `/api/v1` prefix. `GET` is open to any member (`workspace.read`, or `project.read` when `?projectId=` is supplied); the three mutations require `settings.update`, which is **owner/admin only**. Rules enforced in the service: a name colliding with a built-in enum value (`todo`/`in_progress`/`done`/`canceled`, case-insensitive) is rejected by the shared schema; workspace-level (`project_id IS NULL`) name uniqueness is enforced **inside a `serializable` transaction**, because the unique index cannot — PostgreSQL treats NULL `project_id` as distinct, a caveat already documented at `tasks.ts:208-219`; `sortOrder = max + 1` on insert; `is_built_in` rows reject rename and delete with `CONFLICT`.

Delete needs **no reassignment**: the `tasks.custom_status_id` FK is `ON DELETE SET NULL` and every affected task falls back to the built-in `status` it never lost. The service counts `tasks WHERE custom_status_id = :id` first, workspace-scoped, and returns it as `affected` so the confirmation dialog can name the number of cards that will move.

**Review-pass-1 fix:** Part 49 pointed `notes.board_column_id` at the same `task_statuses` table with the same `ON DELETE SET NULL`, but a note has **no** fallback placement — deleting a column silently un-columned every note in it while the dialog talked only about tasks. `remove` now takes a second workspace-scoped count over `notes` inside the same transaction and returns it as `affectedNotes`; `TaskStatusManager` states the consequence in words both before the delete ("Any notes placed in this column lose their board column, and a note has no built-in status to fall back to") and after it ("N tasks moved back to their built-in status; M notes lost their board column"). `affected` keeps its name and its task-only meaning.

### 48.2 — Board

`apps/web/src/components/tasks/TaskBoard.tsx`. A column is the four built-in enum values in enum order, then the applicable `task_statuses` rows by `sortOrder`; a card sits in `customStatusId ?? status`, and an unknown custom id (a project column on a board scoped elsewhere, or one deleted in another tab) falls back to its built-in column rather than vanishing.

**The board issues no task request of its own.** It receives the rows the container already holds under one `taskQueryKeys.list` entry and partitions them client-side, so every optimistic mutation, rollback and reconcile written for the list keeps all three views consistent for free. That single shared cache entry is the entire "all views reflect the same underlying state" mechanism.

A cross-column move is exactly one `updateTask`: onto a built-in column `{status, customStatusId: null}`, onto a custom column `{customStatusId}` alone — leaving the built-in `status` untouched, which is what keeps `completed_at` driven by the built-in column exactly as Part 47 specified. It deliberately does **not** also reorder: one request, one rollback path.

`TaskStatusManager.tsx` is a Radix dialog ("Manage board columns") rendered only for owner/admin, doing create/rename/recolour/delete with a confirmation naming the server's `affected` count.

### 48.3 — Calendar

`TaskCalendar.tsx` over two new pure exports in the existing `apps/web/src/lib/tasks/grouping.ts`: `monthGrid(year, month)` → 42 local `YYYY-MM-DD` keys built with `new Date(year, month, 1 - offset + i)`, and `bucketByDay(tasks)` using the same `localDayKey(new Date(task.dueDate))` the `dueDate` grouping already uses. There is **no `+86_400_000` arithmetic anywhere** — the local-calendar `Date` constructor is what makes the grid correct across a DST transition.

Month navigation costs **zero requests** unless the shared page reports `hasMore`, in which case a windowed `dueFrom`/`dueTo` query runs under its own cache key with both bounds composed locally. Undated tasks get a labelled "No due date (N)" list below the grid — never a fake cell, never dropped.

### 48.4 — Progress

- `countChecklist(document) → {done, total}` in `packages/shared-validators/src/document.schema.ts`, beside `extractNoteContentPlain`, walking the same node tree.
- Two new `notes` columns, `checklist_done` and `checklist_total`, `integer NOT NULL DEFAULT 0`, written at the same call sites that already fill `content_plain` so they cannot drift. All three writers (`create`, `update`, and `copy`) now go through one private `contentProjection(content)` returning `contentPlain` plus both counters together, so forgetting one is a type error.
- `taskDoneCount` / `taskOpenTotalCount` / `checklistSum` added to `apps/api/src/database/sql-aggregates.ts` beside `maxTimestamp`, so notes and projects cannot define "done" differently.
- One `progressSchema = {done, total}.strict()` in `common.schema.ts`, used twice on `noteSummarySchema.progress = {checklist, tasks}`. The task half comes from **one batched grouped query** in `notes.service.list`, never per row.
- `projectTaskProgressSchema` keeps its `completed`/`total` names; `coverage` changes literal `"standalone-tasks"` → `"tasks-and-checklists"` and the counts become tasks plus a `SUM(checklist_*)` over the project's non-deleted notes.
- Frontend `apps/web/src/lib/notes/progress.ts` (`combineProgress`, `progressPercent`) consumed by `NoteCard`, the note detail header, and the project page, so three surfaces cannot drift into three roundings of the same number.

### 48.5 — My Tasks widget

`MyTasksWidget.tsx` on the dashboard home between the hero and the workspace-content grid. Overdue rows get a border **and** the literal word "Overdue" plus `dueLabel`. The complete checkbox calls `updateTask` then a single `invalidateQueries({queryKey: taskQueryKeys.all(workspaceId)})` — that one invalidate is the whole cross-view consistency contract, and it is commented as such.

### 48.6 — Part 47's recorded editor-affordance defect, closed

`createdById` added to `taskSummarySchema`, `taskSelection()` and `toSummary()`. A `viewer: {userId, role}` prop threads from all three RSC mounts into `TaskListView`, which computes `canEditRow`, `canDeleteRow` and `canUnassign` and passes them to `TaskRow`. The editor caveat about clearing an assignee is one `role="note"` line per view, not per row. **No server-computed per-task `capabilities`** — the server stays authoritative; this only stops offering buttons that were always going to be denied.

### 48.7 — Routes and view persistence

New RSC route `/workspaces/:workspaceId/tasks` with sibling `loading`/`error`/`not-found`; `getServerTaskList` gained an optional `noteId`. The view switcher lives **inside** `TaskListView`, so `NoteDetailView`'s existing mount got all three views with no new plumbing. `lib/tasks/view-preference.ts` is a direct clone of the projects module (`notted:tasks:view:${workspaceId}`, injected `PreferenceStorage`, defaults + try/catch). A breadcrumb branch and one sidebar entry were added.

## Important Decisions

- **Board columns reuse `settings.update`; no new authorization action, resource kind, or policy-matrix row.** User-confirmed. Column management is workspace configuration, and `settings.update` already denies editor and viewer while allowing owner and admin — exactly the intended audience.
- **No `is_terminal`, inherited from Part 47.** A task with a `custom_status_id` keeps its built-in `status`, and `completed_at` is driven by the built-in column alone. This is precisely why a custom-column drop sends `{customStatusId}` alone.
- **REST only for task statuses — no tRPC subrouter.** A deliberate deviation from the "every module has a tRPC subrouter" habit that Parts 46 and 47 both honoured. `projects` has none either, the web app is REST-only, and a subrouter nothing calls is code to maintain for free. Flagged here rather than buried.
- **Progress counts checklists across every note, not only `note_type='task'` notes.** User-confirmed. `canceled` tasks are excluded from the total; `done` is the built-in status.
- **`coverage` stays a literal, not a one-member union.** There is one coverage rule; the field exists so a client can name it, not so a caller can choose.
- **No column reordering in this part.** User-confirmed; new columns append. `sort_order` is already `double precision`, so a midpoint insert is available whenever it is wanted — marked with a `ponytail:` comment in `nextSortOrder`.
- **The board fetches nothing new.** Rejected: a `customStatusId` filter, a multi-status filter, and per-column pagination. All three would have created a second cache entry and with it the possibility of two views disagreeing after a mutation — the exact failure the Verify bullet names.
- **A cross-column drop does not also reorder.** One request, one rollback path. The ceiling is that a card dropped between two cards in another column lands at that column's order position rather than the exact gap.
- **The board's custom-column query key lives in `lib/notes/query-keys.ts` as `taskQueryKeys.statuses`, under the same `all` prefix as the rows.** Coordinator change: the implementing agent had defined it inside `TaskBoard.tsx`, which both hid it from the canonical key module and made the `onChanged` handler refetch twice for one event. Being under the `all` prefix is deliberate — a rename changes the `statusLabel` carried on every card, so one invalidate has to reach both.
- **`GET /task-statuses?projectId=` authorizes `project.read`, not just `workspace.read`.** Backend agent's addition, kept: without it a restricted project's column names leak to members who cannot see the project.
- **`NotesService.copy` carries the checklist counters across.** A third write site beyond the two named in the brief; skipping it would have left every copied note reporting 0/0 for a document that visibly has a checklist.
- **No `job_outbox` event for status mutations, audit log only.** Nothing consumes a board-column event, and an undrained outbox only grows.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/src/tasks/task-statuses.service.ts` | Custom column policy, SQL, uniqueness, `affected` count |
| `apps/api/src/tasks/task-statuses.controller.ts` | REST `/api/v1/workspaces/:workspaceId/task-statuses` |
| `apps/api/src/tasks/tasks.service.ts` | `createdById` on the summary selection and projection |
| `apps/api/src/notes/notes.service.ts` | `contentProjection` writes both counters; batched task progress in `list` |
| `apps/api/src/projects/projects.service.ts` | Rollup widened to tasks + checklists |
| `apps/api/src/database/schema/notes.ts` | `checklist_done`, `checklist_total` |
| `apps/api/src/database/sql-aggregates.ts` | `taskDoneCount`, `taskOpenTotalCount`, `checklistSum` |
| `apps/api/src/database/migrations/0014_heavy_silver_samurai.sql` | Two columns + hand-appended recursive jsonb backfill |
| `apps/api/src/tasks/task-statuses.service.test.ts` | Workspace scoping with negative controls; the `affectedNotes` delete case |
| `apps/web/src/components/tasks/task-status-manager.test.tsx` | Delete confirmation and result copy naming both counts |
| `packages/shared-validators/src/document.schema.ts` | `countChecklist` |
| `packages/shared-validators/src/common.schema.ts` | `progressSchema` |
| `packages/shared-validators/src/task.schema.ts` | Custom status schemas, `createdById` on the summary |
| `packages/shared-validators/src/note.schema.ts` | `noteSummarySchema.progress` |
| `packages/shared-validators/src/project.schema.ts` | `coverage: "tasks-and-checklists"` |
| `packages/shared-types/src/task.ts` | `TASK_STATUS_API_PATHS`, custom status types |
| `apps/web/src/components/tasks/TaskListView.tsx` | View switcher, `viewer` gating, board/calendar mounts |
| `apps/web/src/components/tasks/TaskBoard.tsx` | Column partition, one-request column move, anchored reorder |
| `apps/web/src/components/tasks/TaskStatusManager.tsx` | Owner/admin column CRUD dialog |
| `apps/web/src/components/tasks/TaskCalendar.tsx` | Month grid, day cells, undated list, windowed query |
| `apps/web/src/components/tasks/MyTasksWidget.tsx` | Dashboard widget with overdue in words |
| `apps/web/src/components/tasks/TaskRow.tsx` | `canDelete` / `canUnassign` affordance gating |
| `apps/web/src/lib/tasks/grouping.ts` | `monthGrid`, `bucketByDay`, exported `localDayKey` |
| `apps/web/src/lib/tasks/view-preference.ts` | `notted:tasks:view:${workspaceId}` |
| `apps/web/src/lib/notes/progress.ts` | `combineProgress`, `progressPercent` |
| `apps/web/src/lib/notes/query-keys.ts` | `taskQueryKeys.statuses` |
| `apps/web/src/components/notes/NoteCard.tsx` | Combined progress bar |
| `apps/web/src/components/notes/NoteDetailView.tsx` | `viewer` forwarding; split checklist/task progress header |
| `apps/web/src/app/(dashboard)/workspaces/[workspaceId]/tasks/` | Workspace-scoped task route + states |
| `apps/web/e2e/task-views.spec.ts` | Shared-state and UTC+14 journeys |

## Database and Data Changes

**One migration: `0014_heavy_silver_samurai.sql`**, generated with `pnpm --filter @notted/api db:generate` and then hand-appended with a data backfill (precedent: `0013_free_lockheed.sql`, which contains an `UPDATE ... WHERE EXISTS`). Drizzle emits schema changes only.

- Adds `notes.checklist_done` and `notes.checklist_total`, `integer NOT NULL DEFAULT 0`. Both take the default on every existing row, so the schema half is non-blocking and backward compatible — old API code simply never reads them.
- The appended backfill is a recursive jsonb CTE mirroring `countChecklist` exactly, including the `attrs.checked = true` rule, with a `CASE` guard so `jsonb_array_elements` can never be handed a non-array. **It is a full table scan over `notes`, once, at deploy time** — acceptable at current scale, and only rows that actually contain a checklist are written (`WHERE total > 0`).
- **The backfill was executed and verified, then the predicate was corrected afterwards.** Review pass 1 applied `0014` to a disposable database and matched the backfill against the shipped `countChecklist` on 129 rows (128/129; the one divergence is the `"checked":"true"` JSON-string case). The fix pass then changed the predicate to `-> 'checked' = 'true'::jsonb`. Review pass 2 could not re-apply the migration (no containers), so it re-proved equivalence a different way: it ran the corrected CTE as a pure `SELECT` against the running dev database — 130/130 agreement with the stored counters, plus 16/16 on adversarial literal documents compared against `countChecklist` from `dist`. **The corrected file itself has still never been run as a migration.** See Known Limitations for what that means for already-migrated databases.
- Seed changed: the two seeded notes whose documents contain `taskItem` nodes now state literal counters (1/2 and 0/1), matching how the seed already states `contentPlain` literally.
- Rollback: dropping the two columns loses only a derived value the backfill can recompute. No data is destroyed.
- `apps/api/test/notes-api-indexes.test.ts` pinned the migration journal *tail* to `0013_free_lockheed`, so it broke the moment a migration was added; it now pins `entries[13]` by index and asserts the chain is contiguous, which is the actual invariant.

## API, Configuration, and Operational Changes

New REST routes, all under the existing `/api/v1` prefix and the existing authenticated rate-limit tier:

| Method | Path | Authorization |
|---|---|---|
| `GET` | `/api/v1/workspaces/:workspaceId/task-statuses?projectId=` | `workspace.read`, plus `project.read` when `projectId` is supplied |
| `POST` | `/api/v1/workspaces/:workspaceId/task-statuses` (201, `Idempotency-Key` required) | `settings.update` |
| `PATCH` | `/api/v1/workspaces/:workspaceId/task-statuses/:statusId` | `settings.update` |
| `DELETE` | `/api/v1/workspaces/:workspaceId/task-statuses/:statusId` | `settings.update` |

**No new tRPC procedures** (see Important Decisions).

**Breaking contract changes** — both are additive on the wire but required in the schema, so any out-of-tree client must be updated together with the server:

- `NoteSummary.progress: {checklist: Progress; tasks: Progress}` is **required**, on summary and detail.
- `ProjectTaskProgress.coverage` changed from the literal `"standalone-tasks"` to `"tasks-and-checklists"`. The `completed`/`total` field names are unchanged.
- `TaskSummary.createdById` added (it was already on `TaskDetail`).
- `TaskStatusDeleteResult.affectedNotes` added (review pass 1 fix) and **required** by `taskStatusDeleteResultSchema.strict()`. `affected` is unchanged and still task-only.

New frontend route `/workspaces/:workspaceId/tasks`. New browser storage key `notted:tasks:view:${workspaceId}`. **No new environment variables, ports, feature flags, or dependencies.** Defaults are safe for development and production.

## Security and Tenant-Isolation Notes

- Every task-status query is scoped with `whereWorkspace(taskStatuses, tenantContext)`; the insert goes through `assertWorkspaceInsertValues`; the delete's `affected` count is scoped with `whereWorkspace(tasks, tenantContext)` and its `affectedNotes` count with `whereWorkspace(notes, tenantContext)` — unscoped, the second count would report (and thereby leak the existence of) another tenant's board placements. The service suite asserts both predicates through `PgDialect.sqlToQuery`.
- Authorization runs **before any SQL** on all four routes, through `authorizationEntry.authorizeUser`. A foreign or other-tenant `statusId` **404s rather than 403s**, so the endpoint is not an existence oracle across tenants.
- `GET` with `?projectId=` authorizes `project.read` on that project, so a restricted project's column names do not leak to members who cannot see the project.
- The three mutations require `settings.update`, which the existing policy matrix already denies to editor and viewer. **No policy change was made** — this part adds no new action, no new resource kind, and no new matrix row, so it cannot have widened anyone's permissions.
- `create`, `update` and `remove` run at `serializable` because the workspace-level name rule is a range-read-then-insert the unique index cannot back up under NULL distinctness.
- `POST` requires an `Idempotency-Key` and replays through `lockApiIdempotency`/`loadApiIdempotency`/`storeApiIdempotency`.
- Colour is validated as `#rrggbb` at the trust boundary, matching the `varchar(7)` column, and is rendered only as an inline `background-color` on a decorative `aria-hidden` dot — never as the sole carrier of meaning, and never interpolated into a class name.
- `recordMutation` writes ids and an empty metadata object; no column names, task titles, or user content reach any log.
- The 48.6 affordance gating is **cosmetic only**. No server-computed per-task capability was added; the server remains the sole authority, and a denied action still degrades to an exact optimistic rollback and a live-region message.
- The service unit suite records every `where` predicate and asserts the workspace column and parameter through `PgDialect.sqlToQuery`, **with a negative control**, so deleting a `whereWorkspace` turns the suite red.

## Verification Evidence

The implementation pass ran **no** gate. Review pass 1 ran every gate one at a time and returned `blocked` (2 blockers, 1 major, 4 minors). A single fix pass resolved them and ran only `pnpm format`. **Review pass 2 then re-ran every gate one at a time; the "Result" column below is review pass 2's** unless the row says otherwise. Review pass 2 was run with e2e excluded by operator instruction, so the e2e row is still pass 1's evidence.

| Check | Result (review pass 2 unless noted) | Notes |
|---|---|---|
| `pnpm install` | Pass | |
| `pnpm build:packages` | Pass | Run **before** `type-check`; `apps/api` resolves the shared packages through `dist` |
| `pnpm format:check` | Pass | Failed in pass 1 on four files (pure line-wrapping); fixed and now re-verified |
| `pnpm lint` | Pass | 4/4 with `--max-warnings 0` |
| `pnpm type-check` | Pass | 6/6. Failed in pass 1 — the `notes.service.test.ts` `toSummary` fixture was missing Part 49's `NoteRow.boardColumnId`, and vitest does not type-check, which is why `pnpm test` was green. Fixed and now re-verified |
| `pnpm test` | Pass | shared-types 7, shared-validators 307, api 1169 passed / 73 skipped (11 DB-backed files skip locally without `DATABASE_URL`), web 1302, root `node --test` 17 |
| `pnpm --filter @notted/api build` | Pass | |
| `pnpm --filter @notted/api db:check` | Pass | `Everything's fine`; no drift beyond `0014` and `0015` |
| `pnpm build` | **Fail (known environment)** | Dies at `@notted/web` `env:validate` — `NEXT_PUBLIC_APP_URL must use a secure protocol in production` — **before** `next build` runs. Recorded identically in the Part 45/46/47 records. **Consequence: no production web bundle was produced, so build-time RSC/client-boundary errors remain unproven for this part** |
| Coverage — API, **container-run** | Pass | 83.44% statements / 76.14% branches / 87.56% functions / 85.48% lines against a 70% floor. 1238 passed / 4 skipped over 99 files; the DB-backed integration suites **did** run in the container |
| Coverage — web, **locally-run** | Pass | 79.86% statements / 72.97% branches / 82.40% functions / 82.44% lines; 1302/1302. The container route cannot produce this figure — `EROFS: read-only file system` on `test-results/junit.xml` |
| Migration `0014` backfill equivalence | Pass (two independent methods) | Pass 1: migration applied to a disposable database, backfill compared against the shipped `countChecklist` over 129 rows including 12 adversarial documents — 128/129, the sole divergence being the `"checked":"true"` JSON string. The fix pass then corrected the predicate. Pass 2 re-proved the **corrected** predicate without applying anything: the CTE run as a pure `SELECT` against the running dev database agreed with the stored counters on 130/130 rows, and matched `countChecklist` from `dist` on 16/16 adversarial literals (`checked` as boolean/string/`1`/`null`/absent, `attrs` as string and array, `taskItem` inside `taskItem`, `content` as object/string/absent, root array, deep nesting, empty doc, null document). The `"checked":"true"` case now yields `0/1` on both sides |
| `pnpm e2e:up` + `pnpm e2e:test` (disposable stack) | Pass — **review pass 1's evidence, not pass 2's** | 5/5 new specs, 13/13 regression, Chromium only. Excluded from pass 2 by operator instruction, so it predates the fix pass's changes to `TaskStatusManager.tsx`, `task.schema.ts` and `0014` |
| DST assertions | Mutation-tested (pass 1) | Proven non-vacuous |
| Dependencies | No new dependency added | No change to `package.json` or `pnpm-lock.yaml` at all |
| Stack hygiene | Clean | No port conflicts; no root `.env` created; `compose.yaml` never modified; pass 2 started and stopped no container |
| `pnpm --filter @notted/api db:generate` | Ran (implementation pass) | Produced `0014_heavy_silver_samurai.sql` + snapshot + journal entry; the backfill was then hand-appended |

For honesty rather than credit: the backend implementation subagent additionally ran `tsc --noEmit`, `vitest run`, `eslint` and `prettier --check` directly (not via the `pnpm` gate scripts) across `apps/api`, `packages/shared-types` and `packages/shared-validators` and reported them clean, before `apps/web` had been changed. That run predates every frontend change and **is not a gate result**. The three frontend subagents ran nothing.

Plan Verify bullets and their intended covering test — the unit suites below passed in review pass 2; the Playwright blocks passed in review pass 1 only:

| Bullet | Intended coverage | Where |
|---|---|---|
| All views reflect the same state after mutation | Single shared `taskQueryKeys.list` entry | `task-list-view.test.tsx` (list→board→calendar calls `requestTaskPage` once; a board status change is visible in the list), `task-board.test.tsx`; `task-views.spec.ts` block 1 |
| Correct date rendering across timezones | `monthGrid`/`bucketByDay` on the local-calendar constructor | `grouping.test.ts`, `grouping-timezone.test.ts` (`America/New_York`, `Pacific/Auckland`); `task-views.spec.ts` block 2 (`Pacific/Kiritimati`, UTC+14) |
| Correct date rendering across DST boundaries | `monthGrid` across spring-forward and fall-back | `grouping.test.ts`, `grouping-timezone.test.ts` — **unit only; see Known Limitations** |

## Known Limitations and Follow-up Work

- **End-to-end is the one gate review pass 2 did not run** (excluded by operator instruction). Every other gate above is pass 2's. The Playwright evidence therefore predates the fix pass, which changed `TaskStatusManager.tsx`, `task.schema.ts` and `0014`. `project-board.spec.ts`'s locators depend on the `sr-only " for {title}"` suffix in `ColumnMover`, which the fix pass did not touch, so the specs are expected to still pass — but that is an expectation, not a result.
- **`pnpm build` has never succeeded locally.** It fails in `env:validate` before `next build`, so no production web bundle exists and build-time RSC/client-boundary errors are unproven for this part. Shared with Parts 45, 46 and 47.
- **The three `serializable` transactions in `task-statuses.service.ts` (`create`, `update`, `remove`) have no bounded 40001 retry.** Under concurrent column edits a serialization failure surfaces to the caller as an error instead of being retried. **No 40001 handling exists anywhere in the repository**, so this is a pre-existing gap that this part widens by three call sites rather than a regression it introduces. Deliberately not fixed here: a retry helper belongs in one shared place for every serializable transaction in the codebase, which is a change of its own. Part 47 records the same gap.
- **The `0014` backfill predicate was corrected after it was verified, and already-migrated databases keep the pre-fix result forever.** The shipped file now uses `-> 'checked' = 'true'::jsonb`, matching `countChecklist`'s strict boolean; `0014` is not deployed anywhere, so it was edited in place rather than superseded, and the journal `when` was correctly **not** bumped. Drizzle keys replay on that `when`, so any database that already ran the old statement — the local dev database has (`drizzle.__drizzle_migrations` holds hash `af779ae1…` while the shipped file now hashes `e129345f…`) — will never re-run the corrected one. **Recreate such a database, or re-run the `UPDATE` by hand, to pick up the fix.** Materially harmless: the only behavioural difference is a `"checked":"true"` JSON string, which TipTap never emits and `document.schema.ts` rejects at the trust boundary. Review pass 2 proved the corrected predicate equivalent by pure `SELECT` (130/130 real rows, 16/16 adversarial literals) but never executed it as a migration.
- **DST is proven only in vitest, not in the browser.** Making it deterministic in Playwright needs the visible month to contain a DST transition, which depends on the wall-clock date of the run. The DST-safe arithmetic lives in `monthGrid`, which the unit suites own.
- **Board truncation is asserted only in the negative.** The `hasMore === true` branch needs 100+ seeded tasks and is untested in the browser; the unit suite covers the notice.
- **A cross-column drop does not also reorder**, and a within-column `beforeTaskId: null` appends to the *whole sibling group*, not to the column. The card still renders at the bottom of its column, but its global `sortOrder` may sit after tasks in later columns. Per-column ordering would need a column-aware anchor on the server.
- **No column reordering.** `sort_order` is already a double ready for a midpoint insert; `updateTaskStatusSchema` has no `sortOrder` field yet.
- **The board is one 100-row page.** Marked `// ponytail: single 100-row page, per-column pagination if boards get large`. Part 49 should decide whether project boards share that ceiling.
- **`TaskStatusManager` names a locally computed card count before deleting and the server's `affected` after**, because `affected` only exists in the response. The two can disagree if another tab moved a card in between; the server's number is the one shown last. The note consequence is stated **in words without a number** before the delete, for the same reason: the client never fetched a note count, and `affectedNotes` only exists in the response.
- **The calendar's windowed query is the one exception to "all views share one cache entry".** When the shared page reports `hasMore`, `TaskCalendar.tsx` fetches the visible month under its own `taskQueryKeys.list(workspaceId, windowQuery)`. `TaskListView`'s optimistic mutations `setQueryData` on the shared entry only and never `invalidateQueries`, so with more than 100 tasks a status change made in the list or board is not written into the calendar's entry. It self-heals because the calendar unmounts on a view switch and refetches on remount (`staleTime: 0`) — but that path rests on the refetch, not on the shared entry. If it ever needs to be exact, have the list mutation path call `invalidateQueries({queryKey: taskQueryKeys.all(workspaceId)})` on settle, as `MyTasksWidget.tsx` already does.
- **Per-file coverage on the drag paths sits below the 70% floor even though the aggregates clear it**: `TaskStatusManager.tsx` 41.25%/54.92%, `TaskBoard.tsx` 60%/54.05% (and Part 49's `NoteBoard.tsx` 47.61%/49.35%). That is exactly the code behind the "moving an item updates canonical status and order" bullet, and its only browser evidence is review pass 1's e2e. `apps/web/src/lib/tasks/requests.ts` reads 0% but is thin schema-validating wrappers.
- **`TaskListView` writes `createdById: viewer?.userId ?? ""` into an optimistic create**, so an invalid uuid lives in the cache until the server row lands. Cosmetic — `canEditRow` already defaults permissive when `viewer` is null — but it is a value no server response could contain.
- **Real pointer drag on the board is untested.** jsdom has no layout, so the unit suites exercise the keyboard alternatives only — the same precedent `task-sortable-list.test.tsx` set in Part 47. The Playwright journey also uses the keyboard control by design.
- Part 47's other recorded follow-ups (`tasks.service.ts` coverage, the missing DB-backed 404-not-403 suite for update/reorder/delete/bulk, the absent bounded serialization retry) are **untouched by this part** and remain open.

## Handoff Notes

- **Two contract changes break any out-of-tree client**: `NoteSummary.progress` is required, and `ProjectTaskProgress.coverage` is now `"tasks-and-checklists"`. In-tree, every producer and fixture was updated; `pnpm build:packages` (or `pnpm build`) must run before `type-check`, because `apps/api` resolves the shared packages through their `dist`.
- **The three views share exactly one query.** Do not add a filtered fetch to a view. The moment a view owns its own cache entry, the Verify bullet this part exists to satisfy stops holding.
- **`taskQueryKeys.statuses` sits under the `all` prefix on purpose.** One `invalidateQueries(all(workspaceId))` must reach both the rows and the column list, because a rename changes `statusLabel` on every card.
- **The Part 47 timezone contract is unchanged and still a contract**: the client composes the instant, the server never reinterprets it, cron fields are UTC, and overdue is computed client-side. Changing any of it needs an ADR.
- **Reorder is still anchor-based** and a board column is a filtered projection, so the same `page === 1 && !hasMore` guard applies with a `role="note"` explanation when it fails.
- **`checklist_done`/`checklist_total` are denormalized.** All three writers go through `contentProjection(content)` in `notes.service.ts`; a fourth write path that sets `content_plain` without it would silently drift. Keep them together.
- **Part 49 owns `notes.board_column_id`, `moveNoteSchema.boardColumnId`, `NoteBoard.tsx`, `NoteTimeline.tsx`, and the note view-preference module.** None of them were touched here. `lib/tasks/view-preference.ts` is the shape to clone for the note equivalent.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-10 | Claude Code session | Initial record after implementation by four specialist agents plus coordinator integration; **all verification deferred to the review agent** |
| 2026-08-10 | Claude Code session (fix pass) | Recorded review pass 1's real gate results, including the known-environment `pnpm build` failure. Fixed its two blockers (`NoteRow.boardColumnId` fixture, Prettier wrapping), the silent note un-columning on column delete (`affectedNotes` + dialog copy + tests), the `0014` backfill/`countChecklist` divergence, three missing `min-h-11` classes, and a redundant `Math.min` in `timeline.ts`. Recorded the missing bounded 40001 retry as a follow-up. **Review pass 2 pending.** |
| 2026-08-11 | Claude Code session (coordinator, after review pass 2) | Review pass 2 re-ran every gate one at a time (e2e excluded by operator instruction) and found no surviving blocker; all seven pass-1 findings confirmed resolved or honestly recorded, and the corrected `0014` predicate re-proved by pure `SELECT`. Replaced the evidence table with pass 2's results. Coordinator fixes applied without further subagents: restored the wrongly deleted `apps/web/.next/.docker-mount`, filtered `isBuiltIn` rows out of `TaskBoard.buildColumns`, corrected the two stale "not applied to any database" lines, and recorded four newly named limitations (stale-applied `0014` in already-migrated databases, the calendar's windowed cache entry, sub-floor per-file coverage on the drag paths, the optimistic `createdById` placeholder). |
