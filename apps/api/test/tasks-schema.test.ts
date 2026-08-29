import { resolve } from "node:path";

import { isTable, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  schema,
  taskPriorityEnum,
  taskRecurrenceEnum,
  taskStatusEnum,
  taskStatuses,
  taskStatusesRelations,
  taskTags,
  taskTagsRelations,
  tasks,
  tasksRelations,
} from "../src/database/schema";

import {
  expectPostgresErrorCode,
  primaryKeyColumns,
  HAS_DATABASE,
  requireDatabase,
} from "./database-test-helpers";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");

/** True when `value` looks like a Drizzle `Relations` object (config + table). */
function isRelationsObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { config?: unknown }).config === "function" &&
    typeof (value as { table?: unknown }).table === "object"
  );
}

/** Map of index name -> isUnique for a table, via Drizzle metadata. */
function indexUniqueness(table: PgTable): Map<string, boolean> {
  return new Map(
    getTableConfig(table).indexes.map((idx) => [idx.config.name ?? "", idx.config.unique]),
  );
}

/** Map of FK name -> onDelete action for a table, via Drizzle metadata. */
function fkOnDelete(table: PgTable): Map<string, string> {
  return new Map(
    getTableConfig(table).foreignKeys.map((key) => [key.getName(), key.onDelete ?? "no action"]),
  );
}

/** PostgreSQL error codes asserted by the live suite. */
const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";

// ----------------------------------------------------------------------------
// Unit tests: schema shape, columns, indexes, enums, relations, and the
// task_tags composite primary key. These run without a database because they
// only inspect Drizzle metadata declared in TypeScript.
// ----------------------------------------------------------------------------

