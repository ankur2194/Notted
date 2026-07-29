# Part 17 — Implement Standalone Task Data

## Status

- **State:** Complete
- **Completed on:** 2026-07-29
- **Implemented by:** `backend-platform-engineer` (subagent)
- **Plan reference:** `Plan.md`, Part 17
- **Related records:**
  `part-15-projects-notes-hierarchy-ordering.md`;
  `part-16-tags-attachments-comments-versions.md`;
  `docs/decisions/0007-schema-gaps-and-safe-defaults.md`

## Objective

Introduce the first-class standalone task schema that ADR 0007 ("Standalone
tasks") requires and that Plan Part 17 specifies: workspace-owned task items
queryable separately from TipTap inline checklist nodes, so that due dates,
assignees, priority, recurrence, status, ordering, and board/calendar views
are all first-class DB queries. The part adds custom task statuses (which
double as board columns) per workspace or project, recurrence configuration,
optional tag links, and the cross-workspace project composite FK that mirrors
the Part 15 `notes_workspace_project_fk` invariant. This is purely structural
schema work: no NestJS services, transports, jobs, or auth wiring are
introduced. The inline-checklist sync rule and the assignee-membership rule
are documented as deferrals to the service parts that own them.

## Implemented Work

- Added `apps/api/src/database/schema/tasks.ts` defining:
  - `taskStatusEnum` = `pgEnum("task_status", ["todo", "in_progress", "done",
"canceled"])` — the four universal built-in lifecycle states every
    workspace starts with; default `todo` per ADR 0007 ("status starts todo").
  - `taskPriorityEnum` = `pgEnum("task_priority", ["low", "medium", "high",
"urgent"])` — Notted.md priority levels; default `low` is the safe
    fallback. Color mapping (gray/yellow/red/purple) is editor/UI concern
    (Part 47).
  - `taskRecurrenceEnum` = `pgEnum("task_recurrence", ["none", "daily",
"weekly", "monthly", "custom"])` — Notted.md "Daily, Weekly, Monthly,
    Custom (cron expression)" mapped to a queryable enum; default `none`.
  - `task_statuses` table: `id`; `workspace_id` (→ `workspaces.id` CASCADE,
    notNull); `project_id` (→ `projects.id` CASCADE, nullable — NULL =
    workspace-wide, non-NULL = project-scoped); `name` (varchar 50,
    notNull); `color` (varchar 7, default `#6b7280` — mirrors Part 16
    `tags.color`); `sort_order` (double precision default 0, notNull);
    `is_built_in` (boolean default false, notNull — reserved for the
    optional Part 20 seed of the four built-ins and the service's built-in-
    protection rule); `created_at`/`updated_at` (timestamptz defaultNow,
    notNull). Indexes: `task_statuses_workspace_project_name_unique`
    (UNIQUE `(workspace_id, project_id, name)` — accepts PostgreSQL NULL
    distinctness; service additionally enforces workspace-level name
    uniqueness when `project_id IS NULL`); `task_statuses_workspace_project_idx`
    (`(workspace_id, project_id)` — list statuses for project X or
    workspace-wide). NO `created_by_id` (custom statuses are workspace/
    project-level resources, like Part 16 `tags`).
  - `tasks` table: `id`; `workspace_id` (→ `workspaces.id` CASCADE,
    notNull); `note_id` (→ `notes.id` CASCADE, nullable — optional link to
    the `note_type = 'task'` task-list note that owns this task);
    `project_id` (nullable — composite FK below for cross-tenant
    integrity); `title` (varchar 500, notNull); `description` (text,
    nullable — plain text, NOT TipTap JSON, mirroring Part 16
    `comments.content`); `status` (`task_status` default `todo`, notNull);
    `custom_status_id` (→ `task_statuses.id` SET NULL, nullable — overrides
    `status` for rendering when set); `priority` (`task_priority` default
    `low`, notNull); `assignee_id` (→ `users.id` SET NULL, nullable);
    `due_date` (timestamptz, nullable — folds date + optional time);
    `completed_at` (timestamptz, nullable — set when the effective status
    transitions into a terminal state); `parent_id` (→ `tasks.id` self-ref
    CASCADE, nullable — nested tasks); `sort_order` (double precision
    default 0, notNull — mirrors Part 15 `notes.sort_order`); `recurrence`
    (`task_recurrence` default `none`, notNull); `recurrence_cron` (text,
    nullable — optional 5-field cron expression); `created_by_id` (→
    `users.id` RESTRICT, notNull); `updated_by_id` (→ `users.id` SET NULL,
    nullable); `created_at`/`updated_at` (timestamptz defaultNow, notNull).
    Indexes (9): `tasks_workspace_id_idx`, `tasks_workspace_status_idx`
    (board view / list grouped by status), `tasks_workspace_assignee_idx`
    ("My Tasks" dashboard), `tasks_workspace_due_date_idx` (calendar/overdue
    lookup), `tasks_workspace_project_idx` ("tasks in project X"),
    `tasks_note_id_idx` ("tasks in task-list note X"),
    `tasks_parent_id_idx` (nested subtask lookup), `tasks_assignee_id_idx`
    (cross-workspace "tasks assigned to user X" admin view),
    `tasks_created_by_id_idx`. Composite FK `tasks_workspace_project_fk`
    (`(workspace_id, project_id) → projects(workspace_id, id)`, ON DELETE
    NO ACTION — mirrors `notes_workspace_project_fk`; service nullifies
    `tasks.project_id` before deleting a project).
  - `task_tags` junction table: `task_id` (→ `tasks.id` CASCADE, notNull),
    `tag_id` (→ `tags.id` CASCADE, notNull). COMPOSITE PRIMARY KEY on
    `(task_id, tag_id)` via `primaryKey({ columns: [t.taskId, t.tagId] })`
    (mirrors Part 16 `note_tags`); NO synthetic `id` PK. Index
    `task_tags_tag_id_idx` on `tag_id` serves the "tasks with tag X"
    reverse lookup (the PK's leftmost `task_id` prefix already covers the
    forward "tags on task X" lookup).
  - Forward relations: `taskStatusesRelations` (`workspace`, `project`
    with `relationName`, `tasks` many), `tasksRelations` (`workspace`,
    `note`, `project`, `customStatus`, `assignee`/`createdBy`/`updatedBy`
    to `users` with disambiguating `relationName`s, `parent`/`children`
    self with `relationName: "tasks_parent"`, `taskTags` many), and
    `taskTagsRelations` (`task`, `tag`).
- Appended every Part 17 table, relation, and enum to the aggregate `schema`
  object in `apps/api/src/database/schema/index.ts` and re-exported each by
  name. The existing Part 12–16 entries and the `Schema = typeof schema` type
  are preserved; a `// Part 17 — …` comment marks the new block.
- Generated migration `apps/api/src/database/migrations/0005_slim_rick_jones.sql`
  via `pnpm db:generate`, plus its snapshot (`meta/0005_snapshot.json`) and a
  new journal entry (`idx: 5`, `tag: 0005_slim_rick_jones`) in
  `meta/_journal.json` (the journal previously ended at `idx: 4`). Prior
  migrations (`0000_enable_extensions.sql`, `0001_volatile_wiccan.sql`,
  `0002_minor_mad_thinker.sql`, `0003_cute_maria_hill.sql`,
  `0004_outgoing_catseye.sql`), their snapshots, and the pre-Part-17 journal
  entries were NOT edited.
- Reviewed the generated SQL (see Verification Evidence): three enums, three
  tables, twelve foreign keys (cascade/restrict/set-null + one composite NO
  ACTION), the `task_tags_task_id_tag_id_pk` composite PRIMARY KEY declared
  inline in `CREATE TABLE`, the `task_statuses_workspace_project_name_unique`
  unique index, and twelve lookup indexes. No review-time reorder was
  needed: `task_statuses` is declared before `tasks` in the schema so the
  `tasks.custom_status_id → task_statuses.id` FK is resolvable, and the only
  composite FOREIGN KEY (`tasks_workspace_project_fk`) references
  `projects(workspace_id, id)` whose unique index
  (`projects_workspace_id_id_unique`) already exists from Part 15.
- Added `apps/api/test/tasks-schema.test.ts` with:
  - A no-database unit suite: the barrel exposes the three new tables, three
    relation objects, and three enums; the enums have the expected values;
    `task_tags` has a composite PK `(task_id, tag_id)` with NO synthetic `id`
    and neither column is a single-column PK; `tasks` carries the full
    standalone-task column set with correct nullability (workspace/title/
    status/priority/sort_order/recurrence/created_by NOT NULL; note/project/
    description/custom_status/assignee/due_date/completed_at/parent/cron/
    updated_by nullable); `task_statuses` carries the workspace/project
    scoping and the unique-name index; all Plan Part 17 lookup indexes exist
    with correct uniqueness (board/calendar/my-tasks/project/note/parent/
    assignee/creator); and every foreign key has the intended `onDelete`
    (cascade on workspace/note/tag/self, restrict on `created_by_id`, set
    null on `custom_status_id`/`assignee_id`/`updated_by_id`, NO ACTION on
    the cross-tenant composite `tasks_workspace_project_fk`, cascade on
    both `task_statuses` FKs).
  - A `DATABASE_URL`-gated live suite (mirroring
    `tags-attachments-comments-versions-schema.test.ts` and
    `notes-projects-schema.test.ts`) that applies migrations and asserts:
    the three tables and three enums exist; (a) ordered/nested tasks work —
    insert parent + two children with monotonic `sort_order`, verify
    ordered retrieval, and verify deleting the parent cascades to its
    subtask subtree via the self-FK CASCADE; (b) progress can be derived —
    insert 6 tasks (2 todo, 1 in_progress, 2 done, 1 canceled) with
    `completed_at` set iff terminal, query the per-status breakdown, and
    compute the "X/Y done" aggregate the service will produce; (c)
    cross-workspace project assignment is rejected by the composite FK
    `tasks_workspace_project_fk` (23503) — with an explicit comment that
    the assignee-membership invariant from Plan Part 17 verify ("reject an
    assignee from another workspace") is a TWO-HOP invariant the service
    enforces in Part 24/47 and is NOT expressible as a single-column DB
    constraint, exactly mirroring the Part 15/16 deferral precedent;
    (d) custom task statuses and the `custom_status_id` override + tag
    links work — insert a workspace-wide custom status, insert a task with
    the override (built-in `status` defaults to `todo` and is persisted
    alongside the override), verify SET NULL fallback on custom-status
    delete, link a tag via `task_tags`, verify duplicate `(task_id, tag_id)`
    is rejected by the composite PK (23505), verify the reverse tag lookup,
    and verify tag deletion cascades to its task_tags assignments. Each
    live test creates deterministic unique fixtures and cleans them up via
    the workspace cascade in a finally block. Uses `isDatabaseReachable` +
    `describe.skipIf(!HAS_DATABASE_URL)` + `skip()`.

## Important Decisions

- **Status design: built-in enum + optional custom override.** `tasks.status`
  is the `task_status` enum `["todo","in_progress","done","canceled"]`
  (default `todo`); `tasks.custom_status_id → task_statuses.id` (nullable,
  SET NULL) is the OPTIONAL override. When `custom_status_id` is set, the
  linked `task_statuses` row determines the task's EFFECTIVE status for
  board/view rendering; otherwise the built-in enum is the effective status.
  This avoids the enum-vs-custom conflict the brief warns about (mutating a
  `pgEnum` to add workspace-specific values is a heavy migration; modeling
  status as a free-form varchar loses type safety on the four universal
  states). The service (Part 24/47) resolves "effective status"
  (`custom_status_id ?? status`) and enforces: the custom status belongs to
  the same workspace (and project when scoped), and built-in enum literal
  names (`todo`, `in_progress`, `done`, `canceled`) are RESERVED as
  `task_statuses.name` values so the two status spaces are disjoint and
  unambiguous.
- **Board columns ARE custom task statuses (no separate `task_columns`
  table).** Notted.md "Board View: Kanban columns (To Do, In Progress, Done,
  Custom)" makes custom statuses and board columns the SAME concept. The
  four built-in enum values back the default columns; workspace/project
  `task_statuses` rows back the "Custom" columns. A separate
  `position`/`boardColumnId` column or `task_columns` table would require
  reconciling two sources of truth for column order/visibility — rejected.
  This is consistent with the status design above.
- **Recurrence modeled as enum + optional cron.** Notted.md "Recurring:
  Daily, Weekly, Monthly, Custom (cron expression)" maps cleanly to a
  queryable `task_recurrence` enum (`none`/`daily`/`weekly`/`monthly`/
  `custom`, default `none`) plus an optional `recurrence_cron` text column
  for the canonical 5-field cron expression (populated when `recurrence =
"custom"` or to override the service-derived schedule for a named recipe).
  Chosen over the alternative `recurrenceRule` jsonb because the enum is
  directly queryable ("show me all weekly recurring tasks") and the brief
  lists cron explicitly. A future part can ADD a `recurrence_rule` jsonb for
  structured extras (interval, byWeekday, ...) without a migration conflict;
  the cron grammar is validated service-side (Part 47) — PostgreSQL CHECK
  constraints cannot validate cron.
- **Due date + time folded into one timestamptz.** `tasks.due_date` is a
  single `timestamp with time zone` column that captures both the date and
  the optional time. Storage is canonical UTC; the service (Part 47) formats
  per the user's timezone for display (Part 47 owns user-tz resolution).
  A separate `due_time` column was rejected: it would require reconciling two
  columns on every write and would lose sub-day precision. Users without a
  time get `00:00:00Z` of their chosen date in their tz (service-normalized).
- **`task_tags` uses a composite PRIMARY KEY `(task_id, tag_id)` with no
  synthetic `id`.** Mirrors the Part 16 `note_tags` pattern exactly. The
  composite PK index also enforces pair uniqueness (23505 on duplicate),
  so no separate unique index. A single-column index on `tag_id` serves the
  "tasks with tag X" reverse lookup; the PK's leftmost `task_id` prefix
  covers the forward lookup.
- **`task_statuses` carries NO `created_by_id`.** Like Part 16 `tags`,
  custom statuses are workspace/project-level resources, not personal
  authored entities. The brief's Part 17 task column list does not specify a
  creator audit for statuses; reusing the Part 14/15 RESTRICT-on-
  `created_by_id` convention would have required inventing a column the brief
  does not specify. Omitted to stay minimal and consistent with the Part 16
  precedent.
- **Unique on `(workspace_id, project_id, name)` accepts NULL distinctness.**
  PostgreSQL treats NULLs as distinct in a UNIQUE index, so two workspace-
  level (project_id NULL) rows with the same name would NOT be rejected by
  this index. The service (Part 24/47) ADDITIONALLY enforces workspace-level
  name uniqueness inside the create/update transaction. A unique-on-
  `COALESCE(project_id, '00000000-...')` expression index was considered and
  rejected: it would diverge from the Part 15/16 unique-index style and
  complicate the snapshot. The service-level rule is sufficient because
  custom-status create/update is a low-frequency admin path. Same trade-off
  the Part 15 `notes_sibling_order_idx` documented for sort-order uniqueness.
- **`tasks.description` is TEXT (plain), NOT TipTap JSON.** A task
  description is short and primarily textual; rendering it through the full
  document schema is overkill. Mirrors the Part 16 `comments.content` choice.
  If rich formatting is needed later, a dedicated mini-schema can be
  introduced via migration; the column TYPE is the contract.
- **Cross-workspace project assignment is rejected at the DB layer via a
  composite FK; assignee-membership is service-enforced.** Mirrors the Part
  15 `notes_workspace_project_fk` precedent exactly: `tasks(workspace_id,
project_id) → projects(workspace_id, id)` ON DELETE NO ACTION (service
  nullifies `tasks.project_id` before deleting a project). Plan Part 17
  verify says "reject assignees from another workspace" — the assignee must
  be an active `workspace_members` row in the task's workspace. That is a
  TWO-HOP invariant the service (Part 24/47) enforces in the assign
  transaction; it is NOT expressible as a single-column DB constraint
  without denormalizing `workspace_id` onto `users` or adding a mutable
  composite FK to `workspace_members(workspace_id, user_id)` (both rejected:
  the membership table is itself mutable and a denormalized constraint would
  race membership revocation). Same precedent as Part 15 `note_shares`/
  `project_access` and Part 16 `note_tags`. The DB-level invariant we CAN
  test (and the live suite does) is the project composite FK.
- **Inline-checklist sync rule: inline TipTap TaskItem nodes do NOT auto-
  become `tasks` rows.** Plan Part 17 explicitly requires "inline checklists
  contribute progress but do not silently become assigned standalone tasks
  unless explicitly converted." Conversion from an inline checklist item to a
  `tasks` row is an EXPLICIT, user-initiated service action (Part 47): the
  service creates the `tasks` row, copies the inline text into `title`,
  optionally links it to its parent note via `note_id`, and removes/anchors
  the source TaskItem node. This table does NOT auto-sync from TipTap; it is
  the canonical record of standalone task items only.
- **`completed_at` lifecycle is persisted here; the transition policy is
  service-side.** The column is set when the effective status transitions
  INTO a terminal state (`done` built-in OR a custom status flagged terminal
  by the service — Part 47 may add a `task_statuses.is_terminal` flag in a
  later part if needed) and cleared on reopen. The live test asserts the
  invariant that `completed_at` is set iff the task is in a terminal state.
- **All `tasks.created_by_id` uses `ON DELETE RESTRICT`; `updated_by_id`,
  `assignee_id`, and `custom_status_id` use SET NULL.** Matches the Part
  14/15/16 audit convention: deleting the creator must not silently drop the
  task or its audit (the service — Part 26 — reassigns before account
  deletion). SET NULL on the optional relations preserves the task while
  clearing the link (last editor, assignee, custom status all fall back
  gracefully — `updated_by_id`/`assignee_id` become NULL, `custom_status_id`
  falls back to the built-in `status` enum).
- **Forward relations only.** `workspacesRelations`, `notesRelations`,
  `projectsRelations`, `usersRelations`, and `tagsRelations` were
  intentionally not extended with back-references, to keep earlier parts
  immutable per the handoff rules. Drizzle supports one-directional
  relations.

## Files and Components

| Path                                                        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/database/schema/tasks.ts`                     | `tasks`, `task_statuses` (custom statuses/board columns), `task_tags` junction (composite PK, no synthetic id), three enums (`task_status`, `task_priority`, `task_recurrence`), and their relations. Documents the status design (built-in enum + custom override), board-column mapping, recurrence model, due-date/time folding, inline-checklist sync rule, cross-workspace composite FK, and the assignee-membership service deferral. |
| `apps/api/src/database/schema/index.ts`                     | Aggregate `schema` barrel now exposes the Part 17 tables, relations, and enums and re-exports each by name. `Schema = typeof schema` preserved.                                                                                                                                                                                                                                                                                             |
| `apps/api/src/database/migrations/0005_slim_rick_jones.sql` | Generated forward migration: three enums, three tables, twelve foreign keys (cascade/restrict/set-null + one composite NO ACTION), the `task_tags_task_id_tag_id_pk` composite PRIMARY KEY, and twelve indexes (one unique — `task_statuses_workspace_project_name_unique`).                                                                                                                                                                |
| `apps/api/src/database/migrations/meta/0005_snapshot.json`  | Generated Drizzle snapshot for migration 0005.                                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/api/src/database/migrations/meta/_journal.json`       | Appended journal entry `idx: 5`, `tag: 0005_slim_rick_jones`.                                                                                                                                                                                                                                                                                                                                                                               |
| `apps/api/test/tasks-schema.test.ts`                        | Unit suite (no DB) + DATABASE_URL-gated live suite asserting tables/enums, the `task_tags` composite PK, `task_statuses` unique constraint, FK cascade behavior, and the four Plan Part 17 verify scenarios (ordered/nested tasks, derived progress, cross-workspace project rejection via composite FK, custom status override + tag links).                                                                                               |

## Database and Data Changes

Migration `0005_slim_rick_jones.sql` is additive only. It creates three enum
types (`task_status`, `task_priority`, `task_recurrence`), three tables
(`task_statuses`, `task_tags`, `tasks`), twelve foreign keys, one composite
PRIMARY KEY (`task_tags_task_id_tag_id_pk` on `task_tags(task_id, tag_id)`),
and twelve indexes (one unique —
`task_statuses_workspace_project_name_unique`; eleven lookup —
`task_statuses_workspace_project_idx`, `task_tags_tag_id_idx`,
`tasks_workspace_id_idx`, `tasks_workspace_status_idx`,
`tasks_workspace_assignee_idx`, `tasks_workspace_due_date_idx`,
`tasks_workspace_project_idx`, `tasks_note_id_idx`, `tasks_parent_id_idx`,
`tasks_assignee_id_idx`, `tasks_created_by_id_idx`).
Foreign-key cascade choices: `tasks.workspace_id` CASCADE (tenant-lifecycle);
`tasks.note_id` CASCADE (source link, not durable ownership); `tasks.parent_id`
self-CASCADE (nested-task subtree); `task_tags.task_id`/`tag_id` CASCADE
(junction edges); `task_statuses.workspace_id` CASCADE;
`task_statuses.project_id` CASCADE (project-scoped statuses removed with the
project, workspace-wide set unaffected); `tasks.custom_status_id` SET NULL
(falls back to built-in `status`); `tasks.assignee_id` SET NULL (assignee
optional); `tasks.updated_by_id` SET NULL (preserves creator audit);
`tasks.created_by_id` RESTRICT (audit convention); `tasks_workspace_project_fk`
composite NO ACTION (service-mediated nullification on project delete,
mirrors `notes_workspace_project_fk`). No data, no seed, no destructive
statement, no extension change. Defaults use PostgreSQL built-ins
(`gen_random_uuid()`, `now()`, enum literals) and require no extension beyond
the Part 12 baseline. The migration is forward-only per project policy;
rollback is a separate reviewed operation. No prior migration, snapshot, or
journal entry was edited by hand.

## API, Configuration, and Operational Changes

None. No routes, contracts, queues, environment variables, ports, feature
flags, or deployment steps were added. Defaults are safe: there is no
anonymous or unauthenticated access, no task/status/tag is auto-created, and
no transport reads these tables yet. The schema is purely structural; Parts
21 (auth), 24 (centralized authorization), 29 (project deletion service),
47 (task service: inline-checklist conversion, recurrence, due-date tz
formatting, assignee-membership, effective-status resolution,
completed-at transitions), and the dashboard/view UI parts wire behavior on
top.

## Security and Tenant-Isolation Notes

- **`tasks.workspace_id` scopes tasks to their workspace**; every lookup
  index has `workspace_id` as its leftmost prefix (or is the cross-workspace
  admin `assignee_id`/`created_by_id` index, which the service still
  authorizes through workspace membership). A bare task UUID never grants
  cross-workspace access because the service always re-checks the row's
  `workspace_id` against the caller's membership.
- **Cross-workspace project assignment is rejected at the DB layer.** The
  composite FK `tasks_workspace_project_fk`
  `(workspace_id, project_id) → projects(workspace_id, id)` makes it
  impossible to persist a task that points at another workspace's project,
  regardless of service bugs. Verified by the live suite (23503 on the
  cross-tenant insert).
- **Assignee-membership is service-enforced (Part 24/47).** The assignee must
  be an active `workspace_members` row in the task's workspace. This is a
  two-hop invariant NOT expressible as a single-column DB constraint; the
  service rejects an out-of-workspace assignee inside the assign
  transaction. Same precedent as Part 15 `note_shares`/`project_access` and
  Part 16 `note_tags`. A guessed assignee UUID does not grant cross-workspace
  access because the service checks membership.
- **Custom task statuses are workspace/project-scoped.** The unique index is
  `(workspace_id, project_id, name)`, so name collisions across workspaces
  are impossible; the service additionally enforces workspace-level name
  uniqueness when `project_id IS NULL` and reserves the four built-in enum
  literals as `task_statuses.name` values.
- **`task_tags` cross-workspace assignment is service-enforced (Part 24/47).**
  The junction does not carry `workspace_id`; a tag from workspace A applied
  to a task in workspace B is a two-hop invariant the service rejects. Same
  as Part 16 `note_tags`.
- **`tasks.note_id` source links do NOT grant access (ADR 0007).** A task
  linked to a task-list note is reachable only through the workspace's task
  service, which authorizes the caller against the workspace; possessing the
  note UUID does not broaden task access.
- **All `tasks.created_by_id` columns are `ON DELETE RESTRICT`** to prevent
  silent loss of audit trails; the service (Part 26) reassigns before account
  deletion. SET NULL on `updated_by_id`/`assignee_id`/`custom_status_id`
  preserves the task while clearing the optional link.
- **No public link sharing, no anonymous read.** Tasks are reachable only
  through the workspace's task service, which inherits workspace
  authorization (Part 24).
- **No secrets, connection strings, tokens, cookies, or signed URLs appear**
  in the schema, migration, tests, or this record. `recurrence_cron` is a
  user-supplied schedule expression, not credentials; `description` is user
  document text, not credentials.

## Verification Evidence

Final verification completed on 2026-07-29.

| Check                   | Result | Notes                                                                                                                             |
| ----------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Migration/schema        | Pass   | `0005_slim_rick_jones.sql` applied and `pnpm db:check` passed.                                                                    |
| Focused task suite      | Pass   | Nested ordering, progress, status override, recurrence fields, task-tag links, and cascades passed live.                          |
| Tenant protection       | Pass   | Cross-workspace project assignment rejected with `23503`; assignee membership remains the documented Part 24/47 policy invariant. |
| Repository quality gate | Pass   | Sequential format, lint, type-check, tests, and build passed.                                                                     |

## Known Limitations and Follow-up Work

- **Assignee-membership is service-enforced (Part 24/47).** The service must
  verify the assignee is an active `workspace_members` row in the task's
  workspace inside the assign transaction; the schema cannot express this
  two-hop invariant as a single-column constraint. Plan Part 17 verify
  "reject assignees from another workspace" is satisfied at the service
  layer in Part 24/47; the DB-level cross-tenant invariant tested here is the
  project composite FK.
- **Inline-checklist → task conversion is Part 47.** This table is the
  canonical record of standalone task items only. TipTap TaskItem nodes do
  NOT auto-sync; conversion is an explicit, user-initiated service action
  that creates the `tasks` row and removes/anchors the source node.
- **Task CRUD, assignment, recurrence expansion, and view queries are
  Part 47.** This part models the data; the task service owns create/update/
  delete, assignee-membership enforcement, effective-status resolution
  (`custom_status_id ?? status`), completed-at transitions, recurrence next-
  due-date computation, cron validation, and due-date timezone formatting.
- **Board/calendar/list view rendering is Part 47 + the dashboard UI parts.**
  The schema provides the queryable indexes (`tasks_workspace_status_idx`
  for board, `tasks_workspace_due_date_idx` for calendar/overdue,
  `tasks_workspace_assignee_idx` for "My Tasks"); the views are built on top.
- **Project deletion nullification is Part 29.** The composite FK uses
  `ON DELETE NO ACTION`, so the service must nullify `tasks.project_id` for
  the project's tasks in the same transaction before deleting the project
  (mirrors the `notes_workspace_project_fk` contract). Built-in status enum
  extensions (adding new built-ins) require a reviewed migration that
  updates both the enum and any seed rows; this is intentionally not
  supported at runtime.
- **`completed_at` transition policy is service-side (Part 47).** The column
  is persisted here; WHEN to set/clear it (effective-status transition into
  a terminal state) is service logic. If "terminal" needs to be encoded on
  custom statuses (so a custom "Closed" status also sets `completed_at`),
  Part 47 adds a `task_statuses.is_terminal` boolean via a new migration.
- **Custom-status name uniqueness for workspace-wide rows is service-side
  (Part 24/47).** The UNIQUE index accepts NULL distinctness on `project_id`,
  so two workspace-level rows with the same name are not DB-rejected; the
  service enforces this in the create/update transaction.
- **Retention/purge of canceled/deleted tasks is Part 19.** This part does
  not model a soft-delete column; if task trash/restore becomes a
  requirement, a later part adds `is_deleted`/`deleted_at` mirroring
  `notes`.

## Handoff Notes

- Never edit prior migrations `0000_enable_extensions.sql`,
  `0001_volatile_wiccan.sql`, `0002_minor_mad_thinker.sql`,
  `0003_cute_maria_hill.sql`, `0004_outgoing_catseye.sql`, their snapshots,
  or the pre-Part-17 journal entries. Forward-only corrections use a new
  migration.
- Migration `0005_slim_rick_jones.sql` and its snapshot are now immutable;
  any later task/status/tag schema change must use a new generated forward
  migration and update the schema barrel.
- Later schema parts import `tasks`, `taskStatuses`, `taskTags` from the
  barrel (or via the `tasks.ts` module). Part 18 (operations/integration)
  references tasks where needed (e.g. audit logs, exports, AI usage); it
  must not duplicate the standalone-task model.
- The RESTRICT constraint on `tasks.created_by_id` means any Part 21/26
  user-deletion path must handle creators of tasks (transfer or reassign
  before account deletion), alongside the Part 14/15/16 creators.
- `task_tags` has NO `id` column and NO `created_at`; any code expecting a
  synthetic row id must use the composite `(task_id, tag_id)` key instead.
- The `tasks.parent_id` self-CASCADE means deleting a parent task destroys
  its subtask subtree. If "soft delete a task tree" is later required, a
  soft-delete column must be added in a later part; today the cascade is
  hard.
- The `tasks_workspace_project_fk` composite FK uses `ON DELETE NO ACTION`:
  any service code that deletes a project MUST nullify `tasks.project_id`
  for the project's tasks in the same transaction before the delete, or the
  FK violation aborts the transaction. Mirrors `notes_workspace_project_fk`.
- The effective-status resolution rule is `custom_status_id ?? status`:
  Part 47 must implement this in every read path that surfaces a status to
  the UI, and must enforce the disjoint-names invariant (custom statuses
  may not reuse `todo`/`in_progress`/`done`/`canceled` as `name`).
- When running the live suite locally, ensure `DATABASE_URL` points at a
  disposable dev PostgreSQL (the dev compose stack from Part 9). The live
  suite applies migrations and creates/cleans up its own deterministic
  fixtures via the workspace cascade, but run it against a fresh database or
  after `infra:reset:dev` for a clean state.

## Revision History

| Date       | Author                      | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-07-28 | `backend-platform-engineer` | Initial Part 17 record: added tasks + task_statuses (custom columns/board columns) + task_tags (composite PK) schema with three enums, generated migration `0005_slim_rick_jones.sql`, and unit + live test suites. Status design (built-in enum + optional custom override), recurrence model (enum + optional cron), cross-workspace composite FK, and assignee-membership service deferral documented. Status left `In progress` pending reviewer verification. |
| 2026-07-29 | Lead                        | Completed live task/status/recurrence/tag/composite-FK checks and all sequential repository gates; marked Part 17 Complete.                                                                                                                                                                                                                                                                                                                                        |
