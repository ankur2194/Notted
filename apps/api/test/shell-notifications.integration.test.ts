import { resolve } from "node:path";

import { and, eq, isNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationDeniedError } from "../src/authorization/authorization.errors";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import { notifications, schema, workspaceMembers } from "../src/database/schema";
import { SEED_IDS, seedDatabase } from "../src/database/seed";
import { NotificationService } from "../src/notifications/notification.service";
import { ShellService } from "../src/shell/shell.service";
import { TenantContextService } from "../src/tenant";

import { HAS_DATABASE, requireDatabase } from "./database-test-helpers";

import type { DatabaseService } from "../src/database/database.service";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");
type Database = NodePgDatabase<typeof schema>;

class RollbackShellTest extends Error {}

function principal(userId: string): AuthenticatedPrincipal {
  return {
    userId,
    sessionId: `session:${userId}`,
    method: "opaque-session",
    assurance: "single-factor",
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isFresh: true,
  };
}

describe.skipIf(!HAS_DATABASE)("Part 25 shell and notifications (live)", () => {
  let pool: Pool | undefined;
  let db: Database | undefined;

  beforeAll(async () => {
    await requireDatabase();

    pool = new Pool({ connectionString: DATABASE_URL as string, max: 1 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("filters memberships, validates current workspace, scopes ownership, persists reads and rechecks revocation", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL");
      return;
    }

    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const database = {
          db: tx,
          transaction: (work: (inner: typeof tx) => Promise<unknown>) => work(tx),
        } as unknown as DatabaseService;
        const tenant = new TenantContextService();
        const policy = new AuthorizationPolicyService();
        const repository = new AuthorizationRepository(database, tenant);
        const entry = new AuthorizationEntryService(repository, policy, tenant);
        const shell = new ShellService(database, entry, policy, tenant);
        const service = new NotificationService(database, tenant);
        const editor = principal(SEED_IDS.users.alphaEditor);

        /*
         * The count this test controls is the DELTA, not the total.
         *
         * `SEED_IDS.workspaces.alpha` is shared: every suite that mentions
         * `alphaEditor` writes a notification into it, and several commit
         * outside this rollback. Asserting an absolute `2` therefore passed only
         * on a database no other suite had ever touched, and turned one unrelated
         * leak into a permanent failure here — a green that depended on run
         * history, which is the exact class of defect the integration gates
         * exist to remove. Two rows are inserted below; two is what is asserted.
         */
        const unreadBefore = await tx.$count(
          notifications,
          and(
            eq(notifications.recipientUserId, SEED_IDS.users.alphaEditor),
            eq(notifications.workspaceId, SEED_IDS.workspaces.alpha),
            isNull(notifications.readAt),
          ),
        );

        await tx.insert(notifications).values([
          {
            id: "25000000-0000-4000-8000-000000000001",
            workspaceId: SEED_IDS.workspaces.alpha,
            recipientUserId: SEED_IDS.users.alphaEditor,
            kind: "system",
            targetType: "workspace",
            targetId: SEED_IDS.workspaces.alpha,
            summary: "Workspace policy updated",
            targetLabel: "Alpha",
          },
          {
            id: "25000000-0000-4000-8000-000000000002",
            workspaceId: SEED_IDS.workspaces.alpha,
            recipientUserId: SEED_IDS.users.alphaEditor,
            kind: "workspace",
            summary: "Workspace notice",
          },
          {
            id: "25000000-0000-4000-8000-000000000003",
            workspaceId: SEED_IDS.workspaces.alpha,
            recipientUserId: SEED_IDS.users.alphaViewer,
            kind: "system",
            summary: "Another recipient only",
          },
          {
            id: "25000000-0000-4000-8000-000000000004",
            workspaceId: SEED_IDS.workspaces.beta,
            recipientUserId: SEED_IDS.users.betaOwner,
            kind: "system",
            summary: "Other tenant only",
          },
        ]);

        const bootstrap = await shell.bootstrap(editor, SEED_IDS.workspaces.alpha);
        expect(
          bootstrap.workspaces.every(
            (workspace) => workspace.workspaceId !== SEED_IDS.workspaces.beta,
          ),
        ).toBe(true);
        expect(bootstrap.currentWorkspace?.workspaceId).toBe(SEED_IDS.workspaces.alpha);
        expect(bootstrap.notificationUnreadCount - unreadBefore).toBe(2);
        expect(bootstrap.permissions).toMatchObject({
          canViewSettings: true,
          canCreateContent: true,
          canManageWorkspace: false,
        });
        expect(JSON.stringify(bootstrap)).not.toContain("Another recipient only");
        await expect(shell.bootstrap(editor, SEED_IDS.workspaces.beta)).rejects.toMatchObject({
          status: 404,
        });

        const operation = await entry.authorizeUser({
          principal: editor,
          workspaceId: SEED_IDS.workspaces.alpha,
          action: "workspace.read",
          resource: { kind: "workspace" },
        });
        await entry.run(operation, async () => {
          const firstPage = await service.list({
            recipientUserId: editor.userId,
            page: 1,
            limit: 1,
            unreadOnly: false,
          });
          expect(firstPage.items).toHaveLength(1);
          expect(firstPage.hasMore).toBe(true);
          expect(firstPage.items[0]?.summary).not.toContain("Another recipient");

          await expect(
            service.setReadState({
              notificationId: "25000000-0000-4000-8000-000000000003",
              recipientUserId: editor.userId,
              isRead: true,
            }),
          ).rejects.toMatchObject({ status: 404 });
          await expect(
            service.setReadState({
              notificationId: "25000000-0000-4000-8000-000000000004",
              recipientUserId: editor.userId,
              isRead: true,
            }),
          ).rejects.toMatchObject({ status: 404 });
          await expect(
            service.setReadState({
              notificationId: "25000000-0000-4000-8000-000000009999",
              recipientUserId: editor.userId,
              isRead: true,
            }),
          ).rejects.toMatchObject({ status: 404 });

          const read = await service.setReadState({
            notificationId: "25000000-0000-4000-8000-000000000001",
            recipientUserId: editor.userId,
            isRead: true,
          });
          expect(read.notification.readAt).not.toBeNull();
          expect(
            (
              await service.list({
                recipientUserId: editor.userId,
                page: 1,
                limit: 10,
                unreadOnly: false,
              })
            ).items.find(({ id }) => id === read.notification.id)?.readAt,
          ).not.toBeNull();

          await service.setReadState({
            notificationId: read.notification.id,
            recipientUserId: editor.userId,
            isRead: false,
          });
          const marked = await service.markAllRead(editor.userId);
          expect(marked.unreadCount).toBe(0);
          expect(
            await tx
              .select()
              .from(notifications)
              .where(
                and(
                  eq(notifications.workspaceId, SEED_IDS.workspaces.alpha),
                  eq(notifications.recipientUserId, editor.userId),
                  isNull(notifications.readAt),
                ),
              ),
          ).toHaveLength(0);
        });

        await tx
          .delete(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, SEED_IDS.workspaces.alpha),
              eq(workspaceMembers.userId, editor.userId),
            ),
          );
        await expect(shell.bootstrap(editor, SEED_IDS.workspaces.alpha)).rejects.toMatchObject({
          status: 404,
        });
        await expect(
          entry.authorizeUser({
            principal: editor,
            workspaceId: SEED_IDS.workspaces.alpha,
            action: "workspace.read",
            resource: { kind: "workspace" },
          }),
        ).rejects.toBeInstanceOf(AuthorizationDeniedError);
        throw new RollbackShellTest();
      }),
    ).rejects.toBeInstanceOf(RollbackShellTest);
  });
});