describe("tasks, task statuses, and task tags schema (unit)", () => {
  it("exposes the Part 17 tables, enums, and relations in the schema barrel", () => {
    expect(isTable(schema.tasks)).toBe(true);
    expect(isTable(schema.taskStatuses)).toBe(true);
    expect(isTable(schema.taskTags)).toBe(true);

    for (const rel of [
      schema.tasksRelations,
      schema.taskStatusesRelations,
      schema.taskTagsRelations,
    ]) {
      expect(isRelationsObject(rel)).toBe(true);
    }
  });

  it("exports each Part 17 table, relation, and enum by name", () => {
    expect(tasks).toBe(schema.tasks);
    expect(taskStatuses).toBe(schema.taskStatuses);
    expect(taskTags).toBe(schema.taskTags);

    expect(tasksRelations).toBe(schema.tasksRelations);
    expect(taskStatusesRelations).toBe(schema.taskStatusesRelations);
    expect(taskTagsRelations).toBe(schema.taskTagsRelations);

    expect(taskStatusEnum).toBe(schema.taskStatusEnum);
    expect(taskPriorityEnum).toBe(schema.taskPriorityEnum);
    expect(taskRecurrenceEnum).toBe(schema.taskRecurrenceEnum);
  });

  it("declares the Part 17 enums with the expected values", () => {
    expect(taskStatusEnum.enumName).toBe("task_status");
    expect(taskStatusEnum.enumValues).toEqual(["todo", "in_progress", "done", "canceled"]);

    expect(taskPriorityEnum.enumName).toBe("task_priority");
    expect(taskPriorityEnum.enumValues).toEqual(["low", "medium", "high", "urgent"]);

    expect(taskRecurrenceEnum.enumName).toBe("task_recurrence");
    expect(taskRecurrenceEnum.enumValues).toEqual(["none", "daily", "weekly", "monthly", "custom"]);
  });

  it("declares tasks with the full standalone-task column set", () => {
    const cols = new Map(getTableConfig(tasks).columns.map((c) => [c.name, c]));
    for (const name of [
      "id",
      "workspace_id",
      "note_id",
      "project_id",
      "title",
      "description",
      "status",
      "custom_status_id",
      "priority",
      "assignee_id",
      "due_date",
      "completed_at",
      "parent_id",
      "sort_order",
      "recurrence",
      "recurrence_cron",
      "created_by_id",
      "updated_by_id",
      "created_at",
      "updated_at",
    ]) {
      expect(cols.has(name), `tasks.${name}`).toBe(true);
    }

    // Required columns are NOT NULL.
    expect(cols.get("workspace_id")?.notNull).toBe(true);
    expect(cols.get("title")?.notNull).toBe(true);
    expect(cols.get("status")?.notNull).toBe(true);
    expect(cols.get("priority")?.notNull).toBe(true);
    expect(cols.get("sort_order")?.notNull).toBe(true);
    expect(cols.get("recurrence")?.notNull).toBe(true);
    expect(cols.get("created_by_id")?.notNull).toBe(true);
    // Optional columns are nullable per ADR 0007 ("assignee and due date
    // optional"; note/project/custom-status/parent/editor/recurrence-cron
    // all optional).
    expect(cols.get("note_id")?.notNull).toBe(false);
    expect(cols.get("project_id")?.notNull).toBe(false);
    expect(cols.get("description")?.notNull).toBe(false);
    expect(cols.get("custom_status_id")?.notNull).toBe(false);
    expect(cols.get("assignee_id")?.notNull).toBe(false);
    expect(cols.get("due_date")?.notNull).toBe(false);
    expect(cols.get("completed_at")?.notNull).toBe(false);
    expect(cols.get("parent_id")?.notNull).toBe(false);
    expect(cols.get("recurrence_cron")?.notNull).toBe(false);
    expect(cols.get("updated_by_id")?.notNull).toBe(false);
  });

  it("declares the Plan Part 17 lookup indexes on tasks (board/calendar/my-tasks)", () => {
    const idx = indexUniqueness(tasks);
    // "List tasks in workspace" hot path.
    expect(idx.get("tasks_workspace_id_idx")).toBe(false);
    // "Board view" / list grouped by built-in status.
    expect(idx.get("tasks_workspace_status_idx")).toBe(false);
    // "My Tasks" dashboard for the assignee within a workspace.
    expect(idx.get("tasks_workspace_assignee_idx")).toBe(false);
    // "Calendar view" / overdue lookup by due date.
    expect(idx.get("tasks_workspace_due_date_idx")).toBe(false);
    // "Tasks in project X" lookup.
    expect(idx.get("tasks_workspace_project_idx")).toBe(false);
    // "Tasks in task-list note X" lookup.
    expect(idx.get("tasks_note_id_idx")).toBe(false);
    // Nested-task lookup: "subtasks of parent X".
    expect(idx.get("tasks_parent_id_idx")).toBe(false);
    // "Tasks assigned to user X" cross-workspace admin view.
    expect(idx.get("tasks_assignee_id_idx")).toBe(false);
    // "Tasks created by user X" admin/authoring view.
    expect(idx.get("tasks_created_by_id_idx")).toBe(false);
  });

  it("declares task_statuses with workspace/project scoping and the unique-name index", () => {
    const cols = new Map(getTableConfig(taskStatuses).columns.map((c) => [c.name, c]));
    for (const name of [
      "id",
      "workspace_id",
      "project_id",
      "name",
      "color",
      "sort_order",
      "is_built_in",
      "created_at",
      "updated_at",
    ]) {
      expect(cols.has(name), `task_statuses.${name}`).toBe(true);
    }

    expect(cols.get("workspace_id")?.notNull).toBe(true);
    expect(cols.get("name")?.notNull).toBe(true);
    expect(cols.get("sort_order")?.notNull).toBe(true);
    expect(cols.get("is_built_in")?.notNull).toBe(true);
    expect(cols.get("project_id")?.notNull).toBe(false);

    // Unique (workspace_id, project_id, name) — Plan Part 17 custom task
    // statuses/columns per workspace or project. Accepts PostgreSQL NULL
    // distinctness on project_id; service additionally enforces workspace-
    // level name uniqueness (documented in tasks.ts module comment).
    expect(indexUniqueness(taskStatuses).get("task_statuses_workspace_project_name_unique")).toBe(
      true,
    );
    // "List statuses for project X" / workspace-wide statuses.
    expect(indexUniqueness(taskStatuses).get("task_statuses_workspace_project_idx")).toBe(false);
  });

  it("declares task_tags with a composite primary key on (task_id, tag_id) and no synthetic id", () => {
    const config = getTableConfig(taskTags);
    const cols = new Map(config.columns.map((c) => [c.name, c]));

    // No synthetic `id` column — Plan Part 17 mirrors the Part 16 note_tags
    // "composite primary keys for junction rows" pattern.
    expect(cols.has("id")).toBe(false);
    expect(cols.get("task_id")?.notNull).toBe(true);
    expect(cols.get("tag_id")?.notNull).toBe(true);
    expect(primaryKeyColumns(taskTags)).toEqual([["task_id", "tag_id"]]);

    // "Tasks with tag X" reverse lookup index.
    expect(indexUniqueness(taskTags).get("task_tags_tag_id_idx")).toBe(false);
  });

  it("uses the intended cascade/restrict/set-null behavior on every foreign key", () => {
    const tFks = fkOnDelete(tasks);
    expect(tFks.get("tasks_workspace_id_workspaces_id_fk")).toBe("cascade");
    // Optional link to the task-list note: deleting the note removes its tasks.
    expect(tFks.get("tasks_note_id_notes_id_fk")).toBe("cascade");
    // Custom status override: deleting the status falls back to built-in.
    expect(tFks.get("tasks_custom_status_id_task_statuses_id_fk")).toBe("set null");
    // Assignee is optional: deleting the user clears the assignee.
    expect(tFks.get("tasks_assignee_id_users_id_fk")).toBe("set null");
    // Nested-task self-cascade: deleting a parent removes its subtree.
    expect(tFks.get("tasks_parent_id_tasks_id_fk")).toBe("cascade");
    // Audit convention (Part 14/15/16): RESTRICT on creator.
    expect(tFks.get("tasks_created_by_id_users_id_fk")).toBe("restrict");
    // Last editor: SET NULL preserves the task and the creator audit.
    expect(tFks.get("tasks_updated_by_id_users_id_fk")).toBe("set null");
    // Cross-tenant composite FK: NO ACTION (service nullifies project_id
    // before deleting the project; mirrors notes_workspace_project_fk).
    expect(tFks.get("tasks_workspace_project_fk")).toBe("no action");

    const tsFks = fkOnDelete(taskStatuses);
    expect(tsFks.get("task_statuses_workspace_id_workspaces_id_fk")).toBe("cascade");
    // Project-scoped statuses are removed with the project; workspace-wide
    // statuses (project_id NULL) are unaffected by any one project delete.
    expect(tsFks.get("task_statuses_project_id_projects_id_fk")).toBe("cascade");

    const ttFks = fkOnDelete(taskTags);
    expect(ttFks.get("task_tags_task_id_tasks_id_fk")).toBe("cascade");
    expect(ttFks.get("task_tags_tag_id_tags_id_fk")).toBe("cascade");
  });
});

