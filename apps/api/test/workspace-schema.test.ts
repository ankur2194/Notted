import { resolve } from "node:path";

import { isTable, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  invitations,
  invitationsRelations,
  memberRoleEnum,
  schema,
  workspaceMembers,
  workspaceMembersRelations,
  workspacePlanEnum,
  workspaces,
  workspacesRelations,
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

/** PostgreSQL error codes asserted by the live suite. */
const PG_UNIQUE_VIOLATION = "23505";
const PG_INVALID_TEXT_REPRESENTATION = "22P02";

// ----------------------------------------------------------------------------
// Unit tests: schema shape, columns, indexes, enums, and relations. These run
// without a database because they only inspect Drizzle metadata declared in
// TypeScript.
// ----------------------------------------------------------------------------

describe("workspace and membership schema (unit)", () => {
  it("exposes the workspace tables, enums, and relations in the schema barrel", () => {
    expect(isTable(schema.workspaces)).toBe(true);
    expect(isTable(schema.workspaceMembers)).toBe(true);
    expect(isTable(schema.invitations)).toBe(true);

    for (const rel of [
      schema.workspacesRelations,
      schema.workspaceMembersRelations,
      schema.invitationsRelations,
    ]) {
      expect(isRelationsObject(rel)).toBe(true);
    }
  });

  it("exports each workspace table, relation, and enum by name", () => {
    expect(workspaces).toBe(schema.workspaces);
    expect(workspaceMembers).toBe(schema.workspaceMembers);
    expect(invitations).toBe(schema.invitations);

    expect(workspacesRelations).toBe(schema.workspacesRelations);
    expect(workspaceMembersRelations).toBe(schema.workspaceMembersRelations);
    expect(invitationsRelations).toBe(schema.invitationsRelations);

    expect(memberRoleEnum).toBe(schema.memberRoleEnum);
    expect(workspacePlanEnum).toBe(schema.workspacePlanEnum);
  });

  it("declares the member role and workspace plan enums with the expected values", () => {
    expect(memberRoleEnum.enumName).toBe("member_role");
    expect(memberRoleEnum.enumValues).toEqual(["owner", "admin", "editor", "viewer"]);

    expect(workspacePlanEnum.enumName).toBe("workspace_plan");
    expect(workspacePlanEnum.enumValues).toEqual(["free", "pro", "enterprise"]);
  });

  it("declares the workspaces table with the brief's columns", () => {
    const config = getTableConfig(workspaces);
    const cols = new Map(config.columns.map((c) => [c.name, c]));

    expect(primaryKeyColumns(workspaces)).toContainEqual(["id"]);
    expect(cols.get("name")?.notNull).toBe(true);
    expect(cols.get("slug")?.notNull).toBe(true);
    expect(cols.get("description")?.notNull).toBe(false);
    expect(cols.get("logo_url")?.notNull).toBe(false);
    // domain is nullable; uniqueness only applies to non-null values.
    expect(cols.get("domain")?.notNull).toBe(false);
    expect(cols.get("plan")?.notNull).toBe(true);
    expect(cols.get("settings")?.notNull).toBe(true);
    // storage_limit_bytes is an explicit override column and is nullable.
    expect(cols.get("storage_limit_bytes")?.notNull).toBe(false);
    expect(cols.get("created_by_id")?.notNull).toBe(true);
    expect(cols.get("created_at")?.notNull).toBe(true);
    expect(cols.get("updated_at")?.notNull).toBe(true);
  });

  it("declares the workspace_members table with one role per (workspace, user)", () => {
    const config = getTableConfig(workspaceMembers);
    const cols = new Map(config.columns.map((c) => [c.name, c]));

    expect(primaryKeyColumns(workspaceMembers)).toContainEqual(["id"]);
    expect(cols.get("workspace_id")?.notNull).toBe(true);
    expect(cols.get("user_id")?.notNull).toBe(true);
    expect(cols.get("role")?.notNull).toBe(true);
    expect(cols.get("joined_at")?.notNull).toBe(true);
    // The brief uses joinedAt as the membership creation timestamp; no separate
    // created_at/updated_at pair exists on this table.
    expect(cols.has("created_at")).toBe(false);
    expect(cols.has("updated_at")).toBe(false);
  });

  it("declares the invitations table per ADR 0007", () => {
    const config = getTableConfig(invitations);
    const cols = new Map(config.columns.map((c) => [c.name, c]));

    for (const name of [
      "id",
      "workspace_id",
      "email",
      "role",
      "token_hash",
      "invited_by_id",
      "expires_at",
      "accepted_at",
      "accepted_by_id",
      "revoked_at",
      "created_at",
      "updated_at",
    ]) {
      expect(cols.has(name), `invitations.${name}`).toBe(true);
    }

    // Required invitation fields are non-null.
    expect(cols.get("workspace_id")?.notNull).toBe(true);
    expect(cols.get("email")?.notNull).toBe(true);
    expect(cols.get("token_hash")?.notNull).toBe(true);
    expect(cols.get("invited_by_id")?.notNull).toBe(true);
    expect(cols.get("expires_at")?.notNull).toBe(true);
    // Single-use markers are nullable and set by the service on accept/revoke.
    expect(cols.get("accepted_at")?.notNull).toBe(false);
    expect(cols.get("accepted_by_id")?.notNull).toBe(false);
    expect(cols.get("revoked_at")?.notNull).toBe(false);
  });

  it("enforces one membership per user/workspace and indexes the hot paths", () => {
    const indexes = (table: PgTable) =>
      new Map(
        getTableConfig(table).indexes.map((idx) => [idx.config.name ?? "", idx.config.unique]),
      );

    // One membership per (workspace, user).
    expect(indexes(workspaceMembers).get("workspace_members_workspace_user_unique")).toBe(true);
    // "List a user's workspaces" lookup index.
    expect(indexes(workspaceMembers).get("workspace_members_user_id_idx")).toBe(false);

    // Workspace slug and domain uniqueness.
    expect(indexes(workspaces).get("workspaces_slug_unique")).toBe(true);
    expect(indexes(workspaces).get("workspaces_domain_unique")).toBe(true);
    // Creator lookup.
    expect(indexes(workspaces).get("workspaces_created_by_id_idx")).toBe(false);

    // Invitation token is unique (single-use) and lookup indexes exist.
    expect(indexes(invitations).get("invitations_token_hash_unique")).toBe(true);
    expect(indexes(invitations).get("invitations_workspace_id_idx")).toBe(false);
    expect(indexes(invitations).get("invitations_email_idx")).toBe(false);
  });

  it("cascades workspace deletion and restricts creator deletion", () => {
    const fkByName = (table: typeof workspaces | typeof workspaceMembers | typeof invitations) =>
      new Map(getTableConfig(table).foreignKeys.map((key) => [key.getName(), key.onDelete]));

    const wsFks = fkByName(workspaces);
    // created_by_id is RESTRICT: deleting the original creator must not silently
    // destroy a shared tenant entity.
    const createdByFk = [...wsFks.entries()].find(([name]) => name.includes("created_by_id"));
    expect(createdByFk, "workspaces should have a created_by_id foreign key").toBeDefined();
    expect(createdByFk?.[1]).toBe("restrict");

    const memberFks = fkByName(workspaceMembers);
    const memberWorkspaceFk = [...memberFks.entries()].find(([name]) =>
      name.includes("workspace_id"),
    );
    expect(
      memberWorkspaceFk,
      "workspace_members should have a workspace_id foreign key",
    ).toBeDefined();
    expect(memberWorkspaceFk?.[1]).toBe("cascade");
    const memberUserFk = [...memberFks.entries()].find(([name]) => name.includes("user_id"));
    expect(memberUserFk, "workspace_members should have a user_id foreign key").toBeDefined();
    expect(memberUserFk?.[1]).toBe("cascade");

    const invitationFks = fkByName(invitations);
    const invitationWorkspaceFk = [...invitationFks.entries()].find(([name]) =>
      name.includes("workspace_id"),
    );
    expect(
      invitationWorkspaceFk,
      "invitations should have a workspace_id foreign key",
    ).toBeDefined();
    expect(invitationWorkspaceFk?.[1]).toBe("cascade");
    const invitedByFk = [...invitationFks.entries()].find(([name]) =>
      name.includes("invited_by_id"),
    );
    expect(invitedByFk, "invitations should have an invited_by_id foreign key").toBeDefined();
    expect(invitedByFk?.[1]).toBe("cascade");
    const acceptedByFk = [...invitationFks.entries()].find(([name]) =>
      name.includes("accepted_by_id"),
    );
    expect(acceptedByFk, "invitations should have an accepted_by_id foreign key").toBeDefined();
    expect(acceptedByFk?.[1]).toBe("set null");
  });
});

// ----------------------------------------------------------------------------
// Live migration test (DATABASE_URL-gated). Follows the same skip pattern as
// `database.migration.test.ts` and `identity-schema.test.ts` so it is inert in
// CI without a database and skips cleanly when dev compose is not running.
// ----------------------------------------------------------------------------

describe.skipIf(!HAS_DATABASE)("workspace schema (live)", () => {
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

  it("creates the workspace, member, and invitation tables and the two enums", async ({ skip }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const tables = (
      await db.execute(sql`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name in ('workspaces', 'workspace_members', 'invitations')
        order by table_name
      `)
    ).rows as unknown as ReadonlyArray<{ table_name: string }>;

    expect(tables.map((row) => row.table_name)).toEqual([
      "invitations",
      "workspace_members",
      "workspaces",
    ]);

    const enumTypes = (
      await db.execute(sql`
        select t.typname, e.enumlabel
        from pg_type t
        join pg_enum e on t.oid = e.enumtypid
        where t.typname in ('member_role', 'workspace_plan')
        order by t.typname, e.enumsortorder
      `)
    ).rows as unknown as ReadonlyArray<{ typname: string; enumlabel: string }>;

    const byType = new Map<string, string[]>();
    for (const row of enumTypes) {
      const list = byType.get(row.typname) ?? [];
      list.push(row.enumlabel);
      byType.set(row.typname, list);
    }
    expect(byType.get("member_role")).toEqual(["owner", "admin", "editor", "viewer"]);
    expect(byType.get("workspace_plan")).toEqual(["free", "pro", "enterprise"]);
  });

  it("rejects a duplicate (workspace_id, user_id) membership", async ({ skip }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const email = `ws-dup-${stamp}@notted.invalid`;
    const slug = `ws-dup-${stamp}`;

    const user = await db.execute(sql`
      insert into users (email, name) values (${email}, 'Dup Member Test')
      returning id
    `);
    const userId = (user.rows[0] as { id: string }).id;

    const workspace = await db.execute(sql`
      insert into workspaces (name, slug, created_by_id)
      values ('Dup Workspace', ${slug}, ${userId})
      returning id
    `);
    const workspaceId = (workspace.rows[0] as { id: string }).id;

    try {
      await db.execute(sql`
        insert into workspace_members (workspace_id, user_id, role)
        values (${workspaceId}, ${userId}, 'editor')
      `);

      await expectPostgresErrorCode(
        db.execute(sql`
          insert into workspace_members (workspace_id, user_id, role)
          values (${workspaceId}, ${userId}, 'admin')
        `),
        PG_UNIQUE_VIOLATION,
      );
    } finally {
      // Clean up: workspace deletion cascades to memberships; the user can then
      // be deleted because no workspace references it anymore (RESTRICT).
      await db.execute(sql`delete from workspaces where id = ${workspaceId}`);
      await db.execute(sql`delete from users where id = ${userId}`);
    }
  });

  it("rejects an invalid member role enum value", async ({ skip }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const email = `ws-enum-${stamp}@notted.invalid`;
    const slug = `ws-enum-${stamp}`;

    const user = await db.execute(sql`
      insert into users (email, name) values (${email}, 'Enum Role Test')
      returning id
    `);
    const userId = (user.rows[0] as { id: string }).id;

    const workspace = await db.execute(sql`
      insert into workspaces (name, slug, created_by_id)
      values ('Enum Workspace', ${slug}, ${userId})
      returning id
    `);
    const workspaceId = (workspace.rows[0] as { id: string }).id;

    try {
      await expectPostgresErrorCode(
        db.execute(sql`
          insert into workspace_members (workspace_id, user_id, role)
          values (${workspaceId}, ${userId}, 'superadmin')
        `),
        PG_INVALID_TEXT_REPRESENTATION,
      );
    } finally {
      await db.execute(sql`delete from workspaces where id = ${workspaceId}`);
      await db.execute(sql`delete from users where id = ${userId}`);
    }
  });

  it("cascades workspace deletion to members and invitations", async ({ skip }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const email = `ws-casc-${stamp}@notted.invalid`;
    const slug = `ws-casc-${stamp}`;
    const inviteEmail = `invitee-${stamp}@notted.invalid`;
    const tokenHash = `hash-${stamp}`;

    const user = await db.execute(sql`
      insert into users (email, name) values (${email}, 'Cascade Test')
      returning id
    `);
    const userId = (user.rows[0] as { id: string }).id;

    const workspace = await db.execute(sql`
      insert into workspaces (name, slug, created_by_id)
      values ('Cascade Workspace', ${slug}, ${userId})
      returning id
    `);
    const workspaceId = (workspace.rows[0] as { id: string }).id;

    await db.execute(sql`
      insert into workspace_members (workspace_id, user_id, role)
      values (${workspaceId}, ${userId}, 'owner')
    `);
    await db.execute(sql`
      insert into invitations (workspace_id, email, role, token_hash, invited_by_id, expires_at)
      values (${workspaceId}, ${inviteEmail}, 'viewer', ${tokenHash}, ${userId}, now() + interval '7 days')
    `);

    // Sanity: the rows exist before the cascade.
    const beforeMembers = await db.execute(
      sql`select id from workspace_members where workspace_id = ${workspaceId}`,
    );
    const beforeInvitations = await db.execute(
      sql`select id from invitations where workspace_id = ${workspaceId}`,
    );
    expect(beforeMembers.rows).toHaveLength(1);
    expect(beforeInvitations.rows).toHaveLength(1);

    try {
      await db.execute(sql`delete from workspaces where id = ${workspaceId}`);

      const afterMembers = await db.execute(
        sql`select id from workspace_members where workspace_id = ${workspaceId}`,
      );
      const afterInvitations = await db.execute(
        sql`select id from invitations where workspace_id = ${workspaceId}`,
      );
      expect(afterMembers.rows).toHaveLength(0);
      expect(afterInvitations.rows).toHaveLength(0);
    } finally {
      // Workspace is already gone if the test reached this point; clean up the
      // user (now deletable because nothing references it).
      await db.execute(sql`delete from workspaces where id = ${workspaceId}`);
      await db.execute(sql`delete from users where id = ${userId}`);
    }
  });
});
