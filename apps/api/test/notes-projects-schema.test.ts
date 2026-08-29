import { resolve } from "node:path";

import { isTable, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  folders,
  foldersRelations,
  noteSharePermissionEnum,
  noteShares,
  noteSharesRelations,
  noteTypeEnum,
  notes,
  notesRelations,
  projectAccess,
  projectAccessRelations,
  projectAccessRoleEnum,
  projectStatusEnum,
  projects,
  projectsRelations,
  schema,
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
const PG_FOREIGN_KEY_VIOLATION = "23503";
const PG_UNIQUE_VIOLATION = "23505";

// ----------------------------------------------------------------------------
// Unit tests: schema shape, columns, indexes, enums, and relations. These run
// without a database because they only inspect Drizzle metadata declared in
// TypeScript.
// ----------------------------------------------------------------------------

describe("projects, notes, hierarchy, and ordering schema (unit)", () => {
  it("exposes the Part 15 tables, enums, and relations in the schema barrel", () => {
    expect(isTable(schema.projects)).toBe(true);
    expect(isTable(schema.projectAccess)).toBe(true);
    expect(isTable(schema.folders)).toBe(true);
    expect(isTable(schema.notes)).toBe(true);
    expect(isTable(schema.noteShares)).toBe(true);

    for (const rel of [
      schema.projectsRelations,
      schema.projectAccessRelations,
      schema.foldersRelations,
      schema.notesRelations,
      schema.noteSharesRelations,
    ]) {
      expect(isRelationsObject(rel)).toBe(true);
    }
  });

  it("exports each Part 15 table, relation, and enum by name", () => {
    expect(projects).toBe(schema.projects);
    expect(projectAccess).toBe(schema.projectAccess);
    expect(folders).toBe(schema.folders);
    expect(notes).toBe(schema.notes);
    expect(noteShares).toBe(schema.noteShares);

    expect(projectsRelations).toBe(schema.projectsRelations);
    expect(projectAccessRelations).toBe(schema.projectAccessRelations);
    expect(foldersRelations).toBe(schema.foldersRelations);
    expect(notesRelations).toBe(schema.notesRelations);
    expect(noteSharesRelations).toBe(schema.noteSharesRelations);

    expect(projectStatusEnum).toBe(schema.projectStatusEnum);
    expect(projectAccessRoleEnum).toBe(schema.projectAccessRoleEnum);
    expect(noteTypeEnum).toBe(schema.noteTypeEnum);
    expect(noteSharePermissionEnum).toBe(schema.noteSharePermissionEnum);
  });

  it("declares the Part 15 enums with the expected values", () => {
    expect(projectStatusEnum.enumName).toBe("project_status");
    expect(projectStatusEnum.enumValues).toEqual(["active", "archived", "completed"]);

    expect(projectAccessRoleEnum.enumName).toBe("project_access_role");
    expect(projectAccessRoleEnum.enumValues).toEqual(["admin", "editor", "viewer"]);

    expect(noteTypeEnum.enumName).toBe("note_type");
    expect(noteTypeEnum.enumValues).toEqual(["document", "task"]);

    expect(noteSharePermissionEnum.enumName).toBe("note_share_permission");
    expect(noteSharePermissionEnum.enumValues).toEqual(["view", "comment", "edit"]);
  });

  it("declares the projects table with the brief's columns", () => {
    const cols = new Map(getTableConfig(projects).columns.map((c) => [c.name, c]));

    expect(primaryKeyColumns(projects)).toContainEqual(["id"]);
    expect(cols.get("workspace_id")?.notNull).toBe(true);
    expect(cols.get("name")?.notNull).toBe(true);
    expect(cols.get("description")?.notNull).toBe(false);
    expect(cols.get("cover_image_url")?.notNull).toBe(false);
    expect(cols.get("color")?.notNull).toBe(false);
    expect(cols.get("status")?.notNull).toBe(true);
    expect(cols.get("due_date")?.notNull).toBe(false);
    expect(cols.get("is_archived")?.notNull).toBe(true);
    expect(cols.get("is_restricted")?.notNull).toBe(true);
    expect(cols.get("created_by_id")?.notNull).toBe(true);
    expect(cols.get("created_at")?.notNull).toBe(true);
    expect(cols.get("updated_at")?.notNull).toBe(true);
  });

  it("declares the folders table with self-nesting and workspace scoping", () => {
    const cols = new Map(getTableConfig(folders).columns.map((c) => [c.name, c]));

    expect(primaryKeyColumns(folders)).toContainEqual(["id"]);
    expect(cols.get("workspace_id")?.notNull).toBe(true);
    // parent_id is nullable (root folders) and self-references folders.id.
    expect(cols.get("parent_id")?.notNull).toBe(false);
    expect(cols.get("name")?.notNull).toBe(true);
    expect(cols.get("created_by_id")?.notNull).toBe(true);
  });

  it("declares the notes table with the brief's columns and Part 15 extensions", () => {
    const cols = new Map(getTableConfig(notes).columns.map((c) => [c.name, c]));

    // Brief core.
    expect(primaryKeyColumns(notes)).toContainEqual(["id"]);
    expect(cols.get("workspace_id")?.notNull).toBe(true);
    expect(cols.get("project_id")?.notNull).toBe(false);
    expect(cols.get("parent_id")?.notNull).toBe(false);
    expect(cols.get("title")?.notNull).toBe(true);
    expect(cols.get("content")?.notNull).toBe(true);
    expect(cols.get("content_plain")?.notNull).toBe(false);
    expect(cols.get("version")?.notNull).toBe(true);
    expect(cols.get("page_size")?.notNull).toBe(true);
    expect(cols.get("created_by_id")?.notNull).toBe(true);
    expect(cols.get("updated_by_id")?.notNull).toBe(false);

    // Part 15 additions per Plan/ADR 0007.
    for (const name of [
      "folder_id",
      "note_type",
      "is_template",
      "is_pinned",
      "is_archived",
      "is_deleted",
      "deleted_at",
      "deletion_batch_id",
      "sort_order",
    ]) {
      expect(cols.has(name), `notes.${name}`).toBe(true);
    }

    // Soft-delete + ordering columns.
    expect(cols.get("is_deleted")?.notNull).toBe(true);
    expect(cols.get("deleted_at")?.notNull).toBe(false);
    expect(cols.get("deletion_batch_id")?.notNull).toBe(false);
    expect(cols.get("sort_order")?.notNull).toBe(true);
    expect(cols.get("is_template")?.notNull).toBe(true);
  });

  it("declares the project_access and note_shares tables per ADR 0007", () => {
    const paCols = new Map(getTableConfig(projectAccess).columns.map((c) => [c.name, c]));
    for (const name of ["id", "project_id", "user_id", "role", "created_by_id", "created_at"]) {
      expect(paCols.has(name), `project_access.${name}`).toBe(true);
    }
    expect(paCols.get("project_id")?.notNull).toBe(true);
    expect(paCols.get("user_id")?.notNull).toBe(true);
    expect(paCols.get("role")?.notNull).toBe(true);

    const nsCols = new Map(getTableConfig(noteShares).columns.map((c) => [c.name, c]));
    for (const name of ["id", "note_id", "user_id", "permission", "created_by_id", "created_at"]) {
      expect(nsCols.has(name), `note_shares.${name}`).toBe(true);
    }
    expect(nsCols.get("note_id")?.notNull).toBe(true);
    expect(nsCols.get("user_id")?.notNull).toBe(true);
    expect(nsCols.get("permission")?.notNull).toBe(true);
  });

  it("declares the unique indexes for one-grant-per-target and composite-FK targets", () => {
    // project_access: one grant per (project, user).
    expect(indexUniqueness(projectAccess).get("project_access_project_user_unique")).toBe(true);
    // note_shares: one grant per (note, user).
    expect(indexUniqueness(noteShares).get("note_shares_note_user_unique")).toBe(true);
    // Composite-FK targets on projects/folders (redundant with PK but required
    // by PostgreSQL as the composite FK target for notes).
    expect(indexUniqueness(projects).get("projects_workspace_id_id_unique")).toBe(true);
    expect(indexUniqueness(folders).get("folders_workspace_id_id_unique")).toBe(true);
  });

  it("declares the Plan Part 15 lookup indexes", () => {
    // Sibling ordering index (non-unique; uniqueness is service-enforced).
    expect(indexUniqueness(notes).get("notes_sibling_order_idx")).toBe(false);
    // Workspace/project list, recent-active (partial), templates, creators.
    expect(indexUniqueness(notes).get("notes_workspace_project_idx")).toBe(false);
    expect(indexUniqueness(notes).get("notes_workspace_active_updated_idx")).toBe(false);
    expect(indexUniqueness(notes).get("notes_workspace_template_idx")).toBe(false);
    expect(indexUniqueness(notes).get("notes_created_by_id_idx")).toBe(false);
    // Project list/status/creators.
    expect(indexUniqueness(projects).get("projects_workspace_id_idx")).toBe(false);
    expect(indexUniqueness(projects).get("projects_workspace_status_idx")).toBe(false);
    expect(indexUniqueness(projects).get("projects_created_by_id_idx")).toBe(false);
    // Folder tree reads.
    expect(indexUniqueness(folders).get("folders_workspace_parent_idx")).toBe(false);
  });

  it("uses the intended cascade/restrict/set-null behavior on every foreign key", () => {
    const projectFks = fkOnDelete(projects);
    expect(projectFks.get("projects_workspace_id_workspaces_id_fk")).toBe("cascade");
    expect(projectFks.get("projects_created_by_id_users_id_fk")).toBe("restrict");

    const paFks = fkOnDelete(projectAccess);
    expect(paFks.get("project_access_project_id_projects_id_fk")).toBe("cascade");
    expect(paFks.get("project_access_user_id_users_id_fk")).toBe("cascade");
    expect(paFks.get("project_access_created_by_id_users_id_fk")).toBe("restrict");

    const folderFks = fkOnDelete(folders);
    expect(folderFks.get("folders_workspace_id_workspaces_id_fk")).toBe("cascade");
    // Self-reference cascade for subtree deletion.
    expect(folderFks.get("folders_parent_id_folders_id_fk")).toBe("cascade");
    expect(folderFks.get("folders_created_by_id_users_id_fk")).toBe("restrict");

    const noteFks = fkOnDelete(notes);
    expect(noteFks.get("notes_workspace_id_workspaces_id_fk")).toBe("cascade");
    // Self-reference cascade for note hierarchy.
    expect(noteFks.get("notes_parent_id_notes_id_fk")).toBe("cascade");
    expect(noteFks.get("notes_created_by_id_users_id_fk")).toBe("restrict");
    expect(noteFks.get("notes_updated_by_id_users_id_fk")).toBe("set null");
    // Part 49: deleting a board column drops its notes into "No column". SET
    // NULL IS the whole reassignment rule, so this FK is the contract.
    expect(noteFks.get("notes_board_column_id_task_statuses_id_fk")).toBe("set null");
    // Composite cross-tenant FKs use NO ACTION (service-mediated nullification
    // on project/folder delete).
    expect(noteFks.get("notes_workspace_project_fk")).toBe("no action");
    expect(noteFks.get("notes_workspace_folder_fk")).toBe("no action");

    const nsFks = fkOnDelete(noteShares);
    expect(nsFks.get("note_shares_note_id_notes_id_fk")).toBe("cascade");
    expect(nsFks.get("note_shares_user_id_users_id_fk")).toBe("cascade");
    expect(nsFks.get("note_shares_created_by_id_users_id_fk")).toBe("restrict");
  });
});

// ----------------------------------------------------------------------------
// Live migration test (DATABASE_URL-gated). Follows the same skip pattern as
// `database.migration.test.ts` and `workspace-schema.test.ts` so it is inert
// in CI without a database and skips cleanly when dev compose is not running.
// ----------------------------------------------------------------------------

/** Creates deterministic user + workspace + owner membership and returns their ids. */
async function bootstrapTenant(
  db: NodePgDatabase,
  stamp: string,
  label: string,
): Promise<{ userId: string; workspaceId: string }> {
  const email = `p15-${label}-${stamp}@notted.invalid`;
  const slug = `p15-${label}-${stamp}`;

  const user = await db.execute(sql`
    insert into users (email, name) values (${email}, ${`Part15 ${label}`})
    returning id
  `);
  const userId = (user.rows[0] as { id: string }).id;

  const workspace = await db.execute(sql`
    insert into workspaces (name, slug, created_by_id)
    values (${"Part15 " + label}, ${slug}, ${userId})
    returning id
  `);
  const workspaceId = (workspace.rows[0] as { id: string }).id;

  await db.execute(sql`
    insert into workspace_members (workspace_id, user_id, role)
    values (${workspaceId}, ${userId}, 'owner')
  `);

  return { userId, workspaceId };
}

describe.skipIf(!HAS_DATABASE)("projects, notes, hierarchy, and ordering schema (live)", () => {
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

  it("creates the Part 15 tables and enums", async ({ skip }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const tables = (
      await db.execute(sql`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name in ('projects', 'project_access', 'folders', 'notes', 'note_shares')
        order by table_name
      `)
    ).rows as unknown as ReadonlyArray<{ table_name: string }>;

    expect(tables.map((row) => row.table_name)).toEqual([
      "folders",
      "note_shares",
      "notes",
      "project_access",
      "projects",
    ]);

    const enumTypes = (
      await db.execute(sql`
        select t.typname, e.enumlabel
        from pg_type t
        join pg_enum e on t.oid = e.enumtypid
        where t.typname in ('project_status', 'project_access_role', 'note_type', 'note_share_permission')
        order by t.typname, e.enumsortorder
      `)
    ).rows as unknown as ReadonlyArray<{ typname: string; enumlabel: string }>;

    const byType = new Map<string, string[]>();
    for (const row of enumTypes) {
      const list = byType.get(row.typname) ?? [];
      list.push(row.enumlabel);
      byType.set(row.typname, list);
    }
    expect(byType.get("project_status")).toEqual(["active", "archived", "completed"]);
    expect(byType.get("project_access_role")).toEqual(["admin", "editor", "viewer"]);
    expect(byType.get("note_type")).toEqual(["document", "task"]);
    expect(byType.get("note_share_permission")).toEqual(["view", "comment", "edit"]);
  });

  it("inserts project notes, root notes, nested notes, templates, and soft-deleted notes", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const { userId, workspaceId } = await bootstrapTenant(db, stamp, "mix");

    try {
      // A project in the workspace.
      const project = await db.execute(sql`
        insert into projects (workspace_id, name, created_by_id)
        values (${workspaceId}, ${"Project " + stamp}, ${userId})
        returning id
      `);
      const projectId = (project.rows[0] as { id: string }).id;

      // Project note (project_id set).
      const projectNote = await db.execute(sql`
        insert into notes (workspace_id, project_id, title, created_by_id, sort_order)
        values (${workspaceId}, ${projectId}, ${"Project note " + stamp}, ${userId}, 1)
        returning id
      `);
      const projectNoteId = (projectNote.rows[0] as { id: string }).id;

      // Root standalone note (project_id NULL, parent_id NULL, folder_id NULL).
      const rootNote = await db.execute(sql`
        insert into notes (workspace_id, title, created_by_id, sort_order)
        values (${workspaceId}, ${"Root note " + stamp}, ${userId}, 1)
        returning id
      `);
      const rootNoteId = (rootNote.rows[0] as { id: string }).id;

      // Nested child note under the root note (parent_id set, same workspace).
      const childNote = await db.execute(sql`
        insert into notes (workspace_id, parent_id, title, created_by_id, sort_order)
        values (${workspaceId}, ${rootNoteId}, ${"Child note " + stamp}, ${userId}, 1)
        returning id
      `);
      const childNoteId = (childNote.rows[0] as { id: string }).id;

      // Template note (is_template true).
      await db.execute(sql`
        insert into notes (workspace_id, title, created_by_id, is_template, sort_order)
        values (${workspaceId}, ${"Template " + stamp}, ${userId}, true, 1)
      `);

      // Soft-deleted note (is_deleted true, deleted_at set).
      await db.execute(sql`
        insert into notes (workspace_id, title, created_by_id, is_deleted, deleted_at, sort_order)
        values (${workspaceId}, ${"Deleted " + stamp}, ${userId}, true, now(), 1)
      `);

      // Assert the rows are shaped as expected.
      const fetched = await db.execute(sql`
        select id, project_id, parent_id, is_template, is_deleted
        from notes
        where workspace_id = ${workspaceId}
        order by title
      `);
      const rows = fetched.rows as unknown as ReadonlyArray<{
        id: string;
        project_id: string | null;
        parent_id: string | null;
        is_template: boolean;
        is_deleted: boolean;
      }>;

      expect(rows).toHaveLength(5);
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(projectNoteId)?.project_id).toBe(projectId);
      expect(byId.get(projectNoteId)?.parent_id).toBeNull();
      expect(byId.get(rootNoteId)?.project_id).toBeNull();
      expect(byId.get(rootNoteId)?.parent_id).toBeNull();
      expect(byId.get(childNoteId)?.parent_id).toBe(rootNoteId);
      expect(rows.filter((r) => r.is_template).length).toBe(1);
      expect(rows.filter((r) => r.is_deleted).length).toBe(1);

      // Cascade: deleting the parent root note removes its child.
      await db.execute(sql`delete from notes where id = ${rootNoteId}`);
      const afterCascade = await db.execute(
        sql`select id from notes where workspace_id = ${workspaceId}`,
      );
      expect((afterCascade.rows as unknown as { id: string }[]).map((r) => r.id)).not.toContain(
        childNoteId,
      );
    } finally {
      // Workspace cascade removes projects, notes, etc. The user is then
      // deletable because no shared tenant row references it (RESTRICT).
      await db.execute(sql`delete from workspaces where id = ${workspaceId}`);
      await db.execute(sql`delete from users where id = ${userId}`);
    }
  });

  it("stores and orders notes by sort_order within a sibling group", async ({ skip }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const { userId, workspaceId } = await bootstrapTenant(db, stamp, "order");

    try {
      // Three root notes with explicit fractional sort_order values (double
      // precision supports midpoint insertion).
      await db.execute(sql`
        insert into notes (workspace_id, title, created_by_id, sort_order)
        values (${workspaceId}, ${"C " + stamp}, ${userId}, 2.0)
      `);
      await db.execute(sql`
        insert into notes (workspace_id, title, created_by_id, sort_order)
        values (${workspaceId}, ${"A " + stamp}, ${userId}, 1.0)
      `);
      await db.execute(sql`
        insert into notes (workspace_id, title, created_by_id, sort_order)
        values (${workspaceId}, ${"B " + stamp}, ${userId}, 1.5)
      `);

      const ordered = await db.execute(sql`
        select title from notes
        where workspace_id = ${workspaceId} and parent_id is null
        order by sort_order asc
      `);
      const titles = (ordered.rows as unknown as { title: string }[]).map((r) => r.title);
      expect(titles).toEqual([`A ${stamp}`, `B ${stamp}`, `C ${stamp}`]);
    } finally {
      await db.execute(sql`delete from workspaces where id = ${workspaceId}`);
      await db.execute(sql`delete from users where id = ${userId}`);
    }
  });

  it("rejects a cross-tenant note whose project belongs to another workspace (composite FK)", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const tenantA = await bootstrapTenant(db, stamp, "xtenant-a");
    const tenantB = await bootstrapTenant(db, stamp, "xtenant-b");

    try {
      // Project in workspace B.
      const projectB = await db.execute(sql`
        insert into projects (workspace_id, name, created_by_id)
        values (${tenantB.workspaceId}, ${"Cross-project " + stamp}, ${tenantB.userId})
        returning id
      `);
      const projectBId = (projectB.rows[0] as { id: string }).id;

      // Attempt to insert a note in workspace A pointing at workspace B's
      // project. The composite FK (workspace_id, project_id) -> projects
      // (workspace_id, id) must reject this: no (A, projectB) row exists.
      await expectPostgresErrorCode(
        db.execute(sql`
          insert into notes (workspace_id, project_id, title, created_by_id)
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

  it("rejects a cross-tenant note whose folder belongs to another workspace (composite FK)", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const tenantA = await bootstrapTenant(db, stamp, "xfolder-a");
    const tenantB = await bootstrapTenant(db, stamp, "xfolder-b");

    try {
      const folderB = await db.execute(sql`
        insert into folders (workspace_id, name, created_by_id)
        values (${tenantB.workspaceId}, ${"Cross-folder " + stamp}, ${tenantB.userId})
        returning id
      `);
      const folderBId = (folderB.rows[0] as { id: string }).id;

      await expectPostgresErrorCode(
        db.execute(sql`
          insert into notes (workspace_id, folder_id, title, created_by_id)
          values (${tenantA.workspaceId}, ${folderBId}, ${"Cross-folder note " + stamp}, ${tenantA.userId})
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

  it("enforces one share per (note, user) and cascades share deletion with the note", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const owner = await bootstrapTenant(db, stamp, "share-owner");
    // A second user in the same workspace to be the grantee.
    const granteeEmail = `p15-share-grantee-${stamp}@notted.invalid`;
    const granteeUser = await db.execute(sql`
      insert into users (email, name) values (${granteeEmail}, ${"Grantee " + stamp})
      returning id
    `);
    const granteeId = (granteeUser.rows[0] as { id: string }).id;

    try {
      await db.execute(sql`
        insert into workspace_members (workspace_id, user_id, role)
        values (${owner.workspaceId}, ${granteeId}, 'editor')
      `);

      const note = await db.execute(sql`
        insert into notes (workspace_id, title, created_by_id)
        values (${owner.workspaceId}, ${"Shared note " + stamp}, ${owner.userId})
        returning id
      `);
      const noteId = (note.rows[0] as { id: string }).id;

      await db.execute(sql`
        insert into note_shares (note_id, user_id, permission, created_by_id)
        values (${noteId}, ${granteeId}, 'edit', ${owner.userId})
      `);

      // Duplicate (note, user) grant is rejected.
      await expectPostgresErrorCode(
        db.execute(sql`
          insert into note_shares (note_id, user_id, permission, created_by_id)
          values (${noteId}, ${granteeId}, 'view', ${owner.userId})
        `),
        PG_UNIQUE_VIOLATION,
      );

      // Deleting the note cascades to its shares.
      await db.execute(sql`delete from notes where id = ${noteId}`);
      const leftover = await db.execute(sql`select id from note_shares where note_id = ${noteId}`);
      expect(leftover.rows).toHaveLength(0);
    } finally {
      await db.execute(sql`delete from workspaces where id = ${owner.workspaceId}`);
      await db.execute(sql`delete from users where id = ${owner.userId}`);
      await db.execute(sql`delete from users where id = ${granteeId}`);
    }
  });

  it("cascades project deletion to project_access and workspace deletion to all tenant rows", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const owner = await bootstrapTenant(db, stamp, "casc");
    const memberEmail = `p15-casc-member-${stamp}@notted.invalid`;
    const memberUser = await db.execute(sql`
      insert into users (email, name) values (${memberEmail}, ${"Member " + stamp})
      returning id
    `);
    const memberId = (memberUser.rows[0] as { id: string }).id;

    try {
      await db.execute(sql`
        insert into workspace_members (workspace_id, user_id, role)
        values (${owner.workspaceId}, ${memberId}, 'editor')
      `);

      const project = await db.execute(sql`
        insert into projects (workspace_id, name, created_by_id)
        values (${owner.workspaceId}, ${"Casc project " + stamp}, ${owner.userId})
        returning id
      `);
      const projectId = (project.rows[0] as { id: string }).id;

      await db.execute(sql`
        insert into project_access (project_id, user_id, role, created_by_id)
        values (${projectId}, ${memberId}, 'editor', ${owner.userId})
      `);

      // Project deletion cascades to its access rows.
      await db.execute(sql`delete from projects where id = ${projectId}`);
      const leftoverAccess = await db.execute(
        sql`select id from project_access where project_id = ${projectId}`,
      );
      expect(leftoverAccess.rows).toHaveLength(0);

      // Create a folder + note, then delete the workspace: everything cascades.
      const folder = await db.execute(sql`
        insert into folders (workspace_id, name, created_by_id)
        values (${owner.workspaceId}, ${"Casc folder " + stamp}, ${owner.userId})
        returning id
      `);
      const folderId = (folder.rows[0] as { id: string }).id;

      // Note: folder_id is set directly here (the composite FK is satisfied
      // because the folder is in the same workspace).
      await db.execute(sql`
        insert into notes (workspace_id, folder_id, title, created_by_id)
        values (${owner.workspaceId}, ${folderId}, ${"Casc note " + stamp}, ${owner.userId})
      `);

      await db.execute(sql`delete from workspaces where id = ${owner.workspaceId}`);

      const notesCount = await db.execute(sql`
        select count(*)::int as c from notes where workspace_id = ${owner.workspaceId}
      `);
      const foldersCount = await db.execute(sql`
        select count(*)::int as c from folders where workspace_id = ${owner.workspaceId}
      `);
      const projectsCount = await db.execute(sql`
        select count(*)::int as c from projects where workspace_id = ${owner.workspaceId}
      `);
      expect((notesCount.rows[0] as { c: number }).c).toBe(0);
      expect((foldersCount.rows[0] as { c: number }).c).toBe(0);
      expect((projectsCount.rows[0] as { c: number }).c).toBe(0);
    } finally {
      await db.execute(sql`delete from workspaces where id = ${owner.workspaceId}`);
      await db.execute(sql`delete from users where id = ${owner.userId}`);
      await db.execute(sql`delete from users where id = ${memberId}`);
    }
  });
});
