// Part 17: tasks, custom task statuses, and task-tag links.
//
// Per Plan Part 17: "Model task-list items separately from TipTap inline
// checklist nodes so due dates, assignees, priority, recurrence, status,
// ordering, and board/calendar views are queryable. Add custom task statuses/
// columns per workspace or project, recurrence configuration, and optional
// tag links. Define synchronization rules: inline checklists contribute
// progress but do not silently become assigned standalone tasks unless
// explicitly converted."
//
// Per ADR 0007 "Standalone tasks": first-class workspace-owned tasks,
// optionally linked to a project/note/checklist source. Assignee and due date
// are optional; status starts `todo`; source links do not grant access. Only
// authorized workspace members can read them.
//
// INLINE-CHECKLIST SYNC RULE (Plan Part 17): a TipTap inline TaskItem node is
// NOT a `tasks` row by itself. Inline checklists contribute PROGRESS counts
// (e.g. "5/12 done") to the parent note's progress indicator but do not
// silently become assigned standalone tasks. Conversion from an inline
// checklist item to a `tasks` row is an EXPLICIT, user-initiated action
// performed by the task service (Part 47): the service creates the `tasks`
// row, copies the inline text into `title`, optionally links it to its
// parent note via `note_id`, and removes/anchors the source TaskItem node.
// This table does NOT auto-sync from TipTap; it is the canonical record of
// standalone task items only.
//
// STATUS DESIGN (built-in enum + optional custom override):
// - `tasks.status` is the BUILT-IN enum `task_status`
//   `["todo","in_progress","done","canceled"]` (default `todo`, notNull). It
//   captures the four universal lifecycle states every workspace starts with
//   and remains the authoritative status when no custom status is assigned.
// - `tasks.custom_status_id -> task_statuses.id` (nullable, SET NULL) is the
//   OPTIONAL override: when set, the linked `task_statuses` row determines the
//   task's EFFECTIVE status for board/view rendering. When NULL, the built-in
//   `status` enum is the effective status. This avoids the enum-vs-custom
//   conflict the brief warns about (mutating a `pgEnum` to add custom values
//   is a heavy migration; modeling status as a free-form varchar loses type
//   safety on the four lifecycle states). The service (Part 24/47) resolves
//   "effective status" (`custom_status_id ?? status`) and enforces:
//     * The custom status belongs to the SAME workspace (and to the SAME
//       project when `task_statuses.project_id` is set).
//     * Built-in enum value NAMES (`todo`, `in_progress`, `done`, `canceled`)
//       are RESERVED: a `task_statuses` row may not use them as `name`, so the
//       two status spaces are disjoint and unambiguous.
// - `completed_at` is set when the effective status transitions INTO a
//   terminal state (`done` built-in OR a `task_statuses` row flagged terminal
//   by the service — Part 47 adds a `is_terminal` flag if needed); this part
//   persists the column and the lifecycle, the policy is service-side.
//
// BOARD/COLUMN MAPPING (deliberate choice): the `task_statuses` table IS the
// board-columns table — there is NO separate `task_columns` table. Notted.md
// "Board View: Kanban columns (To Do, In Progress, Done, Custom)" makes custom
// statuses and board columns the SAME concept. The four built-in enum values
// back the default columns; workspace/project `task_statuses` rows back the
// "Custom" columns. Storing both would require reconciling two sources of
// truth for column order/visibility. A separate `position`/`boardColumnId`
// column is therefore NOT added.
//
// RECURRENCE MODEL (enum + optional cron): Notted.md "Recurring: Daily,
// Weekly, Monthly, Custom (cron expression)". Two columns:
// - `tasks.recurrence` enum `task_recurrence`
//   `["none","daily","weekly","monthly","custom"]` (default `none`, notNull)
//   is the user-facing recipe label, directly queryable ("show me all weekly
//   recurring tasks") and matches the four UI preset buttons + Custom.
// - `tasks.recurrence_cron` (text, nullable) is the optional standard 5-field
//   cron expression used when `recurrence = "custom"` (or to OVERRIDE the
//   service-derived schedule for a named recipe). The service (Part 47)
//   validates the cron shape (no DB-level CHECK — cron grammar validation
//   belongs in the application layer, not PostgreSQL). A structured `jsonb`
//   recurrence rule was considered and rejected in favor of the enum + cron
//   pair: the enum is indexable/queryable and the cron is the canonical
//   machine schedule; a future part can ADD a `recurrence_rule` jsonb for
//   structured extras (interval, byWeekday, ...) without a migration conflict.
//
// DUE DATE / TIME: `tasks.due_date` is a single timestamptz that folds both
// the date and the optional time. Storing UTC is canonical; the service
// (Part 47) formats the value per the user's timezone for display. A separate
// `due_time` column was considered and rejected: it would require reconciling
// two columns on every write and would lose sub-day precision. The editor
// exposes a date picker with an optional time input that together produce one
// timestamptz; users without a time get `00:00:00Z` of their chosen date in
// their tz (the service normalizes — Part 47).
//
// Cross-tenant integrity (composite FK — the "where feasible, composite
// constraints" the Plan calls for, mirroring Part 15 `notes`):
// - `tasks(workspace_id, project_id) -> projects(workspace_id, id)` ensures a
//   task cannot reference another workspace's project at the DB layer. ON
//   DELETE NO ACTION: project deletion is mediated by the service (Part 29),
//   which nullifies `tasks.project_id` for the project's tasks in the same
//   transaction before deleting the project. This mirrors the `notes`->project
//   composite FK choice exactly and preserves the "project deletion keeps
//   tasks alive as standalone" behavior through service coordination.
// - `tasks.workspace_id -> workspaces.id` CASCADE: deleting a workspace
//   removes all of its tasks (the tenant-lifecycle cascade).
// - `tasks.note_id -> notes.id` CASCADE: a task linked to a task-list note is
//   removed with the note. The `note` is an optional source link, NOT an
//   ownership boundary that survives the note (ADR 0007: source links do not
//   grant access; the link is also not durable beyond the source).
// - `tasks.parent_id -> tasks.id` self-CASCADE: deleting a parent task
//   removes its nested subtasks (mirrors `notes`/`comments` self-cascade).
// - `tasks.custom_status_id -> task_statuses.id` SET NULL: deleting a custom
//   status preserves the task and falls back to the built-in `status` enum.
// - `tasks.assignee_id -> users.id` SET NULL: removing a user's account
//   preserves the task and clears the assignee (assignee is optional).
// - `tasks.created_by_id` RESTRICT and `tasks.updated_by_id` SET NULL mirror
//   the Part 14/15/16 audit convention.
//
// ASSIGNEE-MEMBERSHIP IS SERVICE-ENFORCED (Part 24/47). The assignee must be
// an active member of the task's workspace. This is a TWO-HOP invariant (user
// X is a `workspace_members` row in the task's workspace) and is NOT
// expressible as a single-column DB constraint without denormalizing
// `workspace_id` onto the users table or adding a composite FK to
// `workspace_members(workspace_id, user_id)` — both rejected because the
// membership table is itself mutable (role/join changes) and a denormalized
// constraint would race membership revocation. The service rejects an
// out-of-workspace assignee inside the assign transaction. Same precedent as
// Part 15 `note_shares`/`project_access` and Part 16 `note_tags`.
//
// `task_statuses` (custom columns): workspace-scoped, optionally project-
// scoped. A NULL `project_id` means the status is workspace-wide (available
// to every task in the workspace regardless of project); a non-NULL
// `project_id` scopes it to that project's tasks only. `is_built_in` marks
// the four built-in lifecycle states if Part 20 seeds them as rows (today
// the built-ins live only in the `task_status` enum; `is_built_in` is
// reserved for the optional seed path and the service's built-in-protection
// rule). `task_statuses` carries NO `created_by_id`: like `tags`, custom
// statuses are workspace/project-level resources, not personal authored
// entities (Part 16 precedent).
//
// `task_tags` mirrors `note_tags` (Part 16): pure junction, COMPOSITE PRIMARY
// KEY on `(task_id, tag_id)`, NO synthetic `id`, both FKs CASCADE. Cross-
// workspace tag assignment (a tag from workspace A applied to a task in
// workspace B) is a two-hop invariant the service (Part 24/47) enforces in
// the assign transaction; it is NOT expressible as a single-column DB
// constraint (same as `note_tags`).
//
// Conventions (copied from Part 13/14/15/16): see `projects.ts` module
// comment. `primaryKey` (composite), `foreignKey` (composite), and
// `doublePrecision` are imported from `"drizzle-orm/pg-core"`.

