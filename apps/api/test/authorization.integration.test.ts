import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationAdaptersService } from "../src/authorization/authorization-adapters.service";
import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationDeniedError } from "../src/authorization/authorization.errors";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import {
  apiKeys,
  exportJobs,
  noteShares,
  projectAccess,
  projects,
  schema,
  webhooks,
  workspaceMembers,
} from "../src/database/schema";
import { SEED_IDS, seedDatabase } from "../src/database/seed";
import { TenantContextService } from "../src/tenant";

import { HAS_DATABASE, requireDatabase } from "./database-test-helpers";

import type { DatabaseService, DatabaseTransaction } from "../src/database/database.service";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");

type Database = NodePgDatabase<typeof schema>;

class RollbackAuthorizationTest extends Error {}

function principal(userId: string, fresh = true): AuthenticatedPrincipal {
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

describe.skipIf(!HAS_DATABASE)("Part 24 centralized authorization (live)", () => {
  let pool: Pool | undefined;
  let db: Database | undefined;

  beforeAll(async () => {
    await requireDatabase();

    pool = new Pool({ connectionString: DATABASE_URL as string, max: 1 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  interface AuthorizationFixture {
    readonly tx: DatabaseTransaction;
    readonly adapters: AuthorizationAdaptersService;
    readonly alphaEditor: AuthenticatedPrincipal;
    readonly alphaViewer: AuthenticatedPrincipal;
    readonly alphaAdmin: AuthenticatedPrincipal;
    readonly betaOwner: AuthenticatedPrincipal;
  }

  /**
   * One seeded, rolled-back transaction with the authorization stack wired to it.
   *
   * Part 78 (R33). This whole live suite used to be a single `it`, so a failure in
   * the very first concealment probe reported the same red line as a failure in
   * the last revocation assertion, and everything after the failure never ran —
   * on the file that proves tenant isolation. Each named case below is
   * self-contained against the seed; none of them depends on durable state a
   * previous section left behind.
   */
  async function withAuthorization(
    db: NodePgDatabase<typeof schema>,
    work: (fixture: AuthorizationFixture) => Promise<void>,
  ): Promise<void> {
    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const tenant = new TenantContextService();
        const database = { db: tx } as unknown as DatabaseService;
        const entry = new AuthorizationEntryService(
          new AuthorizationRepository(database, tenant),
          new AuthorizationPolicyService(),
          tenant,
        );
        await work({
          tx: tx as unknown as DatabaseTransaction,
          adapters: new AuthorizationAdaptersService(entry),
          alphaEditor: principal(SEED_IDS.users.alphaEditor),
          alphaViewer: principal(SEED_IDS.users.alphaViewer),
          alphaAdmin: principal(SEED_IDS.users.alphaAdmin),
          betaOwner: principal(SEED_IDS.users.betaOwner),
        });
        throw new RollbackAuthorizationTest("rollback Part 24 authorization fixtures");
      }),
    ).rejects.toBeInstanceOf(RollbackAuthorizationTest);
  }

  it("reads a note it is entitled to and conceals every identifier it is not", async ({ skip }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }
    await withAuthorization(db, async ({ adapters, alphaEditor, betaOwner }) => {
      await expect(
        adapters.authorizeRest({
          principal: alphaEditor,
          workspaceId: SEED_IDS.workspaces.alpha,
          action: "note.read",
          resource: { kind: "note", id: SEED_IDS.notes.alphaPinnedRoot },
        }),
      ).resolves.toMatchObject({ decision: { allowed: true } });

      // A supplied workspace UUID is only a selector. Cross-tenant, random,
      // and same-shape probes all receive the same concealed result.
      for (const probe of [
        SEED_IDS.notes.betaRoot,
        "20000000-0000-4000-8500-000000009999",
        SEED_IDS.projects.betaResearch,
      ]) {
        await expect(
          adapters.authorizeRest({
            principal: alphaEditor,
            workspaceId: SEED_IDS.workspaces.alpha,
            action: probe === SEED_IDS.projects.betaResearch ? "project.read" : "note.read",
            resource:
              probe === SEED_IDS.projects.betaResearch
                ? { kind: "project", id: probe }
                : { kind: "note", id: probe },
          }),
        ).rejects.toMatchObject({
          decision: { allowed: false, httpStatus: 404, code: "authorization.concealed" },
        });
      }

      await expect(
        adapters.authorizeRest({
          principal: betaOwner,
          workspaceId: SEED_IDS.workspaces.alpha,
          action: "workspace.read",
          resource: { kind: "workspace" },
        }),
      ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    });
  });

  it("refuses a note share that would broaden a restricted project for a target without access", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }
    await withAuthorization(db, async ({ tx, adapters, alphaEditor, alphaViewer, alphaAdmin }) => {
      // Explicit durable state makes the project restricted. An edit note share
      // cannot broaden it for a target who lacks project access.
      await tx
        .update(projects)
        .set({ isRestricted: true })
        .where(eq(projects.id, SEED_IDS.projects.alphaLaunch));
      await tx
        .insert(projectAccess)
        .values({
          id: "24000000-0000-4000-9000-000000000001",
          projectId: SEED_IDS.projects.alphaLaunch,
          userId: SEED_IDS.users.alphaEditor,
          role: "editor",
          createdById: SEED_IDS.users.alphaAdmin,
        })
        .onConflictDoUpdate({
          target: [projectAccess.projectId, projectAccess.userId],
          set: { role: "editor" },
        });
      await tx
        .insert(noteShares)
        .values([
          {
            id: "24000000-0000-4000-9000-000000000002",
            noteId: SEED_IDS.notes.alphaProjectOverview,
            userId: SEED_IDS.users.alphaEditor,
            permission: "edit",
            createdById: SEED_IDS.users.alphaAdmin,
          },
          {
            id: "24000000-0000-4000-9000-000000000003",
            noteId: SEED_IDS.notes.alphaProjectOverview,
            userId: SEED_IDS.users.alphaViewer,
            permission: "edit",
            createdById: SEED_IDS.users.alphaAdmin,
          },
        ])
        .onConflictDoNothing();

      await expect(
        adapters.authorizeTrpc({
          principal: alphaEditor,
          workspaceId: SEED_IDS.workspaces.alpha,
          action: "note.update",
          resource: { kind: "note", id: SEED_IDS.notes.alphaProjectOverview },
        }),
      ).resolves.toMatchObject({ decision: { allowed: true } });
      await expect(
        adapters.authorizeTrpc({
          principal: alphaViewer,
          workspaceId: SEED_IDS.workspaces.alpha,
          action: "note.read",
          resource: { kind: "note", id: SEED_IDS.notes.alphaProjectOverview },
        }),
      ).rejects.toMatchObject({ decision: { allowed: false } });

      await expect(
        adapters.authorizeRest({
          principal: alphaAdmin,
          workspaceId: SEED_IDS.workspaces.alpha,
          action: "note.share",
          resource: {
            kind: "note",
            id: SEED_IDS.notes.alphaProjectOverview,
            delegation: {
              requestedPermission: "edit",
              targetUserId: SEED_IDS.users.alphaViewer,
            },
          },
        }),
      ).rejects.toMatchObject({ decision: { allowed: false } });
      await tx.insert(projectAccess).values({
        id: "24000000-0000-4000-9000-000000000005",
        projectId: SEED_IDS.projects.alphaLaunch,
        userId: SEED_IDS.users.alphaViewer,
        role: "viewer",
        createdById: SEED_IDS.users.alphaAdmin,
      });
      await expect(
        adapters.authorizeRest({
          principal: alphaAdmin,
          workspaceId: SEED_IDS.workspaces.alpha,
          action: "note.share",
          resource: {
            kind: "note",
            id: SEED_IDS.notes.alphaProjectOverview,
            delegation: {
              requestedPermission: "comment",
              targetUserId: SEED_IDS.users.alphaViewer,
            },
          },
        }),
      ).resolves.toMatchObject({ decision: { allowed: true } });
    });
  });

  it("proves comment and attachment workspace through the parent note before policy", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }
    await withAuthorization(db, async ({ adapters, alphaEditor, betaOwner }) => {
      // Constrained-parent loaders prove comment and attachment workspace
      // through their note before policy evaluation.
      await expect(
        adapters.authorizeSocketMessage({
          principal: alphaEditor,
          workspaceId: SEED_IDS.workspaces.alpha,
          action: "comment.read",
          resource: { kind: "comment", id: SEED_IDS.comments.alphaThread },
        }),
      ).resolves.toMatchObject({ decision: { allowed: true } });
      await expect(
        adapters.authorizeFile({
          principal: betaOwner,
          workspaceId: SEED_IDS.workspaces.beta,
          action: "file.read",
          resource: { kind: "file", id: SEED_IDS.attachments.alphaBrief },
        }),
      ).rejects.toMatchObject({ decision: { httpStatus: 404 } });
    });
  });

  it("refuses cross-tenant tags and assignees smuggled through UUID-shaped input", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }
    await withAuthorization(db, async ({ adapters, alphaEditor }) => {
      // Two-hop write selectors are server-proven: cross-tenant tags and
      // assignees cannot be smuggled through UUID-shaped input.
      await expect(
        adapters.authorizeTrpc({
          principal: alphaEditor,
          workspaceId: SEED_IDS.workspaces.alpha,
          action: "note.tag",
          resource: {
            kind: "note",
            id: SEED_IDS.notes.alphaProjectOverview,
            tagId: SEED_IDS.tags.betaResearch,
          },
        }),
      ).rejects.toMatchObject({ decision: { httpStatus: 404 } });
      await expect(
        adapters.authorizeTrpc({
          principal: alphaEditor,
          workspaceId: SEED_IDS.workspaces.alpha,
          action: "task.assign",
          resource: {
            kind: "task",
            id: SEED_IDS.tasks.alphaStandaloneFollowUp,
            targetUserId: SEED_IDS.users.betaOwner,
          },
        }),
      ).rejects.toMatchObject({ decision: { allowed: false } });
      await expect(
        adapters.authorizeTrpc({
          principal: alphaEditor,
          workspaceId: SEED_IDS.workspaces.alpha,
          action: "task.assign",
          resource: {
            kind: "task",
            id: SEED_IDS.tasks.alphaStandaloneFollowUp,
            targetUserId: SEED_IDS.users.alphaViewer,
          },
        }),
      ).resolves.toMatchObject({ decision: { allowed: true } });
    });
  });

  it("authorizes administrative creation against the workspace root, never a client claim", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }
    await withAuthorization(db, async ({ tx, adapters, alphaEditor, alphaAdmin }) => {
      // Administrative creation controls authorize against the workspace
      // root; no client permission assertion is accepted.
      for (const action of ["apiKey.create", "webhook.create"] as const) {
        await expect(
          adapters.authorizeRest({
            principal: alphaAdmin,
            workspaceId: SEED_IDS.workspaces.alpha,
            action,
            resource: { kind: "workspace" },
          }),
        ).resolves.toMatchObject({ decision: { allowed: true } });
        await expect(
          adapters.authorizeRest({
            principal: alphaEditor,
            workspaceId: SEED_IDS.workspaces.alpha,
            action,
            resource: { kind: "workspace" },
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });
      }

      await tx.insert(apiKeys).values({
        id: "24000000-0000-4000-9000-000000000006",
        workspaceId: SEED_IDS.workspaces.alpha,
        createdById: SEED_IDS.users.alphaAdmin,
        name: "Part 24 fixture key",
        keyHash: "part24-fixture-hash-only",
        keyPrefix: "p24_key_",
      });
      await tx.insert(webhooks).values({
        id: "24000000-0000-4000-9000-000000000007",
        workspaceId: SEED_IDS.workspaces.alpha,
        createdById: SEED_IDS.users.alphaAdmin,
        url: "https://example.invalid/part-24",
        encryptedSecret: "encrypted-fixture-only",
        encryptionKeyVersion: 1,
      });
      await expect(
        adapters.authorizeRest({
          principal: alphaAdmin,
          workspaceId: SEED_IDS.workspaces.alpha,
          action: "apiKey.revoke",
          resource: { kind: "apiKey", id: "24000000-0000-4000-9000-000000000006" },
        }),
      ).resolves.toMatchObject({ decision: { allowed: true } });
      await expect(
        adapters.authorizeRest({
          principal: alphaAdmin,
          workspaceId: SEED_IDS.workspaces.alpha,
          action: "webhook.delete",
          resource: { kind: "webhook", id: "24000000-0000-4000-9000-000000000007" },
        }),
      ).resolves.toMatchObject({ decision: { allowed: true } });

      await tx.insert(exportJobs).values({
        id: "24000000-0000-4000-9000-000000000004",
        workspaceId: SEED_IDS.workspaces.alpha,
        requestedById: SEED_IDS.users.alphaEditor,
        format: "pdf",
        status: "ready",
        sourceType: "note",
        sourceId: SEED_IDS.notes.alphaProjectOverview,
      });
      await expect(
        adapters.authorizeFile({
          principal: alphaEditor,
          workspaceId: SEED_IDS.workspaces.alpha,
          action: "export.download",
          resource: { kind: "export", id: "24000000-0000-4000-9000-000000000004" },
        }),
      ).resolves.toMatchObject({ decision: { allowed: true } });
    });
  });

  it("applies a role change and a revocation on the very next call", async ({ skip }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }
    await withAuthorization(db, async ({ tx, adapters, alphaEditor }) => {
      // Role changes and revocation take effect on the next call; no session
      // or previous authorization result carries workspace authority.
      await tx
        .update(workspaceMembers)
        .set({ role: "viewer" })
        .where(eq(workspaceMembers.id, SEED_IDS.memberships.alphaEditor));
      await expect(
        adapters.authorizeRest({
          principal: alphaEditor,
          workspaceId: SEED_IDS.workspaces.alpha,
          action: "note.update",
          resource: { kind: "note", id: SEED_IDS.notes.alphaProjectOverview },
        }),
      ).rejects.toMatchObject({ decision: { allowed: false } });

      await tx
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.id, SEED_IDS.memberships.alphaEditor));
      await expect(
        adapters.authorizeRest({
          principal: alphaEditor,
          workspaceId: SEED_IDS.workspaces.alpha,
          action: "note.read",
          resource: { kind: "note", id: SEED_IDS.notes.alphaPinnedRoot },
        }),
      ).rejects.toMatchObject({ decision: { httpStatus: 404 } });
      await expect(
        adapters.authorizeUserJob({
          userId: SEED_IDS.users.alphaEditor,
          workspaceId: SEED_IDS.workspaces.alpha,
          action: "note.read",
          resource: { kind: "note", id: SEED_IDS.notes.alphaPinnedRoot },
          correlationId: "revoked-user-job",
        }),
      ).rejects.toMatchObject({ decision: { httpStatus: 404 } });
    });
  });

  /*
   * THE POOL-EXHAUSTION DEFECT.
   *
   * `AuthorizationRepository` read every fact through `this.database.db`, the
   * POOL, with no way to be handed a transaction. `NotesService.move()` and the
   * delete/restore path both re-authorize each descendant note from INSIDE an
   * open transaction — so each check took a second connection while the first
   * was still held. At the default `DATABASE_POOL_MAX_CONNECTIONS` of 10, ten
   * concurrent moves hold all ten and then each waits for a connection only
   * another waiter could release: the pool deadlocks and every request fails.
   *
   * `max: 1` turns that from a ten-way race into a deterministic single-
   * connection deadlock, which is the whole point — the failure is a hang until
   * `connectionTimeoutMillis`, not an error, so it has to be forced to be seen.
   */
  it("authorizes through an open transaction without taking a second connection", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const single = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 3_000,
    });
    try {
      const scoped = drizzle(single, { schema });
      await expect(
        scoped.transaction(async (tx) => {
          const tenant = new TenantContextService();
          // The pool, NOT the transaction — exactly how the services hold it.
          const database = { db: scoped } as unknown as DatabaseService;
          const repository = new AuthorizationRepository(database, tenant);
          const entry = new AuthorizationEntryService(
            repository,
            new AuthorizationPolicyService(),
            tenant,
          );

          const authorized = await entry.authorizeUser({
            principal: principal(SEED_IDS.users.alphaEditor),
            workspaceId: SEED_IDS.workspaces.alpha,
            action: "note.read",
            resource: { kind: "note", id: SEED_IDS.notes.alphaPinnedRoot },
            db: tx,
          });
          expect(authorized).toBeDefined();
          throw new RollbackAuthorizationPoolTest();
        }),
      ).rejects.toBeInstanceOf(RollbackAuthorizationPoolTest);
    } finally {
      await single.end().catch(() => undefined);
    }
  });
});
class RollbackAuthorizationPoolTest extends Error {}
