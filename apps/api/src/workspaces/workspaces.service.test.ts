import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { HAS_DATABASE, requireDatabase } from "../../test/database-test-helpers";
import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../authorization/authorization-policy.service";
import { AuthorizationRepository } from "../authorization/authorization.repository";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import {
  apiIdempotencyRecords,
  auditLogs,
  jobOutbox,
  schema,
  workspaceDeletionAudits,
  workspaces,
  workspaceMembers,
} from "../database/schema";
import { SEED_IDS, seedDatabase } from "../database/seed";
import { createTenantContext, TenantContextService } from "../tenant";

import { WORKSPACE_AUDIT_ACTIONS, WORKSPACE_DELETED_JOB_TYPE } from "./workspaces.constants";
import { isUniqueViolationOnConstraint, WorkspacesService } from "./workspaces.service";

import type { ApiHttpException } from "../common/errors/api-http.exception";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

// --------------------------------------------------------------------------- //
// Unit tests (no database): slug collision retry, atomic create, delete
// ordering, confirmation enforcement, and authorization propagation.
// --------------------------------------------------------------------------- //

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");

const USER_ID = "20000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8100-000000000099";
const REQUEST_ID = "20000000-0000-4000-8200-000000000099";

function principal(userId = USER_ID, fresh = true): AuthenticatedPrincipal {
  return Object.freeze({
    userId,
    sessionId: `session:${userId}`,
    method: "opaque-session",
    assurance: "single-factor",
    authenticatedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isFresh: fresh,
  });
}

/**
 * A mock AuthorizationEntryService whose run() establishes a real ALS context on
 * the SAME tenant the service under test reads from, so `whereWorkspaceId`
 * predicates resolve during the scoped transaction.
 */
function mockEntryWithRun(
  tenant: TenantContextService,
  workspaceId: string,
  userId: string,
): {
  readonly entry: AuthorizationEntryService;
  readonly authorizeUser: ReturnType<typeof vi.fn>;
} {
  const authorizeUser = vi.fn().mockResolvedValue(
    Object.freeze({
      workspaceId,
      userId,
      decision: Object.freeze({ allowed: true, audit: Object.freeze({}) }),
    }),
  );
  const entry = {
    authorizeUser,
    run: <T>(operation: { workspaceId: string; userId: string | null }, work: () => T): T =>
      tenant.run(
        createTenantContext({ workspaceId: operation.workspaceId, userId: operation.userId }),
        work,
      ),
  } as unknown as AuthorizationEntryService;
  return { entry, authorizeUser };
}

