// Part 19: cross-workspace tenant-isolation tests.
//
// This file is the regression net for ADR 0009's repository-layer tenant-
// protection strategy. It has two suites:
//
// 1. UNIT (no DB): TenantContextService (run/get/tryGet semantics,
//    the deny-by-default get() throw) and the whereWorkspace helper (produces
//    the canonical eq(table.workspaceId, ctx.workspaceId) predicate). These
//    run in every environment.
//
// 2. LIVE (DATABASE_URL-gated): sets up TWO tenants (workspace A + owner,
//    workspace B + owner) and proves:
//    (a) DB-level composite-FK write denial — notes/tasks referencing the
//        OTHER tenant's project/folder reject with SQLSTATE 23503.
//    (b) Read-scope predicates return zero rows from workspace B.
//    (c) Real services, called under tenant A's context with tenant B's ids,
//        answer 404 — never 403, which would confirm the row exists.
//
// Coverage is proved by the tests below, not by a table here. A 30-row prose
// inventory used to sit at this spot claiming which entity was covered where;
// 27 of its rows pointed at a single DATABASE_URL-gated test, so on a machine
// with no stack it documented coverage that had not run — and nothing tied a
// row to a real call site, so it could not go stale loudly.
//
// Global tables (users, account, session, verification, two_factor, passkey,
// job_idempotency) are intentionally NOT workspace-scoped; they are out of
// whereWorkspace's scope by design (see docs/tenant-and-retention.md §1.5).
// Access to global tables is gated by the Part 24 policy layer.

import { resolve } from "node:path";

import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import {
  aiProviderConfig,
  aiUsage,
  apiKeys,
  attachments,
  auditLogs,
  comments,
  emailDeliveries,
  exportJobs,
  folders,
  invitations,
  noteCollaborationStates,
  noteCollaborationUpdates,
  noteEmbeddings,
  noteShares,
  noteTags,
  noteVersions,
  notes,
  projectAccess,
  projects,
  schema,
  tags,
  taskStatuses,
  taskTags,
  tasks,
  webhookDeliveries,
  webhooks,
  workspaceDomains,
  workspaces,
  workspaceMembers,
} from "../src/database/schema";
import { TagsService } from "../src/tags/tags.service";
import { TaskStatusesService } from "../src/tasks/task-statuses.service";
import { TasksService } from "../src/tasks/tasks.service";
import {
  activeWorkspaceId,
  assertActiveWorkspace,
  assertWorkspaceDelete,
  assertWorkspaceInsertValues,
  assertWorkspaceRead,
  assertWorkspaceUpdate,
  createTenantContext,
  TenantContextService,
  TenantError,
  whereWorkspace,
  whereWorkspaceId,
  type TenantContext,
} from "../src/tenant";

import { expectPostgresErrorCode } from "./database-test-helpers";

import type { DatabaseService, DatabaseTransaction } from "../src/database/database.service";
import type { NoteSearchIndexProducer } from "../src/search/note-search-index-producer";
import type { AuthenticatedPrincipal } from "@notted/shared-types";
import type { PgTransactionConfig } from "drizzle-orm/pg-core/session";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");
const CONNECTION_TIMEOUT_MS = 2_000;

const HAS_DATABASE_URL = typeof DATABASE_URL === "string" && DATABASE_URL.trim() !== "";

/** PostgreSQL foreign-key-violation SQLSTATE (composite-FK cross-tenant write). */
const PG_FOREIGN_KEY_VIOLATION = "23503";

// ----------------------------------------------------------------------------
// UNIT: TenantContextService and whereWorkspace — no database required.
// ----------------------------------------------------------------------------

