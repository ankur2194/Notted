import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { and, eq, inArray, isNull, like } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import { DatabaseService, type DatabaseTransaction } from "../src/database/database.service";
import {
  auditLogs,
  folders,
  jobOutbox,
  notes,
  projectAccess,
  projects,
  schema,
} from "../src/database/schema";
import { SEED_IDS, seedDatabase } from "../src/database/seed";
import { NoteSharesService } from "../src/notes/note-shares.service";
import { NoteVersionsService } from "../src/notes/note-versions.service";
import { NOTE_DOMAIN_EVENT_QUEUE } from "../src/notes/notes.constants";
import { NotesService } from "../src/notes/notes.service";
import { TenantContextService } from "../src/tenant";

import type { NoteSearchIndexProducer } from "../src/search/note-search-index-producer";
import type { AuthenticatedPrincipal } from "@notted/shared-types";
import type { PgTransactionConfig } from "drizzle-orm/pg-core/session";

const DATABASE_URL = process.env.DATABASE_URL;
const HAS_DATABASE_URL = typeof DATABASE_URL === "string" && DATABASE_URL.trim() !== "";
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");

/** Marks every row the concurrency test commits so a rerun can clear its own leftovers. */
const CONCURRENCY_FIXTURE = "concurrency-fixture";

/** Same, for the subtree-lock test, which also commits rather than rolling back. */
const SUBTREE_FIXTURE = "subtree-fixture";

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

async function reachable(connectionString: string): Promise<boolean> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 2_000 });
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

