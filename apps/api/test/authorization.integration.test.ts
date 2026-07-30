import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
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
  schema,
  webhooks,
  workspaceMembers,
} from "../src/database/schema";
import { SEED_IDS, seedDatabase } from "../src/database/seed";
import { TenantContextService } from "../src/tenant";

import type { DatabaseService } from "../src/database/database.service";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

const DATABASE_URL = process.env.DATABASE_URL;
const HAS_DATABASE_URL = typeof DATABASE_URL === "string" && DATABASE_URL.trim() !== "";
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");
const CONNECTION_TIMEOUT_MS = 2_000;

type Database = NodePgDatabase<typeof schema>;

class RollbackAuthorizationTest extends Error {}

async function isDatabaseReachable(connectionString: string): Promise<boolean> {
  const client = new Client({ connectionString, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS });
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

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

describe.skipIf(!HAS_DATABASE_URL)("Part 24 centralized authorization (live)", () => {
  let pool: Pool | undefined;
  let db: Database | undefined;
  let reachable = false;

  beforeAll(async () => {
    reachable = await isDatabaseReachable(DATABASE_URL as string);
    if (!reachable) return;
    pool = new Pool({ connectionString: DATABASE_URL as string, max: 1 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  it("enforces live Alpha/Beta membership, parent scope, grants, reads, and mutation policy", async ({
    skip,
  }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const tenant = new TenantContextService();
        const database = { db: tx } as unknown as DatabaseService;
        const repository = new AuthorizationRepository(database, tenant);
        const policy = new AuthorizationPolicyService();
        const entry = new AuthorizationEntryService(repository, policy, tenant);
        const adapters = new AuthorizationAdaptersService(entry);

        const alphaEditor = principal(SEED_IDS.users.alphaEditor);
        const alphaViewer = principal(SEED_IDS.users.alphaViewer);
        const alphaAdmin = principal(SEED_IDS.users.alphaAdmin);
        const betaOwner = principal(SEED_IDS.users.betaOwner);

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

        // One project grant makes the project restricted. An edit note share
        // cannot broaden it for a target who lacks project access.
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

        throw new RollbackAuthorizationTest("rollback Part 24 authorization fixtures");
      }),
    ).rejects.toBeInstanceOf(RollbackAuthorizationTest);
  });
});