describe("WorkspacesService (unit)", () => {
  it("retries slug collision, commits workspace + owner membership + audit atomically, returns the final slug", async () => {
    const tenant = new TenantContextService();
    let workspaceInsertAttempts = 0;
    const inserts: { readonly table: unknown; readonly values: unknown }[] = [];
    const now = new Date();

    const tx = {
      execute: () => Promise.resolve(),
      insert: (table: unknown) => ({
        values: (value: unknown) => {
          if (table === workspaces) {
            workspaceInsertAttempts += 1;
            if (workspaceInsertAttempts === 1) {
              return Promise.reject(
                Object.assign(new Error("Drizzle query failed"), {
                  cause: Object.assign(new Error("unique slug"), {
                    code: "23505",
                    constraint: "workspaces_slug_unique",
                  }),
                }),
              );
            }
          }
          inserts.push({ table, values: value });
          return Promise.resolve();
        },
      }),
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () =>
              table === apiIdempotencyRecords
                ? Promise.resolve([])
                : Promise.resolve([
                    {
                      id: WORKSPACE_ID,
                      name: "Notted Alpha",
                      slug: "notted-alpha-2",
                      description: null,
                      logoUrl: null,
                      domain: null,
                      plan: "free",
                      settings: {},
                      storageLimitBytes: null,
                      createdById: USER_ID,
                      createdAt: now,
                      updatedAt: now,
                    },
                  ]),
          }),
        }),
      }),
    };
    const database = {
      transaction: async (work: (scope: typeof tx) => Promise<unknown>) => work(tx),
    };

    const service = new WorkspacesService(
      database as unknown as DatabaseService,
      {} as AuthorizationEntryService,
      tenant,
    );

    const result = await service.create({
      principal: principal(),
      name: "Notted Alpha",
      slug: "notted-alpha",
      description: null,
    });

    // The first attempt collided; the second attempt (suffixed -2) succeeded.
    expect(workspaceInsertAttempts).toBe(2);
    expect(result.slug).toBe("notted-alpha-2");
    expect(result.workspace.slug).toBe("notted-alpha-2");
    expect(result.workspace.currentUserRole).toBe("owner");
    expect(result.workspace.settings).toEqual({ defaultPageSize: "a4" });
    expect(result.workspace.storageLimitBytes).toBeNull();

    // The successful transaction inserted workspace + owner membership + audit.
    const insertedTables = inserts.map((entry) => entry.table);
    expect(insertedTables).toEqual([
      workspaces,
      workspaceMembers,
      auditLogs,
      apiIdempotencyRecords,
    ]);
    const membership = inserts.find((entry) => entry.table === workspaceMembers)?.values as {
      readonly role: string;
      readonly workspaceId: string;
      readonly userId: string;
    };
    const insertedWorkspace = inserts.find((entry) => entry.table === workspaces)?.values as {
      readonly id: string;
      readonly settings: unknown;
    };
    expect(insertedWorkspace.settings).toEqual({ defaultPageSize: "a4" });
    expect(membership).toMatchObject({
      role: "owner",
      workspaceId: insertedWorkspace.id,
      userId: USER_ID,
    });
    const audit = inserts.find((entry) => entry.table === auditLogs)?.values as {
      readonly action: string;
      readonly entityType: string;
      readonly metadata: unknown;
    };
    expect(audit.action).toBe(WORKSPACE_AUDIT_ACTIONS.create);
    expect(audit.entityType).toBe("workspace");
    expect(audit.metadata).toEqual({});
  });

  it("recognizes only the exact slug constraint through a bounded cause chain", () => {
    const wrapped = {
      cause: {
        cause: { code: "23505", constraint: "workspaces_slug_unique" },
      },
    };
    expect(isUniqueViolationOnConstraint(wrapped, "workspaces_slug_unique")).toBe(true);
    expect(isUniqueViolationOnConstraint(wrapped, "workspaces_domain_unique")).toBe(false);
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(isUniqueViolationOnConstraint(cyclic, "workspaces_slug_unique")).toBe(false);
  });

  it("schedules cleanup, writes audit, and deletes in order inside the delete transaction", async () => {
    const tenant = new TenantContextService();
    const operations: string[] = [];
    let deletionAuditMetadata: unknown;
    let deletionTombstone: unknown;

    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([{ id: WORKSPACE_ID, name: "Notted Alpha", slug: "notted-alpha" }]),
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (value: { readonly jobType?: string; readonly action?: string }) => {
          if (table === jobOutbox) operations.push(`outbox:${value.jobType}`);
          if (table === auditLogs) {
            operations.push(`audit:${value.action}`);
            deletionAuditMetadata = (value as { readonly metadata?: unknown }).metadata;
          }
          if (table === workspaceDeletionAudits) {
            operations.push("tombstone:workspace");
            deletionTombstone = value;
          }
          return Promise.resolve();
        },
      }),
      delete: (table: unknown) => ({
        where: () => {
          operations.push(table === workspaces ? "delete:workspaces" : "delete:other");
          return Promise.resolve();
        },
      }),
    };
    const database = {
      transaction: async (work: (scope: typeof tx) => Promise<unknown>) => work(tx),
    };
    const { entry } = mockEntryWithRun(tenant, WORKSPACE_ID, USER_ID);

    const service = new WorkspacesService(database as unknown as DatabaseService, entry, tenant);

    const result = await service.delete({
      principal: principal(),
      workspaceId: WORKSPACE_ID,
      confirmed: true,
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ id: WORKSPACE_ID, deleted: true });
    // job_outbox intent FIRST (while the workspace row still exists), then audit,
    // then the cascade delete.
    expect(operations).toEqual([
      `outbox:${WORKSPACE_DELETED_JOB_TYPE}`,
      "outbox:workspace.search.purge",
      `audit:${WORKSPACE_AUDIT_ACTIONS.delete}`,
      "tombstone:workspace",
      "delete:workspaces",
    ]);
    expect(deletionAuditMetadata).toEqual({});
    expect(deletionTombstone).toMatchObject({
      deletedWorkspaceId: WORKSPACE_ID,
      actorId: USER_ID,
      requestId: REQUEST_ID,
    });
  });

  it("rejects deletion when expectedName does not match the persisted workspace name", async () => {
    const tenant = new TenantContextService();
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([{ id: WORKSPACE_ID, name: "Notted Alpha", slug: "notted-alpha" }]),
          }),
        }),
      }),
      insert: () => ({ values: () => Promise.resolve() }),
      delete: () => ({ where: () => Promise.resolve() }),
    };
    const database = {
      transaction: async (work: (scope: typeof tx) => Promise<unknown>) => work(tx),
    };
    const { entry } = mockEntryWithRun(tenant, WORKSPACE_ID, USER_ID);

    const service = new WorkspacesService(database as unknown as DatabaseService, entry, tenant);

    await expect(
      service.delete({
        principal: principal(),
        workspaceId: WORKSPACE_ID,
        confirmed: true,
        expectedName: "Wrong Name",
      }),
    ).rejects.toMatchObject({
      safeResponse: { code: "VALIDATION_ERROR" },
    });
  });

  it("propagates authorization denial before touching the database", async () => {
    const tenant = new TenantContextService();
    const select = vi.fn();
    const database = { db: { select } } as unknown as DatabaseService;
    const authorizeUser = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("denied"), { safeResponse: { code: "NOT_FOUND" } }),
      );
    const entry = { authorizeUser } as unknown as AuthorizationEntryService;

    const service = new WorkspacesService(database, entry, tenant);
    const actor = principal();
    await expect(
      service.read({ principal: actor, workspaceId: WORKSPACE_ID }),
    ).rejects.toMatchObject({ safeResponse: { code: "NOT_FOUND" } });

    // Authorization is evaluated first; the scoped read never runs on denial.
    expect(authorizeUser).toHaveBeenCalledWith({
      principal: actor,
      workspaceId: WORKSPACE_ID,
      action: "workspace.read",
      resource: { kind: "workspace" },
      requestId: undefined,
    });
    expect(select).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------- //