describe.skipIf(!HAS_DATABASE_URL)("Part 31 core note APIs (live PostgreSQL)", () => {
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;
  let databaseReachable = false;

  beforeAll(async () => {
    databaseReachable = await reachable(DATABASE_URL as string);
    if (!databaseReachable) return;
    pool = new Pool({ connectionString: DATABASE_URL as string, max: 8 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  it("covers tenant-scoped creation, hierarchy, ordering, concurrency, trash, folders, access, and redaction", async ({
    skip,
  }) => {
    if (!databaseReachable || db === undefined) {
      skip("no reachable disposable PostgreSQL");
      return;
    }

    class Rollback extends Error {}
    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const tenant = new TenantContextService();
        const database = {
          db: tx,
          transaction: <T>(work: (scope: DatabaseTransaction) => Promise<T>) =>
            tx.transaction(work),
        } as unknown as DatabaseService;
        const authorization = new AuthorizationEntryService(
          new AuthorizationRepository(database, tenant),
          new AuthorizationPolicyService(),
          tenant,
        );
        const service = new NotesService(
          database,
          authorization,
          tenant,
          { scheduleSearchSync: async () => undefined } as unknown as NoteSearchIndexProducer,
          new NoteVersionsService(tenant),
        );
        const shareService = new NoteSharesService(database, authorization, tenant);
        const owner = principal(SEED_IDS.users.alphaOwner);
        const admin = principal(SEED_IDS.users.alphaAdmin);
        const editor = principal(SEED_IDS.users.alphaEditor);
        const viewer = principal(SEED_IDS.users.alphaViewer);
        const betaOwner = principal(SEED_IDS.users.betaOwner);
        const suffix = randomUUID();
        await tx
          .update(projects)
          .set({ isRestricted: true })
          .where(eq(projects.id, SEED_IDS.projects.alphaOperations));
        const doc = {
          type: "doc" as const,
          content: [{ type: "paragraph", content: [{ type: "text", text: `Plain ${suffix}` }] }],
        };

        const root = await service.create({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          title: `Root ${suffix}`,
          projectId: null,
          folderId: null,
          parentId: null,
          type: "document",
          pageSize: "letter",
          isTemplate: false,
          isPinned: true,
          isArchived: false,
          tagIds: [SEED_IDS.tags.alphaPlanning],
          content: doc,
          idempotencyKey: `note-live-root-${suffix}`,
        });
        expect(root.note).toMatchObject({
          type: "document",
          pageSize: "letter",
          isPinned: true,
          contentPlain: `Plain ${suffix}`,
          sortOrder: expect.any(Number),
        });
        const replay = await service.create({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          title: `Root ${suffix}`,
          projectId: null,
          folderId: null,
          parentId: null,
          type: "document",
          pageSize: "letter",
          isTemplate: false,
          isPinned: true,
          isArchived: false,
          tagIds: [SEED_IDS.tags.alphaPlanning],
          content: doc,
          idempotencyKey: `note-live-root-${suffix}`,
        });
        expect(replay.note.id).toBe(root.note.id);

        const shared = await service.create({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          title: `Shared ${suffix}`,
          projectId: null,
          folderId: null,
          parentId: null,
          type: "document",
          pageSize: "a4",
          isTemplate: false,
          isPinned: false,
          isArchived: false,
          tagIds: [],
          idempotencyKey: `note-live-share-${suffix}`,
        });

        const viewGrant = await shareService.upsert({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: shared.note.id,
          userId: SEED_IDS.users.alphaEditor,
          permission: "view",
        });
        expect(viewGrant.share.permission).toBe("view");
        await expect(
          service.update({
            principal: editor,
            workspaceId: SEED_IDS.workspaces.alpha,
            noteId: shared.note.id,
            expectedVersion: shared.note.version,
            title: `Denied editor update ${suffix}`,
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });
        await expect(
          shareService.upsert({
            principal: editor,
            workspaceId: SEED_IDS.workspaces.alpha,
            noteId: shared.note.id,
            userId: SEED_IDS.users.alphaViewer,
            permission: "view",
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });
        await shareService.upsert({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: shared.note.id,
          userId: SEED_IDS.users.alphaEditor,
          permission: "edit",
        });
        await expect(
          shareService.upsert({
            principal: editor,
            workspaceId: SEED_IDS.workspaces.alpha,
            noteId: shared.note.id,
            userId: SEED_IDS.users.alphaViewer,
            permission: "view",
          }),
        ).resolves.toMatchObject({ share: { permission: "view" } });
        await expect(
          shareService.upsert({
            principal: editor,
            workspaceId: SEED_IDS.workspaces.alpha,
            noteId: shared.note.id,
            userId: SEED_IDS.users.alphaEditor,
            permission: "view",
          }),
        ).rejects.toMatchObject({ safeResponse: { code: "NOTE_SHARE_SELF_DENIED" } });
        await expect(
          shareService.upsert({
            principal: admin,
            workspaceId: SEED_IDS.workspaces.alpha,
            noteId: shared.note.id,
            userId: SEED_IDS.users.alphaViewer,
            permission: "edit",
          }),
        ).resolves.toMatchObject({ share: { permission: "edit" } });
        await expect(
          shareService.upsert({
            principal: viewer,
            workspaceId: SEED_IDS.workspaces.alpha,
            noteId: shared.note.id,
            userId: SEED_IDS.users.alphaEditor,
            permission: "view",
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });
        await expect(
          shareService.upsert({
            principal: owner,
            workspaceId: SEED_IDS.workspaces.alpha,
            noteId: shared.note.id,
            userId: randomUUID(),
            permission: "view",
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });
        const editorUpdate = await service.update({
          principal: editor,
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: shared.note.id,
          expectedVersion: shared.note.version,
          title: `Authorized editor update ${suffix}`,
        });
        await shareService.upsert({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: shared.note.id,
          userId: SEED_IDS.users.alphaEditor,
          permission: "view",
        });
        await expect(
          service.update({
            principal: editor,
            workspaceId: SEED_IDS.workspaces.alpha,
            noteId: shared.note.id,
            expectedVersion: editorUpdate.note.version,
            title: `Downgraded editor update ${suffix}`,
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });
        await shareService.upsert({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: shared.note.id,
          userId: SEED_IDS.users.alphaEditor,
          permission: "edit",
        });
        await shareService.revoke({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: shared.note.id,
          userId: SEED_IDS.users.alphaEditor,
        });
        await expect(
          service.update({
            principal: editor,
            workspaceId: SEED_IDS.workspaces.alpha,
            noteId: shared.note.id,
            expectedVersion: editorUpdate.note.version,
            title: `Revoked editor update ${suffix}`,
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });
        await expect(
          shareService.upsert({
            principal: owner,
            workspaceId: SEED_IDS.workspaces.alpha,
            noteId: shared.note.id,
            userId: SEED_IDS.users.betaOwner,
            permission: "view",
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });
        await expect(
          shareService.upsert({
            principal: owner,
            workspaceId: SEED_IDS.workspaces.alpha,
            noteId: SEED_IDS.notes.alphaTaskNote,
            userId: SEED_IDS.users.alphaViewer,
            permission: "view",
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });

        await expect(
          service.create({
            principal: owner,
            workspaceId: SEED_IDS.workspaces.alpha,
            title: "Cross tenant tag",
            projectId: null,
            folderId: null,
            parentId: null,
            type: "document",
            pageSize: "a4",
            isTemplate: false,
            isPinned: false,
            isArchived: false,
            tagIds: [SEED_IDS.tags.betaResearch],
            idempotencyKey: `note-live-cross-tag-${suffix}`,
          }),
        ).rejects.toMatchObject({ safeResponse: { code: "NOT_FOUND" } });

        const projectTask = await service.create({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          title: `Task template ${suffix}`,
          projectId: SEED_IDS.projects.alphaLaunch,
          folderId: SEED_IDS.folders.alphaHandbook,
          parentId: null,
          type: "task-list",
          pageSize: "a4",
          isTemplate: true,
          isPinned: false,
          isArchived: true,
          tagIds: [],
          idempotencyKey: `note-live-task-${suffix}`,
        });
        expect(projectTask.note).toMatchObject({
          type: "task-list",
          isTemplate: true,
          isArchived: true,
        });
        const filteredTaskTemplates = await service.list({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          page: 1,
          limit: 10,
          scope: "project",
          projectId: SEED_IDS.projects.alphaLaunch,
          type: "task-list",
          view: "templates",
          isArchived: true,
          sortBy: "sortOrder",
          sortDirection: "asc",
        });
        expect(filteredTaskTemplates.items.map((item) => item.id)).toContain(projectTask.note.id);
        const navigation = await service.navigation({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          limit: 1,
          includeArchived: true,
        });
        expect(navigation).toMatchObject({ returned: 1, truncated: true });
        expect(navigation.items[0]).not.toHaveProperty("content");

        await expect(
          service.create({
            principal: owner,
            workspaceId: SEED_IDS.workspaces.alpha,
            title: "Cross tenant folder",
            projectId: null,
            folderId: SEED_IDS.folders.betaLibrary,
            parentId: null,
            type: "document",
            pageSize: "a4",
            isTemplate: false,
            isPinned: false,
            isArchived: false,
            tagIds: [],
            idempotencyKey: `note-live-cross-folder-${suffix}`,
          }),
        ).rejects.toMatchObject({ safeResponse: { code: "NOT_FOUND" } });

        const child = await service.create({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          title: `Child ${suffix}`,
          projectId: null,
          folderId: null,
          parentId: root.note.id,
          type: "document",
          pageSize: "a4",
          isTemplate: false,
          isPinned: false,
          isArchived: false,
          tagIds: [],
          idempotencyKey: `note-live-child-${suffix}`,
        });
        await expect(
          service.create({
            principal: owner,
            workspaceId: SEED_IDS.workspaces.alpha,
            title: "Container mismatch",
            projectId: SEED_IDS.projects.alphaLaunch,
            folderId: null,
            parentId: root.note.id,
            type: "document",
            pageSize: "a4",
            isTemplate: false,
            isPinned: false,
            isArchived: false,
            tagIds: [],
            idempotencyKey: `note-live-mismatch-${suffix}`,
          }),
        ).rejects.toMatchObject({ safeResponse: { code: "NOT_FOUND" } });
        await expect(
          service.move({
            principal: owner,
            workspaceId: SEED_IDS.workspaces.alpha,
            noteId: root.note.id,
            expectedVersion: root.note.version,
            projectId: null,
            folderId: null,
            parentId: child.note.id,
          }),
        ).rejects.toMatchObject({ safeResponse: { code: "NOTE_HIERARCHY_INVALID" } });

        const updated = await service.update({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: root.note.id,
          expectedVersion: root.note.version,
          title: `Updated ${suffix}`,
          type: "task-list",
          content: doc,
        });
        expect(updated.note.version).toBe(root.note.version + 1);
        expect(updated.note.type).toBe("task-list");
        await expect(
          service.update({
            principal: owner,
            workspaceId: SEED_IDS.workspaces.alpha,
            noteId: root.note.id,
            expectedVersion: root.note.version,
            title: "Stale",
          }),
        ).rejects.toMatchObject({ safeResponse: { code: "VERSION_CONFLICT" } });

        await tx
          .update(notes)
          .set({ sortOrder: 9 })
          .where(inArray(notes.id, [SEED_IDS.notes.alphaPinnedRoot, SEED_IDS.notes.alphaDeleted]));
        const renormalized = await service.move({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: root.note.id,
          expectedVersion: updated.note.version,
          projectId: null,
          folderId: null,
          parentId: null,
          beforeNoteId: SEED_IDS.notes.alphaPinnedRoot,
        });
        const rootOrders = await tx
          .select({ sortOrder: notes.sortOrder })
          .from(notes)
          .where(and(eq(notes.workspaceId, SEED_IDS.workspaces.alpha), isNull(notes.projectId)));
        expect(rootOrders.every((row) => Number.isFinite(row.sortOrder))).toBe(true);

        const moved = await service.move({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: root.note.id,
          expectedVersion: renormalized.note.version,
          projectId: SEED_IDS.projects.alphaLaunch,
          folderId: null,
          parentId: null,
          beforeNoteId: SEED_IDS.notes.alphaProjectOverview,
        });
        expect(moved.note.projectId).toBe(SEED_IDS.projects.alphaLaunch);
        const movedChild = await tx
          .select({ projectId: notes.projectId })
          .from(notes)
          .where(eq(notes.id, child.note.id));
        expect(movedChild).toEqual([{ projectId: SEED_IDS.projects.alphaLaunch }]);
        await expect(
          service.move({
            principal: owner,
            workspaceId: SEED_IDS.workspaces.alpha,
            noteId: projectTask.note.id,
            expectedVersion: projectTask.note.version,
            projectId: SEED_IDS.projects.alphaLaunch,
            folderId: SEED_IDS.folders.alphaHandbook,
            parentId: null,
            beforeNoteId: root.note.id,
          }),
        ).rejects.toMatchObject({ safeResponse: { code: "NOT_FOUND" } });

        const childBeforeDelete = await service.read({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: child.note.id,
        });
        const independentlyDeletedChild = await service.softDelete({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: child.note.id,
          expectedVersion: childBeforeDelete.version,
        });
        const [independentBatch] = await tx
          .select({ deletionBatchId: notes.deletionBatchId })
          .from(notes)
          .where(eq(notes.id, child.note.id));
        expect(independentBatch?.deletionBatchId).toEqual(expect.any(String));
        const deleted = await service.softDelete({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: root.note.id,
          expectedVersion: moved.note.version,
        });
        expect(deleted.affected).toBe(1);
        const batches = await tx
          .select({ id: notes.id, deletionBatchId: notes.deletionBatchId })
          .from(notes)
          .where(inArray(notes.id, [root.note.id, child.note.id]));
        expect(new Set(batches.map((row) => row.deletionBatchId)).size).toBe(2);
        await expect(
          service.restore({
            principal: owner,
            workspaceId: SEED_IDS.workspaces.alpha,
            noteId: child.note.id,
            expectedVersion: independentlyDeletedChild.version,
          }),
        ).rejects.toMatchObject({ safeResponse: { code: "NOTE_ANCESTOR_DELETED" } });
        await expect(
          service.create({
            principal: owner,
            workspaceId: SEED_IDS.workspaces.alpha,
            title: "Child of deleted note",
            projectId: SEED_IDS.projects.alphaLaunch,
            folderId: null,
            parentId: root.note.id,
            type: "document",
            pageSize: "a4",
            isTemplate: false,
            isPinned: false,
            isArchived: false,
            tagIds: [],
            idempotencyKey: `note-live-deleted-parent-${suffix}`,
          }),
        ).rejects.toMatchObject({ safeResponse: { code: "NOT_FOUND" } });
        const trash = await service.list({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          page: 1,
          limit: 100,
          scope: "project",
          projectId: SEED_IDS.projects.alphaLaunch,
          view: "trash",
          sortBy: "updatedAt",
          sortDirection: "desc",
        });
        expect(trash.items.map((item) => item.id)).toEqual(
          expect.arrayContaining([root.note.id, child.note.id]),
        );
        const restored = await service.restore({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: root.note.id,
          expectedVersion: deleted.version,
        });
        expect(restored.affected).toBe(1);
        expect(
          await tx
            .select({ isDeleted: notes.isDeleted })
            .from(notes)
            .where(eq(notes.id, child.note.id)),
        ).toEqual([{ isDeleted: true }]);
        const childRestored = await service.restore({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: child.note.id,
          expectedVersion: independentlyDeletedChild.version,
        });
        expect(childRestored.affected).toBe(1);

        const level1 = await service.createFolder({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          name: `L1 ${suffix}`,
          parentId: null,
        });
        const level2 = await service.createFolder({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          name: `L2 ${suffix}`,
          parentId: level1.folder.id,
        });
        const level3 = await service.createFolder({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          name: `L3 ${suffix}`,
          parentId: level2.folder.id,
        });
        await expect(
          service.createFolder({
            principal: owner,
            workspaceId: SEED_IDS.workspaces.alpha,
            name: "L4",
            parentId: level3.folder.id,
          }),
        ).rejects.toMatchObject({ safeResponse: { code: "FOLDER_DEPTH_EXCEEDED" } });
        await expect(
          service.updateFolder({
            principal: owner,
            workspaceId: SEED_IDS.workspaces.alpha,
            folderId: level1.folder.id,
            parentId: level3.folder.id,
          }),
        ).rejects.toMatchObject({ safeResponse: { code: "FOLDER_HIERARCHY_INVALID" } });

        const filed = await service.create({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          title: `Filed ${suffix}`,
          projectId: null,
          folderId: level3.folder.id,
          parentId: null,
          type: "document",
          pageSize: "a4",
          isTemplate: false,
          isPinned: false,
          isArchived: false,
          tagIds: [],
          idempotencyKey: `note-live-filed-${suffix}`,
        });
        const folderDeletion = await service.deleteFolder({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          folderId: level1.folder.id,
        });
        expect(folderDeletion).toMatchObject({ removedFolders: 3, unfiledNotes: 1 });
        expect(
          await tx
            .select({ folderId: notes.folderId })
            .from(notes)
            .where(eq(notes.id, filed.note.id)),
        ).toEqual([{ folderId: null }]);

        await tx
          .update(projects)
          .set({ isRestricted: true })
          .where(eq(projects.id, SEED_IDS.projects.alphaOperations));
        await tx.insert(projectAccess).values({
          projectId: SEED_IDS.projects.alphaOperations,
          userId: SEED_IDS.users.alphaEditor,
          role: "editor",
          createdById: SEED_IDS.users.alphaOwner,
        });
        const viewerNavigation = await service.navigation({
          principal: viewer,
          workspaceId: SEED_IDS.workspaces.alpha,
          limit: 100,
          includeArchived: true,
        });
        expect(viewerNavigation.items.map((item) => item.id)).not.toContain(
          SEED_IDS.notes.alphaTaskNote,
        );
        const viewerPage = await service.list({
          principal: viewer,
          workspaceId: SEED_IDS.workspaces.alpha,
          page: 1,
          limit: 100,
          scope: "project",
          projectId: SEED_IDS.projects.alphaLaunch,
          view: "normal",
          sortBy: "updatedAt",
          sortDirection: "desc",
        });
        expect(
          viewerPage.items.every((item) => item.projectId === SEED_IDS.projects.alphaLaunch),
        ).toBe(true);
        await expect(
          service.list({
            principal: viewer,
            workspaceId: SEED_IDS.workspaces.alpha,
            page: 1,
            limit: 1,
            scope: "project",
            projectId: SEED_IDS.projects.alphaOperations,
            view: "normal",
            sortBy: "updatedAt",
            sortDirection: "desc",
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });
        await expect(
          service.read({
            principal: betaOwner,
            workspaceId: SEED_IDS.workspaces.beta,
            noteId: root.note.id,
          }),
        ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 404 } });

        const rootAfterRestore = await service.read({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: root.note.id,
        });
        const deletedAgain = await service.softDelete({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: root.note.id,
          expectedVersion: rootAfterRestore.version,
        });
        await tx
          .update(notes)
          .set({ isDeleted: false, deletedAt: null, deletionBatchId: null })
          .where(eq(notes.id, child.note.id));
        await expect(
          service.permanentDelete({
            principal: owner,
            workspaceId: SEED_IDS.workspaces.alpha,
            noteId: root.note.id,
            expectedVersion: deletedAgain.version,
            expectedTitle: rootAfterRestore.title,
          }),
        ).rejects.toMatchObject({ safeResponse: { code: "NOTE_SUBTREE_ACTIVE" } });
        await tx
          .update(notes)
          .set({ isDeleted: true, deletedAt: new Date(), deletionBatchId: randomUUID() })
          .where(eq(notes.id, child.note.id));
        await service.permanentDelete({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: root.note.id,
          expectedVersion: deletedAgain.version,
          expectedTitle: rootAfterRestore.title,
        });
        expect(
          await tx
            .select({ id: notes.id })
            .from(notes)
            .where(inArray(notes.id, [root.note.id, child.note.id])),
        ).toEqual([]);

        const intents = await tx
          .select({ payload: jobOutbox.payload })
          .from(jobOutbox)
          .where(eq(jobOutbox.queueName, NOTE_DOMAIN_EVENT_QUEUE));
        const audits = await tx
          .select({ metadata: auditLogs.metadata })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.workspaceId, SEED_IDS.workspaces.alpha),
              inArray(auditLogs.entityType, ["note", "folder"]),
            ),
          );
        const serialized = JSON.stringify({ intents, audits });
        expect(serialized).not.toContain(`Updated ${suffix}`);
        expect(serialized).not.toContain(`Plain ${suffix}`);
        expect(serialized).not.toContain(SEED_IDS.tags.alphaPlanning);
        expect(
          intents.every((intent) =>
            Object.keys(intent.payload).every((key) =>
              ["action", "intentId", "workspaceId", "resourceIds", "actorId"].includes(key),
            ),
          ),
        ).toBe(true);
        const shareIntents = intents.filter((intent) =>
          intent.payload.action.startsWith("note.share."),
        );
        for (const intent of shareIntents) {
          const payload = intent.payload as unknown as Record<string, unknown>;
          // actorId legitimately identifies the actor who performed the share
          // upsert, so exclude it when proving no other share field references
          // the editor that was removed from the workspace.
          const rest = Object.fromEntries(
            Object.entries(payload).filter(([key]) => key !== "actorId"),
          );
          expect(JSON.stringify(rest)).not.toContain(SEED_IDS.users.alphaEditor);
        }

        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });

  it("denies tenant SQL when an authorization adapter fails to establish TenantContext", async ({
    skip,
  }) => {
    if (!databaseReachable || db === undefined) {
      skip("no reachable disposable PostgreSQL");
      return;
    }
    const tenant = new TenantContextService();
    const authorization = {
      authorizeUser: async () => ({
        workspaceId: SEED_IDS.workspaces.alpha,
        userId: SEED_IDS.users.alphaOwner,
      }),
      run: <T>(_operation: unknown, work: () => T): T => work(),
    };
    const database = { db } as unknown as DatabaseService;
    const service = new NotesService(
      database,
      authorization as unknown as AuthorizationEntryService,
      tenant,
      { scheduleSearchSync: async () => undefined } as unknown as NoteSearchIndexProducer,
      new NoteVersionsService(tenant),
    );
    await expect(
      service.navigation({
        principal: principal(SEED_IDS.users.alphaOwner),
        workspaceId: SEED_IDS.workspaces.alpha,
        limit: 10,
        includeArchived: false,
      }),
    ).rejects.toMatchObject({ code: "tenant.no_active_context" });
  });

  it("uses independent pool transactions for concurrent updates and reorder races", async ({
    skip,
  }) => {
    if (!databaseReachable || db === undefined) {
      skip("no reachable disposable PostgreSQL");
      return;
    }

    // This suite commits rather than rolling back: the barrier-synchronized
    // races below need genuinely independent transactions, which a wrapping
    // transaction would serialize. Committed rows therefore survive the run, and
    // left in place they accumulate as siblings in the same workspace root —
    // each rerun makes the concurrent reorders contend harder until one of the
    // "both succeed" expectations legitimately fails. Every row this test
    // commits carries CONCURRENCY_FIXTURE, so clearing them up front keeps a
    // reused development database behaving like the empty one CI provisions.
    await db.delete(notes).where(like(notes.title, `${CONCURRENCY_FIXTURE}%`));
    await db.delete(folders).where(like(folders.name, `${CONCURRENCY_FIXTURE}%`));

    await db.transaction(async (tx) => seedDatabase(tx));
    const owner = principal(SEED_IDS.users.alphaOwner);
    const createService = (database: DatabaseService, tenant: TenantContextService) =>
      new NotesService(
        database,
        new AuthorizationEntryService(
          new AuthorizationRepository(database, tenant),
          new AuthorizationPolicyService(),
          tenant,
        ),
        tenant,
        { scheduleSearchSync: async () => undefined } as unknown as NoteSearchIndexProducer,
        new NoteVersionsService(tenant),
      );
    const normalTenant = new TenantContextService();
    const normalDatabase = {
      db,
      transaction: <T>(
        work: (scope: DatabaseTransaction) => Promise<T>,
        config?: PgTransactionConfig,
      ) => db!.transaction(work, config),
    } as DatabaseService;
    const setup = createService(normalDatabase, normalTenant);
    const suffix = randomUUID();
    const create = (title: string) =>
      setup.create({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        title: `${CONCURRENCY_FIXTURE} ${title} ${suffix}`,
        projectId: null,
        folderId: null,
        parentId: null,
        type: "document",
        pageSize: "a4",
        isTemplate: false,
        isPinned: false,
        isArchived: false,
        tagIds: [],
        idempotencyKey: `concurrency-${title}-${suffix}`,
      });
    const first = await create("First");
    const second = await create("Second");
    const third = await create("Third");

    class Barrier {
      private arrivals = 0;
      private release!: () => void;
      private readonly ready = new Promise<void>((resolveReady) => {
        this.release = resolveReady;
      });
      async wait(): Promise<void> {
        this.arrivals += 1;
        if (this.arrivals === 2) this.release();
        await this.ready;
      }
    }
    const concurrentServices = (barrier: Barrier): readonly [NotesService, NotesService] => {
      const build = () => {
        const tenant = new TenantContextService();
        const database = {
          db,
          transaction: <T>(
            work: (scope: DatabaseTransaction) => Promise<T>,
            config?: PgTransactionConfig,
          ) =>
            db!.transaction(async (tx) => {
              await barrier.wait();
              return work(tx);
            }, config),
        } as DatabaseService;
        return createService(database, tenant);
      };
      return [build(), build()];
    };

    const updateBarrier = new Barrier();
    const [updateA, updateB] = concurrentServices(updateBarrier);
    const updates = await Promise.allSettled([
      updateA.update({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: first.note.id,
        expectedVersion: first.note.version,
        title: `Update A ${suffix}`,
      }),
      updateB.update({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: first.note.id,
        expectedVersion: first.note.version,
        title: `Update B ${suffix}`,
      }),
    ]);
    expect(updates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(updates.filter((result) => result.status === "rejected")).toHaveLength(1);
    const afterUpdate = await setup.read({
      principal: owner,
      workspaceId: SEED_IDS.workspaces.alpha,
      noteId: first.note.id,
    });
    expect(afterUpdate.version).toBe(first.note.version + 1);

    const reorderBarrier = new Barrier();
    const [reorderA, reorderB] = concurrentServices(reorderBarrier);
    const reorders = await Promise.allSettled([
      reorderA.move({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: second.note.id,
        expectedVersion: second.note.version,
        projectId: null,
        folderId: null,
        parentId: null,
        beforeNoteId: first.note.id,
      }),
      reorderB.move({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: third.note.id,
        expectedVersion: third.note.version,
        projectId: null,
        folderId: null,
        parentId: null,
        beforeNoteId: second.note.id,
      }),
    ]);
    expect(reorders.every((result) => result.status === "fulfilled")).toBe(true);
    const ordered = await db
      .select({ id: notes.id, sortOrder: notes.sortOrder, version: notes.version })
      .from(notes)
      .where(inArray(notes.id, [first.note.id, second.note.id, third.note.id]))
      .orderBy(notes.sortOrder);
    expect([
      [third.note.id, second.note.id, first.note.id],
      [second.note.id, first.note.id, third.note.id],
    ]).toContainEqual(ordered.map((row) => row.id));
    expect(new Set(ordered.map((row) => row.sortOrder)).size).toBe(3);
    expect(ordered.find((row) => row.id === second.note.id)?.version).toBe(second.note.version + 1);
    expect(ordered.find((row) => row.id === third.note.id)?.version).toBe(third.note.version + 1);

    const destinationFolder = await setup.createFolder({
      principal: owner,
      workspaceId: SEED_IDS.workspaces.alpha,
      name: `${CONCURRENCY_FIXTURE} destination ${suffix}`,
      parentId: null,
    });
    const firstLatest = await setup.read({
      principal: owner,
      workspaceId: SEED_IDS.workspaces.alpha,
      noteId: first.note.id,
    });
    const thirdForCrossGroup = await setup.read({
      principal: owner,
      workspaceId: SEED_IDS.workspaces.alpha,
      noteId: third.note.id,
    });
    const crossGroupBarrier = new Barrier();
    const [crossGroupA, crossGroupB] = concurrentServices(crossGroupBarrier);
    const crossGroup = await Promise.allSettled([
      crossGroupA.move({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: first.note.id,
        expectedVersion: firstLatest.version,
        projectId: null,
        folderId: destinationFolder.folder.id,
        parentId: null,
        beforeNoteId: null,
      }),
      crossGroupB.move({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: third.note.id,
        expectedVersion: thirdForCrossGroup.version,
        projectId: null,
        folderId: null,
        parentId: null,
        beforeNoteId: second.note.id,
      }),
    ]);
    expect(crossGroup.every((result) => result.status === "fulfilled")).toBe(true);
    expect(
      await db.select({ folderId: notes.folderId }).from(notes).where(eq(notes.id, first.note.id)),
    ).toEqual([{ folderId: destinationFolder.folder.id }]);

    const firstBack = await setup.read({
      principal: owner,
      workspaceId: SEED_IDS.workspaces.alpha,
      noteId: first.note.id,
    });
    await setup.move({
      principal: owner,
      workspaceId: SEED_IDS.workspaces.alpha,
      noteId: first.note.id,
      expectedVersion: firstBack.version,
      projectId: null,
      folderId: null,
      parentId: null,
      beforeNoteId: null,
    });

    await db
      .update(notes)
      .set({ sortOrder: 1 })
      .where(inArray(notes.id, [first.note.id, second.note.id]));
    const versionsBeforeRenormalize = new Map(ordered.map((row) => [row.id, row.version]));
    const thirdLatest = await setup.read({
      principal: owner,
      workspaceId: SEED_IDS.workspaces.alpha,
      noteId: third.note.id,
    });
    await setup.move({
      principal: owner,
      workspaceId: SEED_IDS.workspaces.alpha,
      noteId: third.note.id,
      expectedVersion: thirdLatest.version,
      projectId: null,
      folderId: null,
      parentId: null,
      beforeNoteId: first.note.id,
    });
    const afterRenormalize = await db
      .select({
        id: notes.id,
        sortOrder: notes.sortOrder,
        version: notes.version,
        updatedById: notes.updatedById,
      })
      .from(notes)
      .where(inArray(notes.id, [first.note.id, second.note.id, third.note.id]));
    expect(new Set(afterRenormalize.map((row) => row.sortOrder)).size).toBe(3);
    expect(
      afterRenormalize
        .filter((row) => row.id !== third.note.id)
        .every((row) => row.version > (versionsBeforeRenormalize.get(row.id) ?? 0)),
    ).toBe(true);
    expect(afterRenormalize.every((row) => row.updatedById === owner.userId)).toBe(true);

    const raceTarget = await setup.read({
      principal: owner,
      workspaceId: SEED_IDS.workspaces.alpha,
      noteId: second.note.id,
    });
    const raceBarrier = new Barrier();
    const [contentWriter, orderWriter] = concurrentServices(raceBarrier);
    const updateVsReorder = await Promise.allSettled([
      contentWriter.update({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: second.note.id,
        expectedVersion: raceTarget.version,
        title: `Writer ${suffix}`,
      }),
      orderWriter.move({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        noteId: second.note.id,
        expectedVersion: raceTarget.version,
        projectId: null,
        folderId: null,
        parentId: null,
        beforeNoteId: third.note.id,
      }),
    ]);
    expect(updateVsReorder.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(updateVsReorder.filter((result) => result.status === "rejected")).toHaveLength(1);
    const finalRows = await db
      .select({ id: notes.id, sortOrder: notes.sortOrder, version: notes.version })
      .from(notes)
      .where(inArray(notes.id, [first.note.id, second.note.id, third.note.id]))
      .orderBy(notes.sortOrder);
    expect(new Set(finalRows.map((row) => row.sortOrder)).size).toBe(3);
    expect(finalRows.find((row) => row.id === second.note.id)?.version).toBe(
      raceTarget.version + 1,
    );
  });

  /*
   * `noteSubtreeRows` used to select EVERY note row in the workspace and walk
   * the edges in memory — and when the caller asked for a lock it took
   * `FOR UPDATE` on all of them. Trashing one three-note branch therefore
   * row-locked the whole tenant until the transaction committed.
   *
   * Both cases below are about the subtree walk, so they share a fixture.
   */
  it("locks only the subtree it is deleting, and refuses a corrupted hierarchy", async ({
    skip,
  }) => {
    if (!databaseReachable || db === undefined) {
      skip("no reachable disposable PostgreSQL");
      return;
    }
    await db.delete(notes).where(like(notes.title, `${SUBTREE_FIXTURE}%`));
    await db.transaction(async (tx) => seedDatabase(tx));

    const owner = principal(SEED_IDS.users.alphaOwner);
    const suffix = randomUUID();
    // `lock_timeout` turns "blocked forever" into a deterministic failure, so a
    // regression fails the test instead of hanging the suite.
    const guardedPool = new Pool({
      connectionString: DATABASE_URL as string,
      max: 4,
      options: "-c lock_timeout=2000",
    });
    const guardedDb = drizzle(guardedPool, { schema });
    const tenant = new TenantContextService();
    const guardedDatabase = {
      db: guardedDb,
      transaction: <T>(
        work: (scope: DatabaseTransaction) => Promise<T>,
        config?: PgTransactionConfig,
      ) => guardedDb.transaction(work, config),
    } as unknown as DatabaseService;
    const service = new NotesService(
      guardedDatabase,
      new AuthorizationEntryService(
        new AuthorizationRepository(guardedDatabase, tenant),
        new AuthorizationPolicyService(),
        tenant,
      ),
      tenant,
      { scheduleSearchSync: async () => undefined } as unknown as NoteSearchIndexProducer,
      new NoteVersionsService(tenant),
    );
    const create = (title: string, parentId: string | null) =>
      service.create({
        principal: owner,
        workspaceId: SEED_IDS.workspaces.alpha,
        title: `${SUBTREE_FIXTURE} ${title} ${suffix}`,
        projectId: null,
        folderId: null,
        parentId,
        type: "document",
        pageSize: "a4",
        isTemplate: false,
        isPinned: false,
        isArchived: false,
        tagIds: [],
        content: undefined,
        requestId: null,
        idempotencyKey: randomUUID(),
      });

    const blocker = new Client({ connectionString: DATABASE_URL as string });
    try {
      const target = await create("target root", null);
      const child = await create("target child", target.note.id);
      // Belongs to the same workspace and to NO part of the subtree above.
      const bystander = await create("bystander", null);

      // Hold a row lock on the bystander from an independent connection.
      await blocker.connect();
      await blocker.query("begin");
      await blocker.query("select id from notes where id = $1 for update", [bystander.note.id]);

      // The old workspace-wide `FOR UPDATE` blocked here and died on
      // `lock_timeout`; a subtree-scoped lock never touches the bystander.
      await expect(
        service.softDelete({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: target.note.id,
          expectedVersion: target.note.version,
          requestId: null,
        }),
      ).resolves.toBeDefined();

      // The narrowed walk must still find the whole subtree, not just the root.
      const [childRow] = await db
        .select({ isDeleted: notes.isDeleted })
        .from(notes)
        .where(eq(notes.id, child.note.id));
      expect(childRow?.isDeleted).toBe(true);

      await blocker.query("rollback");

      // A `parent_id` loop reachable from the root must still be refused, and
      // must terminate: a bare `union all` would spin forever here and `union`
      // would swallow it. Corrupt the tree behind the service's back.
      const loopRoot = await create("loop root", null);
      const loopChild = await create("loop child", loopRoot.note.id);
      await db
        .update(notes)
        .set({ parentId: loopChild.note.id })
        .where(eq(notes.id, loopRoot.note.id));

      await expect(
        service.softDelete({
          principal: owner,
          workspaceId: SEED_IDS.workspaces.alpha,
          noteId: loopRoot.note.id,
          expectedVersion: loopRoot.note.version,
          requestId: null,
        }),
      ).rejects.toMatchObject({ safeResponse: { code: "NOTE_HIERARCHY_INVALID" } });
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      await blocker.end().catch(() => undefined);
      await guardedPool.end().catch(() => undefined);
      // The loop would break any later traversal through this workspace root.
      await db.delete(notes).where(like(notes.title, `${SUBTREE_FIXTURE}%`));
    }
  });
});