// ----------------------------------------------------------------------------
// Live migration test (DATABASE_URL-gated). Follows the same skip pattern as
// `database.migration.test.ts`, `notes-projects-schema.test.ts`, and
// `tags-attachments-comments-versions-schema.test.ts` so it is inert in CI
// without a database and skips cleanly when dev compose is not running. Each
// live test creates deterministic unique fixtures and cleans up via the
// workspace cascade in a finally block.
// ----------------------------------------------------------------------------

/** Creates deterministic user + workspace + owner membership and returns their ids. */
async function bootstrapTenant(
  db: NodePgDatabase,
  stamp: string,
  label: string,
): Promise<{ userId: string; workspaceId: string }> {
  const email = `p17-${label}-${stamp}@notted.invalid`;
  const slug = `p17-${label}-${stamp}`;

  const user = await db.execute(sql`
    insert into users (email, name) values (${email}, ${`Part17 ${label}`})
    returning id
  `);
  const userId = (user.rows[0] as { id: string }).id;

  const workspace = await db.execute(sql`
    insert into workspaces (name, slug, created_by_id)
    values (${"Part17 " + label}, ${slug}, ${userId})
    returning id
  `);
  const workspaceId = (workspace.rows[0] as { id: string }).id;

  await db.execute(sql`
    insert into workspace_members (workspace_id, user_id, role)
    values (${workspaceId}, ${userId}, 'owner')
  `);

  return { userId, workspaceId };
}