import { relations } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  doublePrecision,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { notes } from "./notes";
import { projects } from "./projects";
import { tags } from "./tags";
import { users } from "./users";
import { workspaces } from "./workspaces";

// --------------------------------------------------------------------------- //
// Enums
// --------------------------------------------------------------------------- //
// Built-in task lifecycle status. The four universal states every workspace
// starts with. Custom statuses are modeled in `task_statuses`; when a task has
// `custom_status_id` set, that row overrides this enum for rendering. See the
// module comment for the disjoint-names invariant (custom statuses may not
// reuse these enum literal names).
export const taskStatusEnum = pgEnum("task_status", ["todo", "in_progress", "done", "canceled"]);

// Priority levels. Color mapping (gray/yellow/red/purple) is editor/UI
// concern (Part 47); the column only persists the value. Default `low` is the
// safe fallback for tasks created without an explicit priority.
export const taskPriorityEnum = pgEnum("task_priority", ["low", "medium", "high", "urgent"]);

// Recurrence recipe label. `none` is the default (a non-recurring task). The
// optional `recurrence_cron` column carries the canonical schedule when
// `recurrence = "custom"` or to override the service-derived schedule for a
// named recipe. See module comment for the enum-vs-jsonb trade-off.
export const taskRecurrenceEnum = pgEnum("task_recurrence", [
  "none",
  "daily",
  "weekly",
  "monthly",
  "custom",
]);

