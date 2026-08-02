import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import { DatabaseService, type DatabaseTransaction } from "../src/database/database.service";
import {
  attachments,
  auditLogs,
  jobOutbox,
  notes,
  projectAccess,
  projects,
  schema,
  tasks,
} from "../src/database/schema";
import { SEED_IDS, seedDatabase } from "../src/database/seed";
import {
  PROJECT_AUDIT_ACTIONS,
  PROJECT_DOMAIN_EVENT_QUEUE,
  PROJECT_DOMAIN_EVENTS,
} from "../src/projects/projects.constants";
import { ProjectsService } from "../src/projects/projects.service";
import { TenantContextService } from "../src/tenant";

import type { AuthenticatedPrincipal } from "@notted/shared-types";

const DATABASE_URL = process.env.DATABASE_URL;
const HAS_DATABASE_URL = typeof DATABASE_URL === "string" && DATABASE_URL.trim() !== "";
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");
const CONNECTION_TIMEOUT_MS = 2_000;

class RollbackProjectsTest extends Error {}

function principal(userId: string): AuthenticatedPrincipal {
  return Object.freeze({
    userId,
    sessionId: `session:${userId}`,
    method: "opaque-session",
    assurance: "single-factor",
    authenticatedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isFresh: true,
  });
}

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

describe.skipIf(!HAS_DATABASE_URL)("Part 29 project CRUD (live)", () => {
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;
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

  it("covers CRUD, authorized pagination, statuses, tenant denial, retention, delete nullification, and durable intents", async ({
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
        const database = {
          db: tx,
          transaction: <T>(work: (scope: DatabaseTransaction) => Promise<T>): Promise<T> =>
            tx.transaction(work),
        } as unknown as DatabaseService;
        const repository = new AuthorizationRepository(database, tenant);
        const entry = new AuthorizationEntryService(
          repository,
          new AuthorizationPolicyService(),
          tenant,
        );
        const service = new ProjectsService(database, entry, tenant);
        const owner = principal(SEED_IDS.users.alphaOwner);
        const admin = principal(SEED_IDS.users.alphaAdmin);
        const editor = principal(SEED_IDS.users.alphaEditor);
        const viewer = principal(SEED_IDS.users.alphaViewer);
        const betaOwner = principal(SEED_IDS.users.betaOwner);

        await expect(
          service.create({
            principal: editor,
            workspaceId: SEED_IDS.workspaces.alpha,
            name: "Editor cannot create projects",
          }),
        ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 403 } });

        const pendingAttachmentId = randomUUID();
        await tx.insert(attachments).values({
          id: pendingAttachmentId,
          noteId: SEED_IDS.notes.alphaProjectOverview,
          workspaceId: SEED_IDS.workspaces.alpha,
          originalName: "pending.png",
          filename: "pending.png",
          mimeType: "image/png",
          sizeBytes: 128,
          storageKey: `pending/${pendingAttachmentId}`,
          mediaType: "image",
          processingStatus: "pending",
          createdById: SEED_IDS.users.alphaOwner,
        });
        for (const coverImageUrl of [
          `/api/v1/attachments/${randomUUID()}`,
          `/api/v1/attachments/${pendingAttachmentId}`,
        ]) {
          await expect(
            service.create({
              principal: owner,
              workspaceId: SEED_IDS.workspaces.alpha,
              name: "Denied cover",
              coverImageUrl,
            }),
          ).rejects.toMatchObject({ safeResponse: { code: "NOT_FOUND" } });
        }
        await expect(
          service.create({
            principal: betaOwner,
            workspaceId: SEED_IDS.workspaces.beta,
            name: "Cross-tenant cover",
            coverImageUrl: `/api/v1/attachments/${SEED_IDS.attachments.alphaBrief}`,
          }),
        ).rejects.toMatchObject({ safeResponse: { code: "NOT_FOUND" } });

        const created = await service.create({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          name: "Zulu Part 29",
          description: "Mutable fixture",
          coverImageUrl: `/api/v1/attachments/${SEED_IDS.attachments.alphaBrief}`,
          color: "#abcdef",
          status: "completed",
          dueAt: "2026-08-10T12:00:00+05:30",
          idempotencyKey: "project-live-create-00000001",
        });
        expect(created.project).toMatchObject({
          name: "Zulu Part 29",
          coverImageUrl: `/api/v1/attachments/${SEED_IDS.attachments.alphaBrief}`,
          color: "#abcdef",
          status: "completed",
          isArchived: false,
          isRestricted: false,
          dueAt: "2026-08-10T06:30:00.000Z",
        });
        const replayed = await service.create({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          name: "Zulu Part 29",
          description: "Mutable fixture",
          coverImageUrl: `/api/v1/attachments/${SEED_IDS.attachments.alphaBrief}`,
          color: "#abcdef",
          status: "completed",
          dueAt: "2026-08-10T12:00:00+05:30",
          idempotencyKey: "project-live-create-00000001",
        });
        expect(replayed.project.id).toBe(created.project.id);

        const second = await service.create({
          principal: admin,
          workspaceId: SEED_IDS.workspaces.alpha,
          name: "Alpha Part 29",
          status: "active",
          dueAt: "2026-08-02T00:00:00Z",
        });
        const detail = await service.read({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          projectId: created.project.id,
        });
        expect(detail.dueAt).toBe("2026-08-10T06:30:00.000Z");

        const updated = await service.update({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          projectId: created.project.id,
          name: "Zulu Updated",
          dueAt: null,
          coverImageUrl: null,
          status: "archived",
        });
        expect(updated.project).toMatchObject({
          name: "Zulu Updated",
          dueAt: null,
          coverImageUrl: null,
          status: "archived",
          isArchived: true,
        });
        expect(
          await tx
            .select({ status: projects.status, isArchived: projects.isArchived })
            .from(projects)
            .where(eq(projects.id, created.project.id)),
        ).toEqual([{ status: "archived", isArchived: true }]);

        const filtered = await service.list({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          page: 1,
          limit: 1,
          status: "active",
          archived: false,
          dueFrom: "2026-08-01T00:00:00Z",
          dueTo: "2026-08-03T00:00:00Z",
          name: "Part 29",
          sortBy: "name",
          sortDirection: "asc",
        });
        expect(filtered.items.map((project) => project.id)).toEqual([second.project.id]);
        expect(filtered.hasMore).toBe(false);

        const sortedPage = await service.list({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          page: 1,
          limit: 2,
          sortBy: "name",
          sortDirection: "asc",
        });
        expect(sortedPage.items).toHaveLength(2);
        expect(sortedPage.hasMore).toBe(true);
        expect(
          sortedPage.items[0]?.name.localeCompare(sortedPage.items[1]?.name ?? ""),
        ).toBeLessThanOrEqual(0);

        // Restriction is explicit and durable. Owner/admin bypass; editor
        // needs an explicit grant; viewer has none and must see neither the
        // ID nor an inflated hasMore/count signal in authorized pagination.
        await tx
          .update(projects)
          .set({ isRestricted: true })
          .where(eq(projects.id, created.project.id));
        await tx.insert(projectAccess).values({
          id: randomUUID(),
          projectId: created.project.id,
          userId: SEED_IDS.users.alphaEditor,
          role: "editor",
          createdById: SEED_IDS.users.alphaOwner,
        });
        await expect(
          service.read({
            principal: editor,
            workspaceId: SEED_IDS.workspaces.alpha,
            projectId: created.project.id,
          }),
        ).resolves.toMatchObject({ id: created.project.id });
        await expect(
          service.read({
            principal: viewer,
            workspaceId: SEED_IDS.workspaces.alpha,
            projectId: created.project.id,
          }),
        ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 403 } });
        await expect(
          service.read({
            principal: admin,
            workspaceId: SEED_IDS.workspaces.alpha,
            projectId: created.project.id,
          }),
        ).resolves.toMatchObject({ id: created.project.id });
        const viewerPage = await service.list({
          principal: viewer,
          workspaceId: SEED_IDS.workspaces.alpha,
          page: 1,
          limit: 10,
          name: "Zulu Updated",
          sortBy: "updatedAt",
          sortDirection: "desc",
        });
        expect(viewerPage).toMatchObject({ items: [], hasMore: false });

        await tx.insert(projectAccess).values({
          id: randomUUID(),
          projectId: created.project.id,
          userId: SEED_IDS.users.alphaViewer,
          role: "viewer",
          createdById: SEED_IDS.users.alphaOwner,
        });
        await expect(
          service.read({
            principal: viewer,
            workspaceId: SEED_IDS.workspaces.alpha,
            projectId: created.project.id,
          }),
        ).resolves.toMatchObject({ id: created.project.id });

        await expect(
          service.update({
            principal: viewer,
            workspaceId: SEED_IDS.workspaces.alpha,
            projectId: created.project.id,
            name: "Denied",
          }),
        ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 403 } });
        await expect(
          service.update({
            principal: editor,
            workspaceId: SEED_IDS.workspaces.alpha,
            projectId: created.project.id,
            name: "Delegated edit",
          }),
        ).resolves.toMatchObject({ project: { name: "Delegated edit" } });
        await expect(
          service.delete({
            principal: editor,
            workspaceId: SEED_IDS.workspaces.alpha,
            projectId: created.project.id,
          }),
        ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 403 } });

        await tx.delete(projectAccess).where(eq(projectAccess.projectId, created.project.id));
        expect(
          await tx
            .select({ isRestricted: projects.isRestricted })
            .from(projects)
            .where(eq(projects.id, created.project.id)),
        ).toEqual([{ isRestricted: true }]);
        await expect(
          service.read({
            principal: viewer,
            workspaceId: SEED_IDS.workspaces.alpha,
            projectId: created.project.id,
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });
        const zeroGranteePage = await service.list({
          principal: editor,
          workspaceId: SEED_IDS.workspaces.alpha,
          page: 1,
          limit: 10,
          name: "Delegated edit",
          sortBy: "updatedAt",
          sortDirection: "desc",
        });
        expect(zeroGranteePage.items).toEqual([]);

        // Cross-workspace and guessed IDs are concealed for read and mutation.
        await expect(
          service.read({
            principal: owner,
            workspaceId: SEED_IDS.workspaces.alpha,
            projectId: SEED_IDS.projects.betaResearch,
          }),
        ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 404 } });
        await expect(
          service.list({
            principal: betaOwner,
            workspaceId: SEED_IDS.workspaces.alpha,
            page: 1,
            limit: 25,
            sortBy: "updatedAt",
            sortDirection: "desc",
          }),
        ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 404 } });
        await expect(
          service.archive({
            principal: betaOwner,
            workspaceId: SEED_IDS.workspaces.beta,
            projectId: created.project.id,
          }),
        ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 404 } });
        await expect(
          service.delete({
            principal: owner,
            workspaceId: SEED_IDS.workspaces.alpha,
            projectId: randomUUID(),
          }),
        ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 404 } });

        const archiveProject = await service.create({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          name: "Archive retains links",
        });
        const archiveNoteId = randomUUID();
        const archiveTaskId = randomUUID();
        await tx.insert(notes).values({
          id: archiveNoteId,
          workspaceId: SEED_IDS.workspaces.alpha,
          projectId: archiveProject.project.id,
          title: "Retained note",
          createdById: SEED_IDS.users.alphaOwner,
        });
        await tx.insert(tasks).values({
          id: archiveTaskId,
          workspaceId: SEED_IDS.workspaces.alpha,
          projectId: archiveProject.project.id,
          title: "Retained task",
          createdById: SEED_IDS.users.alphaOwner,
        });
        const archived = await service.archive({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          projectId: archiveProject.project.id,
        });
        expect(archived.project).toMatchObject({ status: "archived", isArchived: true });
        expect(
          await tx
            .select({ projectId: notes.projectId })
            .from(notes)
            .where(eq(notes.id, archiveNoteId)),
        ).toEqual([{ projectId: archiveProject.project.id }]);
        expect(
          await tx
            .select({ projectId: tasks.projectId })
            .from(tasks)
            .where(eq(tasks.id, archiveTaskId)),
        ).toEqual([{ projectId: archiveProject.project.id }]);

        const deleteProject = await service.create({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          name: "Delete detaches links",
        });
        const deleteNoteId = randomUUID();
        const deleteTaskId = randomUUID();
        const betaTaskId = randomUUID();
        await tx.insert(notes).values({
          id: deleteNoteId,
          workspaceId: SEED_IDS.workspaces.alpha,
          projectId: deleteProject.project.id,
          title: "Surviving note",
          createdById: SEED_IDS.users.alphaOwner,
        });
        await tx.insert(tasks).values([
          {
            id: deleteTaskId,
            workspaceId: SEED_IDS.workspaces.alpha,
            projectId: deleteProject.project.id,
            title: "Surviving task",
            createdById: SEED_IDS.users.alphaOwner,
          },
          {
            id: betaTaskId,
            workspaceId: SEED_IDS.workspaces.beta,
            projectId: SEED_IDS.projects.betaResearch,
            title: "Unrelated beta task",
            createdById: SEED_IDS.users.betaOwner,
          },
        ]);
        await service.delete({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          projectId: deleteProject.project.id,
        });
        expect(
          await tx
            .select({ id: notes.id, projectId: notes.projectId })
            .from(notes)
            .where(eq(notes.id, deleteNoteId)),
        ).toEqual([{ id: deleteNoteId, projectId: null }]);
        expect(
          await tx
            .select({ id: tasks.id, projectId: tasks.projectId })
            .from(tasks)
            .where(eq(tasks.id, deleteTaskId)),
        ).toEqual([{ id: deleteTaskId, projectId: null }]);
        expect(
          await tx
            .select({ projectId: tasks.projectId })
            .from(tasks)
            .where(eq(tasks.id, betaTaskId)),
        ).toEqual([{ projectId: SEED_IDS.projects.betaResearch }]);

        // One project exercises all six event/audit variants. Identifier-only
        // payload shape and unique producer idempotency are asserted directly.
        const eventProject = await service.create({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          name: "Event fixture",
        });
        await service.update({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          projectId: eventProject.project.id,
          color: "#123456",
        });
        await service.archive({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          projectId: eventProject.project.id,
        });
        await service.complete({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          projectId: eventProject.project.id,
        });
        await service.restore({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          projectId: eventProject.project.id,
        });
        await service.delete({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          projectId: eventProject.project.id,
        });

        const audits = await tx
          .select({ action: auditLogs.action })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.entityType, "project"),
              eq(auditLogs.entityId, eventProject.project.id),
            ),
          );
        expect(audits.map((value) => value.action)).toEqual(
          expect.arrayContaining(Object.values(PROJECT_AUDIT_ACTIONS)),
        );
        const events = await tx
          .select()
          .from(jobOutbox)
          .where(eq(jobOutbox.workspaceId, SEED_IDS.workspaces.alpha));
        const projectEvents = events.filter((event) =>
          event.payload.resourceIds?.includes(eventProject.project.id),
        );
        expect(projectEvents.map((event) => event.jobType)).toEqual(
          expect.arrayContaining(Object.values(PROJECT_DOMAIN_EVENTS)),
        );
        expect(new Set(projectEvents.map((event) => event.idempotencyKey)).size).toBe(6);
        for (const event of projectEvents) {
          expect(event.queueName).toBe(PROJECT_DOMAIN_EVENT_QUEUE);
          expect(event.payloadVersion).toBe(1);
          expect(Object.keys(event.payload).sort()).toEqual([
            "action",
            "actorId",
            "intentId",
            "resourceIds",
            "workspaceId",
          ]);
          expect(JSON.stringify(event.payload)).not.toContain("Event fixture");
          expect(JSON.stringify(event.payload)).not.toContain("https://");
        }

        throw new RollbackProjectsTest("rollback Part 29 fixtures");
      }),
    ).rejects.toBeInstanceOf(RollbackProjectsTest);
  });

  it("rolls back project and audit rows when the transactional outbox insert fails", async ({
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
        const database = {
          db: tx,
          transaction: <T>(work: (scope: DatabaseTransaction) => Promise<T>): Promise<T> =>
            tx.transaction((inner) => {
              const failing = new Proxy(inner, {
                get(target, property, receiver) {
                  if (property === "insert") {
                    return (table: Parameters<DatabaseTransaction["insert"]>[0]) => {
                      if (table === jobOutbox) {
                        return {
                          values: () => Promise.reject(new Error("injected outbox failure")),
                        };
                      }
                      return target.insert(table);
                    };
                  }
                  return Reflect.get(target, property, receiver);
                },
              });
              return work(failing);
            }),
        } as unknown as DatabaseService;
        const entry = new AuthorizationEntryService(
          new AuthorizationRepository(database, tenant),
          new AuthorizationPolicyService(),
          tenant,
        );
        const service = new ProjectsService(database, entry, tenant);
        const fixtureName = `Rollback ${randomUUID()}`;
        const beforeAudits = await tx
          .select({ id: auditLogs.id })
          .from(auditLogs)
          .where(eq(auditLogs.action, PROJECT_AUDIT_ACTIONS.create));
        const beforeEvents = await tx
          .select({ id: jobOutbox.id })
          .from(jobOutbox)
          .where(eq(jobOutbox.jobType, PROJECT_DOMAIN_EVENTS.create));

        await expect(
          service.create({
            principal: principal(SEED_IDS.users.alphaOwner),
            workspaceId: SEED_IDS.workspaces.alpha,
            name: fixtureName,
          }),
        ).rejects.toThrow("injected outbox failure");

        expect(
          await tx.select({ id: projects.id }).from(projects).where(eq(projects.name, fixtureName)),
        ).toEqual([]);
        expect(
          await tx
            .select({ id: auditLogs.id })
            .from(auditLogs)
            .where(eq(auditLogs.action, PROJECT_AUDIT_ACTIONS.create)),
        ).toHaveLength(beforeAudits.length);
        expect(
          await tx
            .select({ id: jobOutbox.id })
            .from(jobOutbox)
            .where(eq(jobOutbox.jobType, PROJECT_DOMAIN_EVENTS.create)),
        ).toHaveLength(beforeEvents.length);

        throw new RollbackProjectsTest("rollback Part 29 failure fixture");
      }),
    ).rejects.toBeInstanceOf(RollbackProjectsTest);
  });
});