// Part 72 branding accent. `workspaces.settings` was already persisting (and
// seeding) `accentColor` with no contract behind it; these cases pin the three
// rules that gave it one: contrast is enforced on WRITE with its own code, the
// warn band is allowed, and `null` DELETES the key instead of storing a second
// kind of absence.
// --------------------------------------------------------------------------- //

/** Captures the thrown `ApiHttpException` so both its status and code can be asserted. */
async function accentRejection(work: Promise<unknown>): Promise<ApiHttpException> {
  try {
    await work;
  } catch (error: unknown) {
    return error as ApiHttpException;
  }
  throw new Error("expected the update to reject");
}

/**
 * One workspace row whose `settings` blob the caller chooses. The update writes
 * back into the same row, so the re-select that feeds the detail mapper sees
 * exactly what was persisted rather than a fixture the test restated.
 */
function accentHarness(storedSettings: Record<string, unknown>) {
  const tenant = new TenantContextService();
  const now = new Date();
  const row = {
    id: WORKSPACE_ID,
    name: "Notted Alpha",
    slug: "notted-alpha",
    description: null,
    logoUrl: null,
    domain: null,
    plan: "free" as const,
    settings: storedSettings as unknown,
    storageLimitBytes: null,
    createdById: USER_ID,
    createdAt: now,
    updatedAt: now,
    currentUserRole: "owner" as const,
  };
  const saved: Record<string, unknown>[] = [];

  const tx = {
    select: () => ({
      from: () => {
        const chain = {
          innerJoin: () => chain,
          where: () => chain,
          limit: () => Promise.resolve([{ ...row }]),
        };
        return chain;
      },
    }),
    update: () => ({
      set: (value: Record<string, unknown>) => ({
        where: () => {
          saved.push(value);
          if (value.settings !== undefined) row.settings = value.settings;
          return Promise.resolve();
        },
      }),
    }),
    insert: () => ({ values: () => Promise.resolve() }),
  };
  const database = {
    transaction: async (work: (scope: typeof tx) => Promise<unknown>) => work(tx),
  };
  const { entry } = mockEntryWithRun(tenant, WORKSPACE_ID, USER_ID);
  const service = new WorkspacesService(database as unknown as DatabaseService, entry, tenant);

  return {
    service,
    saved,
    settingsWritten: (): Record<string, unknown> =>
      (saved.at(-1)?.settings ?? {}) as Record<string, unknown>,
  };
}