// --------------------------------------------------------------------------- //
// task_statuses (custom task statuses / board columns)
// --------------------------------------------------------------------------- //
// Declared BEFORE `tasks` because `tasks.custom_status_id` references it.
// Workspace-scoped; `project_id` NULL = workspace-wide, non-NULL = project-
// scoped. UNIQUE `(workspace_id, project_id, name)` accepts PostgreSQL NULL
// distinctness: two workspace-level (project_id NULL) rows with the same name
// are NOT rejected by this index. The service (Part 24/47) ADDITIONALLY
// enforces workspace-level (project_id IS NULL) name uniqueness inside the
// create/update transaction. A unique-on-COALESCE expression index was
// considered and rejected: it would diverge from the Part 15/16 unique-index
// style and complicate the snapshot. The service-level rule is sufficient
// because custom-status create/update is a low-frequency admin path.

export const taskStatuses = pgTable(
  "task_statuses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    // Project scope. NULL = workspace-wide (available to every task in the
    // workspace regardless of project). CASCADE: deleting the project removes
    // its project-scoped statuses (the workspace-wide set is unaffected).
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    // Custom status name. Unique within (workspace, project) per the index
    // below (with the NULL-distinctness caveat documented above). The service
    // rejects names that collide with the built-in `task_status` enum
    // literals so the two status spaces stay disjoint.
    name: varchar("name", { length: 50 }).notNull(),
    // Hex accent color. The service (Part 24/47) validates the `#rrggbb`
    // shape; the column only constrains length. Default neutral gray, matching
    // the Part 16 `tags.color` convention.
    color: varchar("color", { length: 7 }).default("#6b7280"),
    // Stable ordering for board column / list rendering. Double precision so
    // the service can insert between statuses via midpoint without rewriting
    // the list (mirrors the Part 15 `notes.sort_order` choice). The column
    // default of 0 is the fallback; the service computes `max(sort_order) + 1`
    // at insert time so new statuses append.
    sortOrder: doublePrecision("sort_order").default(0).notNull(),
    // Marks the four built-in statuses IF Part 20 seeds them as rows (today
    // built-ins live only in the `task_status` enum). Reserved for the
    // optional seed path and the service's built-in-protection rule (built-ins
    // cannot be renamed/deleted). Defaults `false` so user-created statuses
    // are distinct.
    isBuiltIn: boolean("is_built_in").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Unique (workspace_id, project_id, name). PostgreSQL NULL distinctness
    // means two workspace-level (project_id NULL) rows with the same name are
    // NOT rejected here; the service additionally enforces workspace-level
    // name uniqueness. See module comment.
    uniqueIndex("task_statuses_workspace_project_name_unique").on(
      t.workspaceId,
      t.projectId,
      t.name,
    ),
    // "List statuses for project X" and "workspace-wide statuses" (the
    // leftmost workspace_id prefix covers both; project_id IS NULL filtering
    // is a scan within the workspace prefix).
    index("task_statuses_workspace_project_idx").on(t.workspaceId, t.projectId),
  ],
);