describe("TenantContextService (unit)", () => {
  const service = new TenantContextService();

  it("get() throws a TenantError when no context is set (deny by default)", () => {
    expect(() => service.get()).toThrowError(TenantError);
    expect(() => service.get()).toThrow(/No active tenant context/);
    try {
      service.get();
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "tenant.no_active_context" });
    }
  });

  it("tryGet() returns null when no context is set", () => {
    expect(service.tryGet()).toBeNull();
  });

  it("run() establishes the context for the duration of the callback and returns the result", async () => {
    const ctx = createTenantContext({ workspaceId: "ws-A", userId: "u-1" });
    const result = await service.run(ctx, async () => {
      expect(service.get()).toBe(ctx);
      expect(service.tryGet()).toBe(ctx);
      return 42;
    });
    expect(result).toBe(42);
    // After run returns, the context is no longer active on this chain.
    expect(service.tryGet()).toBeNull();
  });

  it("run() propagates the context across awaited async hops (microtasks and timers)", async () => {
    const ctx = createTenantContext({ workspaceId: "ws-A", userId: "u-1" });
    await service.run(ctx, async () => {
      await Promise.resolve();
      expect(service.get()).toBe(ctx);
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      expect(service.get()).toBe(ctx);
    });
    expect(service.tryGet()).toBeNull();
  });

  it("run() restores the outer context after a nested run completes", async () => {
    const outer = createTenantContext({ workspaceId: "ws-outer", userId: "u-1" });
    const inner = createTenantContext({ workspaceId: "ws-inner", userId: "u-2" });
    await service.run(outer, async () => {
      expect(service.get()).toBe(outer);
      await service.run(inner, async () => {
        expect(service.get()).toBe(inner);
      });
      expect(service.get()).toBe(outer);
    });
  });

  it("run() restores the outer context even if a nested callback rejects", async () => {
    const outer = createTenantContext({ workspaceId: "ws-outer", userId: "u-1" });
    const inner = createTenantContext({ workspaceId: "ws-inner", userId: "u-2" });
    await service.run(outer, async () => {
      await expect(
        service.run(inner, async () => {
          expect(service.get()).toBe(inner);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(service.get()).toBe(outer);
    });
    expect(service.tryGet()).toBeNull();
  });

  it("createTenantContext() freezes the value and defaults userId/requestId to null", () => {
    const ctx = createTenantContext({ workspaceId: "ws-A" });
    expect(ctx.workspaceId).toBe("ws-A");
    expect(ctx.userId).toBeNull();
    expect(ctx.requestId).toBeNull();
    expect(Object.isFrozen(ctx)).toBe(true);
  });
});

describe("whereWorkspace (unit)", () => {
  /** A deterministic workspace id used purely for predicate assertions. */
  const WORKSPACE_A = "11111111-1111-1111-1111-111111111111";

  it("denies predicate construction when there is no active context", () => {
    const tenantContext = new TenantContextService();
    expect(() => activeWorkspaceId(tenantContext)).toThrowError(TenantError);
    expect(() => whereWorkspace(notes, tenantContext)).toThrowError(TenantError);
    expect(() => whereWorkspaceId(workspaces, tenantContext)).toThrowError(TenantError);
  });

  it("builds predicates from the active context for scoped and root tables", async () => {
    const ctx = createTenantContext({ workspaceId: WORKSPACE_A });
    const tenantContext = new TenantContextService();
    const mockDb = drizzle.mock({ schema });

    await tenantContext.run(ctx, async () => {
      expect(activeWorkspaceId(tenantContext)).toBe(WORKSPACE_A);
      const scopedQuery = mockDb
        .select({ id: notes.id })
        .from(notes)
        .where(whereWorkspace(notes, tenantContext))
        .toSQL();
      expect(scopedQuery.sql.toLowerCase()).toContain("workspace_id");
      expect(scopedQuery.params).toContain(WORKSPACE_A);

      const rootQuery = mockDb
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(whereWorkspaceId(workspaces, tenantContext))
        .toSQL();
      expect(rootQuery.sql).toMatch(/\bid\b/i);
      expect(rootQuery.params).toContain(WORKSPACE_A);
    });
  });
});

/*
 * `workspace-scope.ts` is the module every tenant-owned query routes through, so
 * it is worth a direct unit test — but a SMALL one.
 *
 * What stood here was a 29-entity x 4-operation matrix driving a test-local
 * helper whose own comment read "Simulates a direct repository operation". The
 * entity was an inert string label and the "SQL boundary" was a counter object,
 * so all 116 assertions re-proved the same `if (a !== b) throw` through four
 * one-line aliases of `assertActiveWorkspace`. It could not fail for any change
 * to the application, which is exactly the failure it was written to catch: a
 * service that forgets `whereWorkspace` passed it unchanged.
 *
 * The real proof that a service refuses another tenant's rows is a service call
 * against a live database, asserting 404. Those live below.
 */
describe("workspace-scope (unit)", () => {
  const workspaceA = "11111111-1111-4111-8111-111111111111";
  const workspaceB = "22222222-2222-4222-8222-222222222222";

  function inWorkspaceA<T>(fn: (tenantContext: TenantContextService) => T): T {
    const tenantContext = new TenantContextService();
    return tenantContext.run(createTenantContext({ workspaceId: workspaceA }), () =>
      fn(tenantContext),
    );
  }

  it.each([
    ["read", assertWorkspaceRead],
    ["update", assertWorkspaceUpdate],
    ["delete", assertWorkspaceDelete],
  ])("denies a %s of another workspace's row", (_label, assert) => {
    inWorkspaceA((tenantContext) => {
      expect(() => assert(workspaceB, tenantContext, "notes")).toThrowError(TenantError);
      expect(() => assert(workspaceA, tenantContext, "notes")).not.toThrow();
    });
  });

  it.each([[null], [undefined]])("denies a row whose workspace is %s", (missing) => {
    inWorkspaceA((tenantContext) => {
      expect(() => assertWorkspaceRead(missing, tenantContext, "notes")).toThrowError(TenantError);
    });
  });

  it("accepts only the active workspace on insert, and returns the values through", () => {
    inWorkspaceA((tenantContext) => {
      expect(
        assertWorkspaceInsertValues({ workspaceId: workspaceA, title: "safe" }, tenantContext),
      ).toEqual({ workspaceId: workspaceA, title: "safe" });
      expect(() =>
        assertWorkspaceInsertValues({ workspaceId: workspaceB }, tenantContext),
      ).toThrowError(TenantError);
    });
  });

  it("reports a mismatch with a stable code", () => {
    inWorkspaceA((tenantContext) => {
      expect(() => assertActiveWorkspace(workspaceB, tenantContext, "notes")).toThrowError(
        expect.objectContaining({ code: "tenant.workspace_mismatch" }),
      );
    });
  });

  it("refuses to build a predicate with no active context (deny by default)", () => {
    const tenantContext = new TenantContextService();
    expect(() => assertWorkspaceRead(workspaceA, tenantContext, "notes")).toThrowError(TenantError);
  });
});

// ----------------------------------------------------------------------------
// LIVE: DATABASE_URL-gated cross-tenant denial.
// ----------------------------------------------------------------------------

async function isDatabaseReachable(connectionString: string): Promise<boolean> {
  const client = new Client({ connectionString, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS });
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {
      /* connection cleanup is best-effort during the reachability probe */
    });
  }
}

/** Row shape returned by Drizzle's typed `.returning()` for an `id` column. */
type IdRow = { id: string };

/**
 * Bootstrap a deterministic tenant: one user + one workspace + an owner
 * membership. Returns the live DB ids plus a TenantContext scoped to that
 * workspace. Used for both tenant A and tenant B in the live denial tests.
 */
async function bootstrapTenant(
  db: NodePgDatabase<typeof schema>,
  stamp: string,
  label: string,
): Promise<{ userId: string; workspaceId: string; context: TenantContext }> {
  const email = `p19-${label}-${stamp}@notted.invalid`;
  const slug = `p19-${label}-${stamp}`;

  const user = await db.execute(sql`
    insert into users (email, name) values (${email}, ${`Part19 ${label}`})
    returning id
  `);
  const userId = (user.rows[0] as IdRow).id;

  const workspace = await db.execute(sql`
    insert into workspaces (name, slug, created_by_id)
    values (${"Part19 " + label}, ${slug}, ${userId})
    returning id
  `);
  const workspaceId = (workspace.rows[0] as IdRow).id;

  await db.execute(sql`
    insert into workspace_members (workspace_id, user_id, role)
    values (${workspaceId}, ${userId}, 'owner')
  `);

  return {
    userId,
    workspaceId,
    context: createTenantContext({ workspaceId, userId, requestId: `p19-${label}-${stamp}` }),
  };
}