describe("WorkspacesService accent colour (unit)", () => {
  it("persists an accent that meets the contrast floor and returns it from the detail mapper", async () => {
    const harness = accentHarness({ defaultPageSize: "a4" });
    // 5.47:1 against white — comfortably `ok`.
    const result = await harness.service.update({
      principal: principal(),
      workspaceId: WORKSPACE_ID,
      settings: { defaultPageSize: "a4", accentColor: "#0f766e" },
    });

    expect(harness.settingsWritten()).toEqual({ defaultPageSize: "a4", accentColor: "#0f766e" });
    // Part 72 stopped STRIPPING the accent on read; before it, the contract
    // could not carry the very value the workspace had chosen.
    expect(result.workspace.settings).toEqual({ defaultPageSize: "a4", accentColor: "#0f766e" });
  });

  it("refuses an illegible accent with its own code, not a generic validation error", async () => {
    const harness = accentHarness({ defaultPageSize: "a4" });
    // 1.67:1 against white. The settings form needs the specific code to name
    // the remedy ("choose a darker shade"), which a Zod refinement could not give.
    const error = await accentRejection(
      harness.service.update({
        principal: principal(),
        workspaceId: WORKSPACE_ID,
        settings: { defaultPageSize: "a4", accentColor: "#fbbf24" },
      }),
    );
    expect(error.getStatus()).toBe(422);
    expect(error.safeResponse.code).toBe("ACCENT_CONTRAST_TOO_LOW");
    expect(harness.saved).toEqual([]);
  });

  it("accepts an accent in the warn band rather than rejecting most brand palettes", async () => {
    const harness = accentHarness({ defaultPageSize: "a4" });
    // 3.76:1 — over the 3:1 non-text floor, under the 4.5:1 body-text target.
    // The accent paints surfaces and borders, not paragraphs.
    const result = await harness.service.update({
      principal: principal(),
      workspaceId: WORKSPACE_ID,
      settings: { defaultPageSize: "a4", accentColor: "#ef4444" },
    });
    expect(result.workspace.settings.accentColor).toBe("#ef4444");
  });

  it("treats accentColor: null as a deletion, leaving the other stored keys intact", async () => {
    const harness = accentHarness({
      defaultPageSize: "letter",
      accentColor: "#2563eb",
      scenario: "alpha",
    });
    const result = await harness.service.update({
      principal: principal(),
      workspaceId: WORKSPACE_ID,
      settings: { defaultPageSize: "letter", accentColor: null },
    });

    // One absence, not two: a stored `null` would make every reader — the
    // detail mapper, the shell, the email branding parser — handle both.
    expect(harness.settingsWritten()).not.toHaveProperty("accentColor");
    // `scenario` is a seed-only marker no contract describes; a settings save
    // must not erase it.
    expect(harness.settingsWritten()).toEqual({ defaultPageSize: "letter", scenario: "alpha" });
    expect(result.workspace.settings).toEqual({ defaultPageSize: "letter" });
  });

  it("keeps a stored accent through an update that only changes the page size", async () => {
    const harness = accentHarness({
      defaultPageSize: "a4",
      accentColor: "#0f766e",
      scenario: "alpha",
    });
    const result = await harness.service.update({
      principal: principal(),
      workspaceId: WORKSPACE_ID,
      settings: { defaultPageSize: "letter" },
    });

    // An omitted key means "leave it alone" — only an explicit `null` clears it.
    expect(harness.settingsWritten()).toEqual({
      defaultPageSize: "letter",
      accentColor: "#0f766e",
      scenario: "alpha",
    });
    expect(result.workspace.settings).toEqual({
      defaultPageSize: "letter",
      accentColor: "#0f766e",
    });
  });
});

// --------------------------------------------------------------------------- //
// Live integration tests (DATABASE_URL-gated): real PostgreSQL behavior for
// validation, slug collision, owner-membership transactionality, authorization
// allow/deny, cross-tenant concealment, update, and deletion cleanup intent.
// --------------------------------------------------------------------------- //