// --------------------------------------------------------------------------- //
// tasks
// --------------------------------------------------------------------------- //

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    // Optional link to the task-list NOTE (`note_type = 'task'`) that owns
    // this task. CASCADE: deleting the task-list note removes its tasks (the
    // note is a source link, not a durable ownership boundary — ADR 0007).
    // NULL = a standalone task with no task-list note (e.g. a workspace-level
    // "My Tasks" item or a project-level task created directly).
    noteId: uuid("note_id").references(() => notes.id, { onDelete: "cascade" }),
    // Optional project container. NULL = standalone (workspace root, a
    // task-list note, or a child of another standalone task). The composite FK
    // below ensures same-workspace; service-mediated nullification on project
    // delete (mirrors `notes.project_id`).
    projectId: uuid("project_id"),
    title: varchar("title", { length: 500 }).notNull(),
    // Optional rich/long-form description. Plain text (NOT TipTap JSON): a
    // task description is short and primarily textual, matching the Part 16
    // `comments.content` choice. If rich formatting is needed later, a
    // dedicated mini-schema can be introduced via migration.
    description: text("description"),
    // Built-in lifecycle status. Default `todo` per ADR 0007 ("status starts
    // todo"). When `custom_status_id` is set, that row overrides this enum for
    // rendering; this enum remains the safe fallback and the source of truth
    // for the four universal states. See module comment.
    status: taskStatusEnum("status").default("todo").notNull(),
    // Optional custom status override. SET NULL: deleting the custom status
    // preserves the task and falls back to the built-in `status` enum. The
    // service resolves "effective status" as `custom_status_id ?? status`.
    customStatusId: uuid("custom_status_id").references(() => taskStatuses.id, {
      onDelete: "set null",
    }),
    priority: taskPriorityEnum("priority").default("low").notNull(),
    // Assignee. Optional per ADR 0007. SET NULL: removing the user's account
    // clears the assignee but preserves the task. Assignee-MEMBERSHIP (the
    // assignee must be an active member of the task's workspace) is a
    // two-hop invariant enforced by the service (Part 24/47); it is NOT
    // expressible as a single-column DB constraint. See module comment.
    assigneeId: uuid("assignee_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Due date + optional time folded into one timestamptz. Stored as UTC; the
    // service (Part 47) formats per the user's timezone. See module comment.
    dueDate: timestamp("due_date", { withTimezone: true }),
    // Set when the effective status transitions INTO a terminal state. Cleared
    // if the task is reopened. The transition policy is service-side (Part 47).
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Self-reference for nested subtasks. NULL = top-level. CASCADE: deleting
    // a parent task removes its subtree (mirrors `notes`/`comments`/`folders`).
    parentId: uuid("parent_id").references((): AnyPgColumn => tasks.id, {
      onDelete: "cascade",
    }),
    // Stable sibling ordering. Double precision so the service can insert
    // between siblings via midpoint without rewriting the whole list (mirrors
    // `notes.sort_order`). The column default of 0 is the fallback; the
    // service computes `max(sort_order) + 1` at insert time so new tasks
    // append. Uniqueness within a sibling group is enforced transactionally
    // by the service (Part 47) because PostgreSQL NULL distinctness makes a
    // UNIQUE composite index inconsistent between root tasks and nested tasks.
    sortOrder: doublePrecision("sort_order").default(0).notNull(),
    // Recurrence recipe label. `none` = non-recurring. See module comment.
    recurrence: taskRecurrenceEnum("recurrence").default("none").notNull(),
    // Optional standard 5-field cron expression. Populated when
    // `recurrence = "custom"` or to override the service-derived schedule for
    // a named recipe. The service (Part 47) validates the cron shape.
    recurrenceCron: text("recurrence_cron"),
    // Original creator. RESTRICT, matching the Part 14/15/16 convention for
    // shared tenant entities; the service (Part 26) reassigns before the
    // creator account can be removed.
    createdById: uuid("created_by_id")
      .references(() => users.id, { onDelete: "restrict" })
      .notNull(),
    // Last editor. Nullable + SET NULL: deleting the last editor preserves
    // the task and its audit (the creator audit remains). Mirrors
    // `notes.updated_by_id`.
    updatedById: uuid("updated_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // "List tasks in workspace" hot path (leftmost prefix of several below).
    index("tasks_workspace_id_idx").on(t.workspaceId),
    // "Board view" / list grouped by built-in status.
    index("tasks_workspace_status_idx").on(t.workspaceId, t.status),
    // "My Tasks" dashboard for the assignee within a workspace.
    index("tasks_workspace_assignee_idx").on(t.workspaceId, t.assigneeId),
    // "Calendar view" / overdue lookup by due date.
    index("tasks_workspace_due_date_idx").on(t.workspaceId, t.dueDate),
    // "Tasks in project X" lookup (composite leftmost workspace_id prefix).
    index("tasks_workspace_project_idx").on(t.workspaceId, t.projectId),
    // "Tasks in task-list note X" lookup (note_id is nullable so this is a
    // partial-population index; rows with note_id NULL are simply absent).
    index("tasks_note_id_idx").on(t.noteId),
    // Nested-task lookup: "subtasks of parent X".
    index("tasks_parent_id_idx").on(t.parentId),
    // "Tasks assigned to user X" cross-workspace admin view.
    index("tasks_assignee_id_idx").on(t.assigneeId),
    // "Tasks created by user X" admin/authoring view.
    index("tasks_created_by_id_idx").on(t.createdById),
    // Cross-tenant composite FK (see module comment). `onDelete("no action")`
    // is chained explicitly to make the deliberate NO-ACTION-vs-SET-NULL
    // tradeoff visible; the service nullifies `tasks.project_id` before
    // deleting the project. Mirrors `notes_workspace_project_fk`.
    foreignKey({
      name: "tasks_workspace_project_fk",
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }).onDelete("no action"),
  ],
);