describe.skipIf(!HAS_DATABASE)("tasks, task statuses, and task tags schema (live)", () => {
  let pool: Pool | undefined;
  let db: NodePgDatabase | undefined;

  beforeAll(async () => {
    await requireDatabase();
    pool = new Pool({ connectionString: DATABASE_URL as string, max: 1 });
    const database = drizzle(pool);
    db = database;
    await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterAll(async () => {
    if (pool !== undefined) {
      await pool.end().catch(() => {
        /* pool shutdown is best-effort during teardown */
      });
    }
  });

  it("creates the Part 17 tables and enums", async ({ skip }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const tables = (
      await db.execute(sql`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name in ('tasks', 'task_statuses', 'task_tags')
        order by table_name
      `)
    ).rows as unknown as ReadonlyArray<{ table_name: string }>;

    expect(tables.map((row) => row.table_name)).toEqual(["task_statuses", "task_tags", "tasks"]);

    const enumTypes = (
      await db.execute(sql`
        select t.typname, e.enumlabel
        from pg_type t
        join pg_enum e on t.oid = e.enumtypid
        where t.typname in ('task_status', 'task_priority', 'task_recurrence')
        order by t.typname, e.enumsortorder
      `)
    ).rows as unknown as ReadonlyArray<{ typname: string; enumlabel: string }>;

    const byType = new Map<string, string[]>();
    for (const row of enumTypes) {
      const list = byType.get(row.typname) ?? [];
      list.push(row.enumlabel);
      byType.set(row.typname, list);
    }
    expect(byType.get("task_status")).toEqual(["todo", "in_progress", "done", "canceled"]);
    expect(byType.get("task_priority")).toEqual(["low", "medium", "high", "urgent"]);
    expect(byType.get("task_recurrence")).toEqual(["none", "daily", "weekly", "monthly", "custom"]);
  });

  it("(a) supports ordered/nested tasks via parentId self-reference and sortOrder", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const { userId, workspaceId } = await bootstrapTenant(db, stamp, "nested");

    try {
      // Parent task with explicit sort_order (service normally computes
      // max+1; the column default of 0 is the fallback).
      const parent = await db.execute(sql`
        insert into tasks (workspace_id, title, created_by_id, sort_order)
        values (${workspaceId}, ${"Parent " + stamp}, ${userId}, 1.0)
        returning id
      `);
      const parentId = (parent.rows[0] as { id: string }).id;

      // Two child tasks with monotonic sort_order under the parent.
      await db.execute(sql`
        insert into tasks (workspace_id, parent_id, title, created_by_id, sort_order)
        values (${workspaceId}, ${parentId}, ${"Child A " + stamp}, ${userId}, 1.0)
      `);
      await db.execute(sql`
        insert into tasks (workspace_id, parent_id, title, created_by_id, sort_order)
        values (${workspaceId}, ${parentId}, ${"Child B " + stamp}, ${userId}, 2.0)
      `);

      // Ordered retrieval of the parent's children (sort_order ASC).
      const children = await db.execute(sql`
        select title from tasks
        where parent_id = ${parentId}
        order by sort_order asc
      `);
      expect((children.rows as unknown as { title: string }[]).map((r) => r.title)).toEqual([
        `Child A ${stamp}`,
        `Child B ${stamp}`,
      ]);

      // Deleting the parent cascades to its subtask subtree (self-CASCADE).
      await db.execute(sql`delete from tasks where id = ${parentId}`);
      const leftover = await db.execute(sql`select id from tasks where parent_id = ${parentId}`);
      expect(leftover.rows).toHaveLength(0);
    } finally {
      await db.execute(sql`delete from workspaces where id = ${workspaceId}`);
      await db.execute(sql`delete from users where id = ${userId}`);
    }
  });

  it("(b) derives progress counts from a set of tasks by status", async ({ skip }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }
    const liveDb = db;

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const { userId, workspaceId } = await bootstrapTenant(liveDb, stamp, "progress");

    try {
      // 5 tasks: 2 todo, 2 done, 1 canceled. Service writes `completed_at`
      // when transitioning into a terminal state; this test inserts it
      // directly to assert the column persists alongside `status`.
      const insertTask = (status: string, completed: boolean) =>
        liveDb.execute(sql`
          insert into tasks (workspace_id, title, created_by_id, status, completed_at)
          values (
            ${workspaceId}, ${status + " " + stamp}, ${userId},
            ${status}::task_status,
            ${completed ? sql`now()` : sql`null`}
          )
        `);
      await insertTask("todo", false);
      await insertTask("todo", false);
      await insertTask("in_progress", false);
      await insertTask("done", true);
      await insertTask("done", true);
      await insertTask("canceled", true);

      // Progress breakdown by built-in status (the board/list view query).
      const breakdown = await db.execute(sql`
        select status, count(*)::int as c
        from tasks
        where workspace_id = ${workspaceId}
        group by status
        order by status
      `);
      const byStatus = new Map(
        (breakdown.rows as unknown as Array<{ status: string; c: number }>).map((r) => [
          r.status,
          r.c,
        ]),
      );
      expect(byStatus.get("todo")).toBe(2);
      expect(byStatus.get("in_progress")).toBe(1);
      expect(byStatus.get("done")).toBe(2);
      expect(byStatus.get("canceled")).toBe(1);

      // Derived progress: completed (done + canceled) vs total. The
      // Notted.md "5/12 done" indicator is computed by the service from
      // these counts; the schema only persists the per-task state.
      const totals = await db.execute(sql`
        select
          count(*)::int as total,
          count(*) filter (where status in ('done', 'canceled'))::int as terminal,
          count(*) filter (where status = 'done')::int as done
        from tasks
        where workspace_id = ${workspaceId}
      `);
      const row = totals.rows[0] as { total: number; terminal: number; done: number };
      expect(row.total).toBe(6);
      expect(row.terminal).toBe(3);
      expect(row.done).toBe(2);

      // `completed_at` is set iff the task is in a terminal state.
      const mismatchedCompletedAt = await db.execute(sql`
        select count(*)::int as c from tasks
        where workspace_id = ${workspaceId}
          and (
            (status in ('done', 'canceled') and completed_at is null)
            or (status in ('todo', 'in_progress') and completed_at is not null)
          )
      `);
      expect((mismatchedCompletedAt.rows[0] as { c: number }).c).toBe(0);
    } finally {
      await db.execute(sql`delete from workspaces where id = ${workspaceId}`);
      await db.execute(sql`delete from users where id = ${userId}`);
    }
  });

  it("(c) rejects a cross-workspace project assignment via the composite FK", async ({ skip }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const tenantA = await bootstrapTenant(db, stamp, "xproj-a");
    const tenantB = await bootstrapTenant(db, stamp, "xproj-b");

    try {
      // Project in workspace B.
      const projectB = await db.execute(sql`
        insert into projects (workspace_id, name, created_by_id)
        values (${tenantB.workspaceId}, ${"Cross-project " + stamp}, ${tenantB.userId})
        returning id
      `);
      const projectBId = (projectB.rows[0] as { id: string }).id;

      // Attempt to insert a task in workspace A pointing at workspace B's
      // project. The composite FK (workspace_id, project_id) -> projects
      // (workspace_id, id) must reject this: no (A, projectB) row exists.
      //
      // NOTE: assignee-membership ("reject an assignee from another workspace"
      // per Plan Part 17 verify) is a TWO-HOP invariant the service enforces
      // (Part 24/47): the assignee must be an active workspace_members row in
      // the task's workspace. It is NOT expressible as a single-column DB
      // constraint without denormalizing workspace_id onto users or adding a
      // mutable composite FK to workspace_members — both rejected. The
      // DB-level cross-tenant invariant we CAN test is the project composite
      // FK, which mirrors Part 15's `notes_workspace_project_fk` exactly.
      await expectPostgresErrorCode(
        db.execute(sql`
          insert into tasks (workspace_id, project_id, title, created_by_id)
          values (${tenantA.workspaceId}, ${projectBId}, ${"Cross-tenant " + stamp}, ${tenantA.userId})
        `),
        PG_FOREIGN_KEY_VIOLATION,
      );
    } finally {
      await db.execute(sql`delete from workspaces where id = ${tenantA.workspaceId}`);
      await db.execute(sql`delete from workspaces where id = ${tenantB.workspaceId}`);
      await db.execute(sql`delete from users where id = ${tenantA.userId}`);
      await db.execute(sql`delete from users where id = ${tenantB.userId}`);
    }
  });

  it("(d) supports custom task statuses and the custom_status_id override + tag links", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const { userId, workspaceId } = await bootstrapTenant(db, stamp, "custom");

    try {
      // Workspace-wide custom status (project_id NULL).
      const status = await db.execute(sql`
        insert into task_statuses (workspace_id, name, color, sort_order)
        values (${workspaceId}, ${"Blocked " + stamp}, ${"#ef4444"}, 1.0)
        returning id
      `);
      const customStatusId = (status.rows[0] as { id: string }).id;

      // A task using the custom-status override (built-in status defaults to
      // 'todo'; the effective status is the custom row, resolved by the
      // service as `custom_status_id ?? status`).
      const task = await db.execute(sql`
        insert into tasks (workspace_id, title, created_by_id, custom_status_id)
        values (${workspaceId}, ${"Custom-status task " + stamp}, ${userId}, ${customStatusId})
        returning id
      `);
      const taskId = (task.rows[0] as { id: string }).id;

      // Built-in status default + custom override are both persisted.
      const fetched = await db.execute(sql`
        select status, custom_status_id from tasks where id = ${taskId}
      `);
      const row = fetched.rows[0] as { status: string; custom_status_id: string };
      expect(row.status).toBe("todo");
      expect(row.custom_status_id).toBe(customStatusId);

      // Deleting the custom status SET NULL falls back to the built-in enum.
      await db.execute(sql`delete from task_statuses where id = ${customStatusId}`);
      const afterDelete = await db.execute(sql`
        select status, custom_status_id from tasks where id = ${taskId}
      `);
      const after = afterDelete.rows[0] as { status: string; custom_status_id: string | null };
      expect(after.status).toBe("todo");
      expect(after.custom_status_id).toBeNull();

      // Tag link: a workspace tag applied to the task via task_tags.
      const tag = await db.execute(sql`
        insert into tags (workspace_id, name)
        values (${workspaceId}, ${"frontend " + stamp})
        returning id
      `);
      const tagId = (tag.rows[0] as { id: string }).id;

      await db.execute(sql`
        insert into task_tags (task_id, tag_id) values (${taskId}, ${tagId})
      `);

      // Duplicate (task, tag) assignment is rejected by the composite PK.
      await expectPostgresErrorCode(
        db.execute(sql`
          insert into task_tags (task_id, tag_id) values (${taskId}, ${tagId})
        `),
        PG_UNIQUE_VIOLATION,
      );

      // "Tasks with tag X" reverse lookup returns exactly the one task.
      const withTag = await db.execute(sql`
        select task_id from task_tags where tag_id = ${tagId}
      `);
      expect((withTag.rows as unknown as { task_id: string }[]).map((r) => r.task_id)).toEqual([
        taskId,
      ]);

      // Deleting the tag cascades to its task_tags assignments.
      await db.execute(sql`delete from tags where id = ${tagId}`);
      const leftover = await db.execute(sql`select task_id from task_tags where tag_id = ${tagId}`);
      expect(leftover.rows).toHaveLength(0);
    } finally {
      await db.execute(sql`delete from workspaces where id = ${workspaceId}`);
      await db.execute(sql`delete from users where id = ${userId}`);
    }
  });
});