/**
 * Drop both tenants' rows. Workspace CASCADE removes every tenant-owned child;
 * the user rows are then deletable because no RESTRICT link remains.
 */
async function cleanupTenants(
  db: NodePgDatabase<typeof schema>,
  tenants: ReadonlyArray<{ userId: string; workspaceId: string }>,
): Promise<void> {
  for (const tenant of tenants) {
    await db.execute(sql`delete from workspaces where id = ${tenant.workspaceId}`);
  }
  for (const tenant of tenants) {
    await db.execute(sql`delete from users where id = ${tenant.userId}`);
  }
}

describe.skipIf(!HAS_DATABASE_URL)("tenant isolation (live)", () => {
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;
  let reachable = false;

  beforeAll(async () => {
    reachable = await isDatabaseReachable(DATABASE_URL as string);
    if (!reachable) {
      return;
    }
    pool = new Pool({ connectionString: DATABASE_URL as string, max: 1 });
    const database = drizzle(pool, { schema });
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

  // -------------------------------------------------------------------------
  // (a) DB-level composite-FK write denial.
  // -------------------------------------------------------------------------

  it("rejects a cross-tenant note referencing another workspace's project (notes_workspace_project_fk)", async ({
    skip,
  }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const tenantA = await bootstrapTenant(db, stamp, "xw-a");
    const tenantB = await bootstrapTenant(db, stamp, "xw-b");

    try {
      const projectB = await db.execute(sql`
        insert into projects (workspace_id, name, created_by_id)
        values (${tenantB.workspaceId}, ${"Cross-project " + stamp}, ${tenantB.userId})
        returning id
      `);
      const projectBId = (projectB.rows[0] as IdRow).id;

      await expectPostgresErrorCode(
        db.execute(sql`
          insert into notes (workspace_id, project_id, title, created_by_id)
          values (${tenantA.workspaceId}, ${projectBId}, ${"Cross-tenant note " + stamp}, ${tenantA.userId})
        `),
        PG_FOREIGN_KEY_VIOLATION,
      );
    } finally {
      await cleanupTenants(db, [tenantA, tenantB]);
    }
  });

  it("rejects a cross-tenant note referencing another workspace's folder (notes_workspace_folder_fk)", async ({
    skip,
  }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const tenantA = await bootstrapTenant(db, stamp, "xf-a");
    const tenantB = await bootstrapTenant(db, stamp, "xf-b");

    try {
      const folderB = await db.execute(sql`
        insert into folders (workspace_id, name, created_by_id)
        values (${tenantB.workspaceId}, ${"Cross-folder " + stamp}, ${tenantB.userId})
        returning id
      `);
      const folderBId = (folderB.rows[0] as IdRow).id;

      await expectPostgresErrorCode(
        db.execute(sql`
          insert into notes (workspace_id, folder_id, title, created_by_id)
          values (${tenantA.workspaceId}, ${folderBId}, ${"Cross-folder note " + stamp}, ${tenantA.userId})
        `),
        PG_FOREIGN_KEY_VIOLATION,
      );
    } finally {
      await cleanupTenants(db, [tenantA, tenantB]);
    }
  });

  it("rejects a cross-tenant task referencing another workspace's project (tasks_workspace_project_fk)", async ({
    skip,
  }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const tenantA = await bootstrapTenant(db, stamp, "xt-a");
    const tenantB = await bootstrapTenant(db, stamp, "xt-b");

    try {
      const projectB = await db.execute(sql`
        insert into projects (workspace_id, name, created_by_id)
        values (${tenantB.workspaceId}, ${"Cross-project " + stamp}, ${tenantB.userId})
        returning id
      `);
      const projectBId = (projectB.rows[0] as IdRow).id;

      await expectPostgresErrorCode(
        db.execute(sql`
          insert into tasks (workspace_id, project_id, title, created_by_id)
          values (${tenantA.workspaceId}, ${projectBId}, ${"Cross-tenant task " + stamp}, ${tenantA.userId})
        `),
        PG_FOREIGN_KEY_VIOLATION,
      );
    } finally {
      await cleanupTenants(db, [tenantA, tenantB]);
    }
  });

  // -------------------------------------------------------------------------
  // (b) Read-scope predicate: the active workspace predicate returns ZERO rows
  //     from workspace B. One test seeds BOTH tenants then asserts every
  //     major entity scoped to tenant A excludes tenant B's rows.
  // -------------------------------------------------------------------------

  it("scopes every major tenant-owned entity to the active workspace (no cross-tenant reads)", async ({
    skip,
  }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const tenantA = await bootstrapTenant(db, stamp, "scope-a");
    const tenantB = await bootstrapTenant(db, stamp, "scope-b");

    try {
      // ---- Seed tenant A and tenant B symmetrically. -----------------------

      // Projects (needed for tasks and as a project container for notes).
      const projectA = (
        await db
          .insert(projects)
          .values({
            workspaceId: tenantA.workspaceId,
            name: `ProjA ${stamp}`,
            createdById: tenantA.userId,
          })
          .returning({ id: projects.id })
      )[0] as IdRow;
      const projectB = (
        await db
          .insert(projects)
          .values({
            workspaceId: tenantB.workspaceId,
            name: `ProjB ${stamp}`,
            createdById: tenantB.userId,
          })
          .returning({ id: projects.id })
      )[0] as IdRow;

      // Folders.
      const folderA = (
        await db
          .insert(folders)
          .values({
            workspaceId: tenantA.workspaceId,
            name: `FolderA ${stamp}`,
            createdById: tenantA.userId,
          })
          .returning({ id: folders.id })
      )[0] as IdRow;
      const folderB = (
        await db
          .insert(folders)
          .values({
            workspaceId: tenantB.workspaceId,
            name: `FolderB ${stamp}`,
            createdById: tenantB.userId,
          })
          .returning({ id: folders.id })
      )[0] as IdRow;

      // Notes (one per tenant).
      const noteA = (
        await db
          .insert(notes)
          .values({
            workspaceId: tenantA.workspaceId,
            projectId: projectA.id,
            title: `NoteA ${stamp}`,
            createdById: tenantA.userId,
          })
          .returning({ id: notes.id })
      )[0] as IdRow;
      const noteB = (
        await db
          .insert(notes)
          .values({
            workspaceId: tenantB.workspaceId,
            projectId: projectB.id,
            title: `NoteB ${stamp}`,
            createdById: tenantB.userId,
          })
          .returning({ id: notes.id })
      )[0] as IdRow;

      // Tags (unique-per-workspace name).
      const tagA = (
        await db
          .insert(tags)
          .values({ workspaceId: tenantA.workspaceId, name: `tag-a-${stamp}` })
          .returning({ id: tags.id })
      )[0] as IdRow;
      const tagB = (
        await db
          .insert(tags)
          .values({ workspaceId: tenantB.workspaceId, name: `tag-b-${stamp}` })
          .returning({ id: tags.id })
      )[0] as IdRow;

      // Attachments (denormalized workspace_id per Part 16).
      const attachmentAKey = `tenant-a/${stamp}/att-a`;
      const attachmentBKey = `tenant-b/${stamp}/att-b`;
      await db.insert(attachments).values([
        {
          noteId: noteA.id,
          workspaceId: tenantA.workspaceId,
          originalName: `att-a-${stamp}.pdf`,
          filename: `att-a-${stamp}.pdf`,
          mimeType: "application/pdf",
          sizeBytes: 1024,
          storageKey: attachmentAKey,
          createdById: tenantA.userId,
        },
        {
          noteId: noteB.id,
          workspaceId: tenantB.workspaceId,
          originalName: `att-b-${stamp}.pdf`,
          filename: `att-b-${stamp}.pdf`,
          mimeType: "application/pdf",
          sizeBytes: 1024,
          storageKey: attachmentBKey,
          createdById: tenantB.userId,
        },
      ]);

      // Tasks.
      const taskA = (
        await db
          .insert(tasks)
          .values({
            workspaceId: tenantA.workspaceId,
            projectId: projectA.id,
            title: `TaskA ${stamp}`,
            createdById: tenantA.userId,
          })
          .returning({ id: tasks.id })
      )[0] as IdRow;
      const taskB = (
        await db
          .insert(tasks)
          .values({
            workspaceId: tenantB.workspaceId,
            projectId: projectB.id,
            title: `TaskB ${stamp}`,
            createdById: tenantB.userId,
          })
          .returning({ id: tasks.id })
      )[0] as IdRow;

      // Custom task statuses (workspace-scoped board columns).
      await db
        .insert(taskStatuses)
        .values({ workspaceId: tenantA.workspaceId, name: `status-a-${stamp}` });
      await db
        .insert(taskStatuses)
        .values({ workspaceId: tenantB.workspaceId, name: `status-b-${stamp}` });

      // Audit logs (polymorphic entity_id; safe metadata).
      await db.insert(auditLogs).values({
        workspaceId: tenantA.workspaceId,
        userId: tenantA.userId,
        action: "test.create",
        entityType: "note",
        entityId: noteA.id,
        metadata: { stamp },
      });
      await db.insert(auditLogs).values({
        workspaceId: tenantB.workspaceId,
        userId: tenantB.userId,
        action: "test.create",
        entityType: "note",
        entityId: noteB.id,
        metadata: { stamp },
      });

      // API keys (hash-only; stand-in string for the real hash).
      await db.insert(apiKeys).values({
        workspaceId: tenantA.workspaceId,
        createdById: tenantA.userId,
        name: `key-a-${stamp}`,
        keyHash: `sha256-hash-A-${stamp}`,
        keyPrefix: "ntd_pk_a",
      });
      await db.insert(apiKeys).values({
        workspaceId: tenantB.workspaceId,
        createdById: tenantB.userId,
        name: `key-b-${stamp}`,
        keyHash: `sha256-hash-B-${stamp}`,
        keyPrefix: "ntd_pk_b",
      });

      // Webhooks (encrypted secret is a stand-in blob).
      const webhookA = (
        await db
          .insert(webhooks)
          .values({
            workspaceId: tenantA.workspaceId,
            createdById: tenantA.userId,
            url: "https://example.com/hook-a",
            encryptedSecret: `encrypted-blob-A-${stamp}`,
            encryptionKeyVersion: 1,
          })
          .returning({ id: webhooks.id })
      )[0] as IdRow;
      const webhookB = (
        await db
          .insert(webhooks)
          .values({
            workspaceId: tenantB.workspaceId,
            createdById: tenantB.userId,
            url: "https://example.com/hook-b",
            encryptedSecret: `encrypted-blob-B-${stamp}`,
            encryptionKeyVersion: 1,
          })
          .returning({ id: webhooks.id })
      )[0] as IdRow;

      // Custom-domain claims (Part 73). One per workspace; the hostname is
      // globally unique, so both fixtures carry the run stamp.
      await db.insert(workspaceDomains).values({
        workspaceId: tenantA.workspaceId,
        createdById: tenantA.userId,
        hostname: `a-${stamp}.example.com`,
        verificationToken: `token-a-${stamp}`,
        status: "verified",
      });
      await db.insert(workspaceDomains).values({
        workspaceId: tenantB.workspaceId,
        createdById: tenantB.userId,
        hostname: `b-${stamp}.example.com`,
        verificationToken: `token-b-${stamp}`,
        status: "pending",
      });

      // Exports (queued; no object_key yet).
      await db.insert(exportJobs).values({
        workspaceId: tenantA.workspaceId,
        requestedById: tenantA.userId,
        format: "pdf",
        sourceType: "note",
        sourceId: noteA.id,
      });
      await db.insert(exportJobs).values({
        workspaceId: tenantB.workspaceId,
        requestedById: tenantB.userId,
        format: "pdf",
        sourceType: "note",
        sourceId: noteB.id,
      });

      // AI provider config (one per workspace; UNIQUE).
      await db.insert(aiProviderConfig).values({
        workspaceId: tenantA.workspaceId,
        provider: "openai",
        model: "gpt-4o-mini",
        encryptedCredentials: `encrypted-creds-A-${stamp}`,
        encryptionKeyVersion: 1,
        isEnabled: true,
      });
      await db.insert(aiProviderConfig).values({
        workspaceId: tenantB.workspaceId,
        provider: "anthropic",
        model: "claude-3-5-sonnet-latest",
        encryptedCredentials: `encrypted-creds-B-${stamp}`,
        encryptionKeyVersion: 1,
        isEnabled: true,
      });

      // AI usage (append-only, content not retained).
      await db.insert(aiUsage).values({
        workspaceId: tenantA.workspaceId,
        userId: tenantA.userId,
        feature: "summarize",
        provider: "openai",
        model: "gpt-4o-mini",
        status: "success",
      });
      await db.insert(aiUsage).values({
        workspaceId: tenantB.workspaceId,
        userId: tenantB.userId,
        feature: "summarize",
        provider: "anthropic",
        model: "claude-3-5-sonnet-latest",
        status: "success",
      });

      // Email deliveries (workspace-scoped; NULL workspace_id is intentionally
      // out of whereWorkspace's scope and is not seeded here).
      const emailA = `p19-scope-a-${stamp}@notted.invalid`;
      const emailB = `p19-scope-b-${stamp}@notted.invalid`;
      await db.insert(emailDeliveries).values({
        workspaceId: tenantA.workspaceId,
        recipient: emailA,
        templateKey: "test",
      });
      await db.insert(emailDeliveries).values({
        workspaceId: tenantB.workspaceId,
        recipient: emailB,
        templateKey: "test",
      });

      // Comments on each tenant's note (no direct workspace_id; scoped via
      // the parent note's workspace_id in the read assertion below).
      const commentAContent = `CommentA ${stamp}`;
      const commentBContent = `CommentB ${stamp}`;
      await db.insert(comments).values({
        noteId: noteA.id,
        content: commentAContent,
        createdById: tenantA.userId,
      });
      await db.insert(comments).values({
        noteId: noteB.id,
        content: commentBContent,
        createdById: tenantB.userId,
      });

      // Every indirectly workspace-scoped entity is seeded in both tenants.
      // Each assertion below joins through its constrained owning parent.
      await db.insert(projectAccess).values([
        {
          projectId: projectA.id,
          userId: tenantA.userId,
          role: "admin",
          createdById: tenantA.userId,
        },
        {
          projectId: projectB.id,
          userId: tenantB.userId,
          role: "admin",
          createdById: tenantB.userId,
        },
      ]);
      await db.insert(noteShares).values([
        {
          noteId: noteA.id,
          userId: tenantA.userId,
          permission: "edit",
          createdById: tenantA.userId,
        },
        {
          noteId: noteB.id,
          userId: tenantB.userId,
          permission: "edit",
          createdById: tenantB.userId,
        },
      ]);
      await db.insert(noteTags).values([
        { noteId: noteA.id, tagId: tagA.id },
        { noteId: noteB.id, tagId: tagB.id },
      ]);
      const versionATitle = `VersionA ${stamp}`;
      const versionBTitle = `VersionB ${stamp}`;
      await db.insert(noteVersions).values([
        {
          noteId: noteA.id,
          version: 1,
          title: versionATitle,
          content: { type: "doc", content: [] },
          createdById: tenantA.userId,
        },
        {
          noteId: noteB.id,
          version: 1,
          title: versionBTitle,
          content: { type: "doc", content: [] },
          createdById: tenantB.userId,
        },
      ]);
      // Part 58: neither collaboration table carries `workspace_id` (they are
      // polymorphic children of `notes`, exactly like `note_versions`), so the
      // only thing standing between a note UUID and another tenant's Yjs log is
      // the join through `notes.workspace_id`.
      await db.insert(noteCollaborationStates).values([
        { noteId: noteA.id, projectedNoteVersion: 1 },
        { noteId: noteB.id, projectedNoteVersion: 1 },
      ]);
      await db.insert(noteCollaborationUpdates).values([
        {
          noteId: noteA.id,
          epoch: 1,
          revision: 1,
          kind: "snapshot",
          payload: new Uint8Array([1]),
          payloadBytes: 1,
          createdById: tenantA.userId,
        },
        {
          noteId: noteB.id,
          epoch: 1,
          revision: 1,
          kind: "snapshot",
          payload: new Uint8Array([2]),
          payloadBytes: 1,
          createdById: tenantB.userId,
        },
      ]);
      await db.insert(taskTags).values([
        { taskId: taskA.id, tagId: tagA.id },
        { taskId: taskB.id, tagId: tagB.id },
      ]);
      const embedding = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
      await db.insert(noteEmbeddings).values([
        {
          noteId: noteA.id,
          embedding,
          model: `model-a-${stamp}`,
          contentHash: `hash-a-${stamp}`,
          dimensions: 1536,
        },
        {
          noteId: noteB.id,
          embedding,
          model: `model-b-${stamp}`,
          contentHash: `hash-b-${stamp}`,
          dimensions: 1536,
        },
      ]);
      const deliveryAEvent = `event.a.${stamp}`;
      const deliveryBEvent = `event.b.${stamp}`;
      await db.insert(webhookDeliveries).values([
        {
          webhookId: webhookA.id,
          eventId: crypto.randomUUID(),
          event: deliveryAEvent,
          attempt: 1,
        },
        {
          webhookId: webhookB.id,
          eventId: crypto.randomUUID(),
          event: deliveryBEvent,
          attempt: 1,
        },
      ]);

      // Invitations (hash-only token).
      const inviteA = `invite-a-${stamp}@notted.invalid`;
      const inviteB = `invite-b-${stamp}@notted.invalid`;
      await db.insert(invitations).values({
        workspaceId: tenantA.workspaceId,
        email: inviteA,
        role: "viewer",
        tokenHash: `invite-hash-A-${stamp}`,
        invitedById: tenantA.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      await db.insert(invitations).values({
        workspaceId: tenantB.workspaceId,
        email: inviteB,
        role: "viewer",
        tokenHash: `invite-hash-B-${stamp}`,
        invitedById: tenantB.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      // ---- Assert: ctxA's whereWorkspace predicate excludes tenant-B rows. --
      const tenantContext = new TenantContextService();
      const scopedDb = db;
      await tenantContext.run(tenantA.context, async () => {
        const ids = (rows: ReadonlyArray<{ id: string }>) => rows.map((r) => r.id);

        // workspaces root: scope by id.
        const wsRows = await scopedDb
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(whereWorkspaceId(workspaces, tenantContext));
        expect(ids(wsRows)).toContain(tenantA.workspaceId);
        expect(ids(wsRows)).not.toContain(tenantB.workspaceId);

        // workspace_members.
        const memberRows = await scopedDb
          .select({ id: workspaceMembers.userId })
          .from(workspaceMembers)
          .where(whereWorkspace(workspaceMembers, tenantContext));
        expect(memberRows.map((r) => r.id)).toContain(tenantA.userId);
        expect(memberRows.map((r) => r.id)).not.toContain(tenantB.userId);

        // invitations.
        const invitationRows = await scopedDb
          .select({ email: invitations.email })
          .from(invitations)
          .where(whereWorkspace(invitations, tenantContext));
        expect(invitationRows.map((r) => r.email)).toContain(inviteA);
        expect(invitationRows.map((r) => r.email)).not.toContain(inviteB);

        // projects.
        const projectRows = await scopedDb
          .select({ id: projects.id })
          .from(projects)
          .where(whereWorkspace(projects, tenantContext));
        expect(ids(projectRows)).toContain(projectA.id);
        expect(ids(projectRows)).not.toContain(projectB.id);

        // folders.
        const folderRows = await scopedDb
          .select({ id: folders.id })
          .from(folders)
          .where(whereWorkspace(folders, tenantContext));
        expect(ids(folderRows)).toContain(folderA.id);
        expect(ids(folderRows)).not.toContain(folderB.id);

        // notes.
        const noteRows = await scopedDb
          .select({ id: notes.id })
          .from(notes)
          .where(whereWorkspace(notes, tenantContext));
        expect(ids(noteRows)).toContain(noteA.id);
        expect(ids(noteRows)).not.toContain(noteB.id);

        // tags.
        const tagRows = await scopedDb
          .select({ id: tags.id, name: tags.name })
          .from(tags)
          .where(whereWorkspace(tags, tenantContext));
        expect(tagRows.map((r) => r.id)).toContain(tagA.id);
        expect(tagRows.map((r) => r.name)).not.toContain(`tag-b-${stamp}`);

        // attachments.
        const attachmentRows = await scopedDb
          .select({ key: attachments.storageKey })
          .from(attachments)
          .where(whereWorkspace(attachments, tenantContext));
        expect(attachmentRows.map((r) => r.key)).toContain(attachmentAKey);
        expect(attachmentRows.map((r) => r.key)).not.toContain(attachmentBKey);

        // tasks.
        const taskRows = await scopedDb
          .select({ id: tasks.id })
          .from(tasks)
          .where(whereWorkspace(tasks, tenantContext));
        expect(ids(taskRows)).toContain(taskA.id);
        expect(ids(taskRows)).not.toContain(taskB.id);

        // task_statuses.
        const statusRows = await scopedDb
          .select({ name: taskStatuses.name })
          .from(taskStatuses)
          .where(whereWorkspace(taskStatuses, tenantContext));
        expect(statusRows.map((r) => r.name)).toContain(`status-a-${stamp}`);
        expect(statusRows.map((r) => r.name)).not.toContain(`status-b-${stamp}`);

        // audit_logs.
        const auditRows = await scopedDb
          .select({ entityId: auditLogs.entityId })
          .from(auditLogs)
          .where(whereWorkspace(auditLogs, tenantContext));
        expect(auditRows.map((r) => r.entityId)).toContain(noteA.id);
        expect(auditRows.map((r) => r.entityId)).not.toContain(noteB.id);

        // api_keys.
        const apiKeyRows = await scopedDb
          .select({ prefix: apiKeys.keyPrefix })
          .from(apiKeys)
          .where(whereWorkspace(apiKeys, tenantContext));
        expect(apiKeyRows.map((r) => r.prefix)).toContain("ntd_pk_a");
        expect(apiKeyRows.map((r) => r.prefix)).not.toContain("ntd_pk_b");

        // webhooks.
        const webhookRows = await scopedDb
          .select({ id: webhooks.id, url: webhooks.url })
          .from(webhooks)
          .where(whereWorkspace(webhooks, tenantContext));
        expect(webhookRows.map((r) => r.id)).toContain(webhookA.id);
        expect(webhookRows.map((r) => r.url)).not.toContain("https://example.com/hook-b");

        // workspace_domains.
        const domainRows = await scopedDb
          .select({ hostname: workspaceDomains.hostname })
          .from(workspaceDomains)
          .where(whereWorkspace(workspaceDomains, tenantContext));
        expect(domainRows.map((r) => r.hostname)).toContain(`a-${stamp}.example.com`);
        expect(domainRows.map((r) => r.hostname)).not.toContain(`b-${stamp}.example.com`);

        // exports.
        const exportRows = await scopedDb
          .select({ sourceId: exportJobs.sourceId })
          .from(exportJobs)
          .where(whereWorkspace(exportJobs, tenantContext));
        expect(exportRows.map((r) => r.sourceId)).toContain(noteA.id);
        expect(exportRows.map((r) => r.sourceId)).not.toContain(noteB.id);

        // ai_provider_config.
        const aiConfigRows = await scopedDb
          .select({ provider: aiProviderConfig.provider })
          .from(aiProviderConfig)
          .where(whereWorkspace(aiProviderConfig, tenantContext));
        expect(aiConfigRows.map((r) => r.provider)).toContain("openai");
        expect(aiConfigRows.map((r) => r.provider)).not.toContain("anthropic");

        // ai_usage.
        const aiUsageRows = await scopedDb
          .select({ provider: aiUsage.provider })
          .from(aiUsage)
          .where(whereWorkspace(aiUsage, tenantContext));
        expect(aiUsageRows.map((r) => r.provider)).toContain("openai");
        expect(aiUsageRows.map((r) => r.provider)).not.toContain("anthropic");

        // email_deliveries (workspace-scoped; NULL workspace_id is out of scope).
        const emailRows = await scopedDb
          .select({ recipient: emailDeliveries.recipient })
          .from(emailDeliveries)
          .where(whereWorkspace(emailDeliveries, tenantContext));
        expect(emailRows.map((r) => r.recipient)).toContain(emailA);
        expect(emailRows.map((r) => r.recipient)).not.toContain(emailB);

        // Indirect entities: every query joins through a parent whose workspace
        // predicate comes from the active context.
        const projectAccessRows = await scopedDb
          .select({ projectId: projectAccess.projectId })
          .from(projectAccess)
          .innerJoin(projects, eq(projectAccess.projectId, projects.id))
          .where(whereWorkspace(projects, tenantContext));
        expect(projectAccessRows.map((row) => row.projectId)).toContain(projectA.id);
        expect(projectAccessRows.map((row) => row.projectId)).not.toContain(projectB.id);

        const noteShareRows = await scopedDb
          .select({ noteId: noteShares.noteId })
          .from(noteShares)
          .innerJoin(notes, eq(noteShares.noteId, notes.id))
          .where(whereWorkspace(notes, tenantContext));
        expect(noteShareRows.map((row) => row.noteId)).toContain(noteA.id);
        expect(noteShareRows.map((row) => row.noteId)).not.toContain(noteB.id);

        const noteTagRows = await scopedDb
          .select({ noteId: noteTags.noteId })
          .from(noteTags)
          .innerJoin(notes, eq(noteTags.noteId, notes.id))
          .where(whereWorkspace(notes, tenantContext));
        expect(noteTagRows.map((row) => row.noteId)).toContain(noteA.id);
        expect(noteTagRows.map((row) => row.noteId)).not.toContain(noteB.id);

        const commentRows = await scopedDb
          .select({ content: comments.content })
          .from(comments)
          .innerJoin(notes, eq(comments.noteId, notes.id))
          .where(whereWorkspace(notes, tenantContext));
        expect(commentRows.map((row) => row.content)).toContain(commentAContent);
        expect(commentRows.map((row) => row.content)).not.toContain(commentBContent);

        const versionRows = await scopedDb
          .select({ title: noteVersions.title })
          .from(noteVersions)
          .innerJoin(notes, eq(noteVersions.noteId, notes.id))
          .where(whereWorkspace(notes, tenantContext));
        expect(versionRows.map((row) => row.title)).toContain(versionATitle);
        expect(versionRows.map((row) => row.title)).not.toContain(versionBTitle);

        const collaborationStateRows = await scopedDb
          .select({ noteId: noteCollaborationStates.noteId })
          .from(noteCollaborationStates)
          .innerJoin(notes, eq(noteCollaborationStates.noteId, notes.id))
          .where(whereWorkspace(notes, tenantContext));
        expect(collaborationStateRows.map((row) => row.noteId)).toContain(noteA.id);
        expect(collaborationStateRows.map((row) => row.noteId)).not.toContain(noteB.id);

        const collaborationUpdateRows = await scopedDb
          .select({ noteId: noteCollaborationUpdates.noteId })
          .from(noteCollaborationUpdates)
          .innerJoin(notes, eq(noteCollaborationUpdates.noteId, notes.id))
          .where(whereWorkspace(notes, tenantContext));
        expect(collaborationUpdateRows.map((row) => row.noteId)).toContain(noteA.id);
        expect(collaborationUpdateRows.map((row) => row.noteId)).not.toContain(noteB.id);

        const taskTagRows = await scopedDb
          .select({ taskId: taskTags.taskId })
          .from(taskTags)
          .innerJoin(tasks, eq(taskTags.taskId, tasks.id))
          .where(whereWorkspace(tasks, tenantContext));
        expect(taskTagRows.map((row) => row.taskId)).toContain(taskA.id);
        expect(taskTagRows.map((row) => row.taskId)).not.toContain(taskB.id);

        const embeddingRows = await scopedDb
          .select({ model: noteEmbeddings.model })
          .from(noteEmbeddings)
          .innerJoin(notes, eq(noteEmbeddings.noteId, notes.id))
          .where(whereWorkspace(notes, tenantContext));
        expect(embeddingRows.map((row) => row.model)).toContain(`model-a-${stamp}`);
        expect(embeddingRows.map((row) => row.model)).not.toContain(`model-b-${stamp}`);

        const deliveryRows = await scopedDb
          .select({ event: webhookDeliveries.event })
          .from(webhookDeliveries)
          .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
          .where(whereWorkspace(webhooks, tenantContext));
        expect(deliveryRows.map((row) => row.event)).toContain(deliveryAEvent);
        expect(deliveryRows.map((row) => row.event)).not.toContain(deliveryBEvent);
      });
    } finally {
      await cleanupTenants(db, [tenantA, tenantB]);
    }
  });

  // -------------------------------------------------------------------------
  // (c) Real services refuse another tenant's identifiers.
  //
  // This is the proof the deleted guard matrix pretended to give. Each case
  // calls the SAME service the transports call, under tenant A's context, with
  // an id that belongs to tenant B — and asserts 404, never 403, because
  // answering "forbidden" would confirm the row exists.
  //
  // `tasks`, `task_statuses` and `tags` are here because they were the three
  // resources with NO service-level cross-tenant test anywhere: tasks had none
  // at all, and the other two had only mock-based unit tests whose
  // `authorizeUser` was a `vi.fn()` — which asserts that a predicate is passed,
  // not that a foreign row is refused.
  //
  // Measured while writing this: the refusal is defended THREE times over, and
  // removing any one of them leaves this test green. It goes red only when all
  // three are gone —
  //   1. `AuthorizationRepository.loadTask`'s `whereWorkspace` predicate,
  //   2. the `workspace_mismatch` -> `authorization.concealed` guard in
  //      `AuthorizationPolicyService` (the choke point every resource kind
  //      routes through), and
  //   3. the service's own scoped `readRow`.
  // That is the point of asserting through the service rather than at any one
  // layer: this observes the property a tenant actually depends on, and stays
  // true however the layers are refactored underneath it.
  // -------------------------------------------------------------------------

  function servicesFor(database: NodePgDatabase<typeof schema>): {
    readonly tenant: TenantContextService;
    readonly tasks: TasksService;
    readonly statuses: TaskStatusesService;
    readonly tags: TagsService;
  } {
    const tenant = new TenantContextService();
    const databaseService = {
      db: database,
      transaction: <T>(
        work: (scope: DatabaseTransaction) => Promise<T>,
        config?: PgTransactionConfig,
      ) => database.transaction(work, config),
    } as unknown as DatabaseService;
    // The REAL policy stack — a stub here would test the stub.
    const authorization = new AuthorizationEntryService(
      new AuthorizationRepository(databaseService, tenant),
      new AuthorizationPolicyService(),
      tenant,
    );
    return {
      tenant,
      tasks: new TasksService(databaseService, authorization, tenant),
      statuses: new TaskStatusesService(databaseService, authorization, tenant),
      tags: new TagsService(databaseService, authorization, tenant, {
        scheduleSearchSync: async () => undefined,
      } as unknown as NoteSearchIndexProducer),
    };
  }

  function principalFor(userId: string): AuthenticatedPrincipal {
    return Object.freeze({
      userId,
      sessionId: `p19-session:${userId}`,
      method: "opaque-session",
      assurance: "single-factor",
      authenticatedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      isFresh: true,
    });
  }

  /*
   * Concealment can be reached two ways and both are correct: the policy layer
   * refuses with an `AuthorizationDeniedError` carrying a decision, and a
   * service whose own scoped lookup misses throws `ApiHttpException` NOT_FOUND.
   * What must hold either way is the security property — 404, never 403, so a
   * foreign identifier cannot be probed for existence.
   */
  function expectConcealed(error: unknown): void {
    const decision = (error as { decision?: { allowed?: boolean; httpStatus?: number } }).decision;
    const safeResponse = (error as { safeResponse?: { code?: string } }).safeResponse;
    const status = decision?.httpStatus ?? (error as { status?: number }).status;
    if (decision !== undefined) {
      expect(decision.allowed).toBe(false);
      expect(decision.httpStatus).toBe(404);
      return;
    }
    expect(safeResponse?.code, `unexpected rejection: ${String(error)}`).toBe("NOT_FOUND");
    expect(status ?? 404).toBe(404);
  }

  async function expectRefused(work: Promise<unknown>): Promise<void> {
    await work.then(
      () => {
        throw new Error("expected a cross-tenant refusal, but the call resolved");
      },
      (error: unknown) => expectConcealed(error),
    );
  }

  it("refuses another workspace's task, status and tag through the real services", async ({
    skip,
  }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const tenantA = await bootstrapTenant(db, stamp, "svc-a");
    const tenantB = await bootstrapTenant(db, stamp, "svc-b");

    try {
      // Tenant B's rows, written directly so the fixture does not depend on the
      // very services under test.
      const taskB = await db.execute(sql`
        insert into tasks (workspace_id, title, created_by_id)
        values (${tenantB.workspaceId}, ${"Beta task"}, ${tenantB.userId})
        returning id
      `);
      const statusB = await db.execute(sql`
        insert into task_statuses (workspace_id, name, sort_order)
        values (${tenantB.workspaceId}, ${"Beta column"}, ${1})
        returning id
      `);
      const tagB = await db.execute(sql`
        insert into tags (workspace_id, name, color)
        values (${tenantB.workspaceId}, ${"beta-tag-" + stamp}, ${"#334155"})
        returning id
      `);
      const taskBId = (taskB.rows[0] as IdRow).id;
      const statusBId = (statusB.rows[0] as IdRow).id;
      const tagBId = (tagB.rows[0] as IdRow).id;

      const { tenant, tasks, statuses, tags } = servicesFor(db);
      const alpha = principalFor(tenantA.userId);
      const scope = { principal: alpha, workspaceId: tenantA.workspaceId, requestId: null };

      await tenant.run(tenantA.context, async () => {
        // Read, update and delete each: a guard that only covers the read path
        // is not a guard.
        await expectRefused(tasks.read({ ...scope, taskId: taskBId }));
        await expectRefused(tasks.remove({ ...scope, taskId: taskBId }));
        await expectRefused(statuses.update({ ...scope, statusId: statusBId, name: "hijacked" }));
        await expectRefused(statuses.remove({ ...scope, statusId: statusBId }));
        await expectRefused(tags.update({ ...scope, tagId: tagBId, name: "hijacked" }));
        await expectRefused(tags.remove({ ...scope, tagId: tagBId }));
      });

      // Nothing was mutated or removed on the way to being refused.
      const survivors = await db.execute(sql`
        select
          (select count(*) from tasks where id = ${taskBId}) as tasks,
          (select count(*) from task_statuses where id = ${statusBId}) as statuses,
          (select count(*) from tags where id = ${tagBId}) as tags
      `);
      const counts = survivors.rows[0] as Record<string, unknown>;
      expect(Number(counts.tasks)).toBe(1);
      expect(Number(counts.statuses)).toBe(1);
      expect(Number(counts.tags)).toBe(1);
    } finally {
      await cleanupTenants(db, [tenantA, tenantB]);
    }
  });
});