// --------------------------------------------------------------------------- //
// task_tags (junction)
// --------------------------------------------------------------------------- //
// Mirrors `note_tags` (Part 16): pure junction, COMPOSITE PRIMARY KEY on
// `(task_id, tag_id)`, NO synthetic `id`. The composite PK also acts as the
// uniqueness guarantee: a duplicate `(task_id, tag_id)` assignment is rejected
// with SQLSTATE 23505 by the PK index, so no separate unique index is needed.
// Both FKs CASCADE: deleting a task removes its tag assignments; deleting a
// tag removes its assignments across tasks. Cross-workspace tag assignment is
// service-enforced (Part 24/47); see module comment.

export const taskTags = pgTable(
  "task_tags",
  {
    taskId: uuid("task_id")
      .references(() => tasks.id, { onDelete: "cascade" })
      .notNull(),
    tagId: uuid("tag_id")
      .references(() => tags.id, { onDelete: "cascade" })
      .notNull(),
  },
  (t) => [
    // Composite primary key. Acts as the uniqueness guarantee for the
    // (task, tag) pair — no separate unique index.
    primaryKey({ columns: [t.taskId, t.tagId] }),
    // "Tasks with tag X" reverse lookup (the PK's leftmost prefix is task_id,
    // which covers the forward "tags on task X" lookup).
    index("task_tags_tag_id_idx").on(t.tagId),
  ],
);

// --------------------------------------------------------------------------- //
// Relations
// --------------------------------------------------------------------------- //
// Forward relations only; `workspacesRelations`, `notesRelations`,
// `projectsRelations`, `usersRelations`, and `tagsRelations` are not extended
// here, to keep Part 13–16 files immutable per the handoff rules. `relationName`
// disambiguates the multiple `users` references on `tasks` (assignee /
// createdBy / updatedBy) and the `tasks` self-reference (parent vs children).

export const taskStatusesRelations = relations(taskStatuses, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [taskStatuses.workspaceId],
    references: [workspaces.id],
  }),
  project: one(projects, {
    fields: [taskStatuses.projectId],
    references: [projects.id],
    relationName: "task_statuses_project",
  }),
  tasks: many(tasks),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [tasks.workspaceId],
    references: [workspaces.id],
  }),
  note: one(notes, {
    fields: [tasks.noteId],
    references: [notes.id],
    relationName: "tasks_note",
  }),
  project: one(projects, {
    fields: [tasks.projectId],
    references: [projects.id],
    relationName: "tasks_project",
  }),
  customStatus: one(taskStatuses, {
    fields: [tasks.customStatusId],
    references: [taskStatuses.id],
    relationName: "tasks_customStatus",
  }),
  assignee: one(users, {
    fields: [tasks.assigneeId],
    references: [users.id],
    relationName: "tasks_assignee",
  }),
  // Self-relation for the nested-task tree.
  parent: one(tasks, {
    fields: [tasks.parentId],
    references: [tasks.id],
    relationName: "tasks_parent",
  }),
  children: many(tasks, { relationName: "tasks_parent" }),
  createdBy: one(users, {
    fields: [tasks.createdById],
    references: [users.id],
    relationName: "tasks_createdBy",
  }),
  updatedBy: one(users, {
    fields: [tasks.updatedById],
    references: [users.id],
    relationName: "tasks_updatedBy",
  }),
  taskTags: many(taskTags),
}));

export const taskTagsRelations = relations(taskTags, ({ one }) => ({
  task: one(tasks, {
    fields: [taskTags.taskId],
    references: [tasks.id],
  }),
  tag: one(tags, {
    fields: [taskTags.tagId],
    references: [tags.id],
  }),
}));