class RollbackWorkspacesTest extends Error {}

describe.skipIf(!HAS_DATABASE)("Part 26 workspace lifecycle (live)", () => {
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;

  beforeAll(async () => {
    await requireDatabase();

    pool = new Pool({ connectionString: DATABASE_URL as string, max: 1 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  it("creates with owner membership, resolves slug collisions, authorizes reads, and deletes with a cleanup intent", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);

        const tenant = new TenantContextService();
        const database = {
          db: tx,
          transaction: <T>(work: (scope: DatabaseTransaction) => Promise<T>): Promise<T> =>
            tx.transaction(work),
        } as unknown as DatabaseService;
        const repository = new AuthorizationRepository(database, tenant);
        const policy = new AuthorizationPolicyService();
        const entry = new AuthorizationEntryService(repository, policy, tenant);
        const service = new WorkspacesService(database, entry, tenant);

        const alphaOwner = principal(SEED_IDS.users.alphaOwner);
        const betaOwner = principal(SEED_IDS.users.betaOwner);
        const collisionBase = `collide-${crypto.randomUUID().slice(0, 8)}`;

        const seededDetail = await service.read({
          principal: alphaOwner,
          workspaceId: SEED_IDS.workspaces.alpha,
        });
        // Part 72 added a seeded accent for Alpha; the projection returns both
        // known keys (and drops the seed's private `scenario` marker).
        expect(seededDetail.settings).toEqual({ defaultPageSize: "a4", accentColor: "#2563eb" });
        expect(seededDetail.storageLimitBytes).toBe(1_073_741_824);
        await service.update({
          principal: alphaOwner,
          workspaceId: SEED_IDS.workspaces.alpha,
          settings: { defaultPageSize: "letter" },
        });
        const [persistedSettings] = await tx
          .select({ settings: workspaces.settings })
          .from(workspaces)
          .where(eq(workspaces.id, SEED_IDS.workspaces.alpha));
        expect(persistedSettings?.settings).toMatchObject({
          accentColor: "#2563eb",
          scenario: "alpha",
          defaultPageSize: "letter",
        });

        // Pre-create two workspaces with slugs the service must skip past.
        for (const suffix of ["", "-2"]) {
          await tx.insert(workspaces).values({
            id: crypto.randomUUID(),
            name: `Collision ${suffix || "root"}`,
            slug: `${collisionBase}${suffix}`,
            createdById: SEED_IDS.users.alphaOwner,
          });
        }

        // Slug collision: the service retries the whole transaction with a
        // suffixed slug and returns the FINAL slug.
        const created = await service.create({
          principal: alphaOwner,
          name: "Lifecycle Workspace",
          slug: collisionBase,
          description: "Part 26 live fixture",
          idempotencyKey: "workspace-live-create-00000001",
        });
        expect(created.slug).toBe(`${collisionBase}-3`);
        expect(created.workspace.currentUserRole).toBe("owner");
        expect(created.workspace.settings).toEqual({ defaultPageSize: "a4" });
        expect(created.workspace.storageLimitBytes).toBeNull();

        const createdId = created.workspace.id;
        const replayed = await service.create({
          principal: alphaOwner,
          name: "Lifecycle Workspace",
          slug: collisionBase,
          description: "Part 26 live fixture",
          idempotencyKey: "workspace-live-create-00000001",
        });
        expect(replayed.workspace.id).toBe(createdId);
        expect(replayed.slug).toBe(created.slug);

        // Owner-membership transactionality: exactly one owner row committed.
        const [membership] = await tx
          .select({ role: workspaceMembers.role })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.workspaceId, createdId));
        expect(membership?.role).toBe("owner");

        // An audit row was written for the create.
        const [createAudit] = await tx
          .select({ action: auditLogs.action })
          .from(auditLogs)
          .where(eq(auditLogs.entityId, createdId));
        expect(createAudit?.action).toBe(WORKSPACE_AUDIT_ACTIONS.create);

        // Authorized read by the owner succeeds and returns the detail.
        const detail = await service.read({
          principal: alphaOwner,
          workspaceId: createdId,
        });
        expect(detail.id).toBe(createdId);
        expect(detail.slug).toBe(`${collisionBase}-3`);

        // Cross-tenant / non-member read is concealed (404), never disclosed.
        await expect(
          service.read({ principal: betaOwner, workspaceId: createdId }),
        ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 404 } });

        // A guessed UUID for a workspace that does not exist is also concealed.
        await expect(
          service.read({
            principal: alphaOwner,
            workspaceId: "30000000-0000-4000-8100-000000000000",
          }),
        ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 404 } });

        // Update by the owner persists and writes an audit row.
        const updated = await service.update({
          principal: alphaOwner,
          workspaceId: createdId,
          name: "Lifecycle Workspace Renamed",
          settings: { defaultPageSize: "letter" },
        });
        expect(updated.workspace.name).toBe("Lifecycle Workspace Renamed");
        expect(updated.workspace.settings).toEqual({ defaultPageSize: "letter" });
        const updateAudits = await tx
          .select({ action: auditLogs.action })
          .from(auditLogs)
          .where(eq(auditLogs.entityId, createdId));
        expect(updateAudits.map((row) => row.action)).toContain(WORKSPACE_AUDIT_ACTIONS.update);

        // An editor (not owner/admin) cannot update settings (settings.update).
        await expect(
          service.update({
            principal: principal(SEED_IDS.users.alphaEditor),
            workspaceId: SEED_IDS.workspaces.alpha,
            name: "Hijacked",
          }),
        ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 403 } });

        // Safe deletion: confirmation required by the transport schema; the
        // service also defense-checks expectedName.
        await expect(
          service.delete({
            principal: alphaOwner,
            workspaceId: createdId,
            confirmed: true,
            expectedName: "Not The Name",
          }),
        ).rejects.toMatchObject({ safeResponse: { code: "VALIDATION_ERROR" } });

        const deleted = await service.delete({
          principal: alphaOwner,
          workspaceId: createdId,
          confirmed: true,
        });
        expect(deleted).toEqual({ id: createdId, deleted: true });

        // The workspace and its membership cascaded away.
        const [goneWorkspace] = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, createdId));
        expect(goneWorkspace).toBeUndefined();
        const [goneMember] = await tx
          .select({ id: workspaceMembers.id })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.workspaceId, createdId));
        expect(goneMember).toBeUndefined();

        // The durable cleanup intent survived via job_outbox.workspace_id
        // SET NULL on cascade. The payload preserves the target workspace id.
        const outboxRows = await tx
          .select()
          .from(jobOutbox)
          .where(eq(jobOutbox.jobType, WORKSPACE_DELETED_JOB_TYPE));
        const intent = outboxRows.find((row) => row.payload.workspaceId === createdId);
        expect(outboxRows.filter((row) => row.payload.workspaceId === createdId)).toHaveLength(1);
        expect(intent).toBeDefined();
        expect(intent?.idempotencyKey).toBe(`workspace-deleted:${createdId}`);
        expect(intent?.workspaceId).toBeNull();
        expect(intent?.queueName).toBe("workspace-cleanup");
        expect(intent?.payload.action).toBe(WORKSPACE_DELETED_JOB_TYPE);
        const searchRows = await tx
          .select()
          .from(jobOutbox)
          .where(eq(jobOutbox.jobType, "workspace.search.purge"));
        const searchIntent = searchRows.find((row) => row.payload.workspaceId === createdId);
        expect(searchIntent).toMatchObject({
          workspaceId: null,
          queueName: "workspace-search-purge",
          idempotencyKey: `workspace-search-purge:${createdId}`,
        });

        const [deletionAudit] = await tx
          .select()
          .from(workspaceDeletionAudits)
          .where(eq(workspaceDeletionAudits.deletedWorkspaceId, createdId));
        expect(deletionAudit).toMatchObject({
          deletedWorkspaceId: createdId,
          actorId: SEED_IDS.users.alphaOwner,
        });

        const workspaceAudits = await tx
          .select({ metadata: auditLogs.metadata })
          .from(auditLogs)
          .where(eq(auditLogs.entityId, createdId));
        expect(JSON.stringify(workspaceAudits)).not.toContain("Lifecycle Workspace");
        expect(JSON.stringify(workspaceAudits)).not.toContain(collisionBase);

        throw new RollbackWorkspacesTest("rollback Part 26 workspace fixtures");
      }),
    ).rejects.toBeInstanceOf(RollbackWorkspacesTest);
  });
});
