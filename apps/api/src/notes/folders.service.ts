// Part 15/16 — folders, split out of `NotesService`.
//
// WHY A SEPARATE SERVICE. `notes.service.ts` was 2 439 lines, and folders were
// the one thing in it with a complete surface of its own: four use cases and
// nine helpers that no note path touches. Everything else in that file — notes,
// versions, sharing, moving, the trash — reads or writes the same `notes` rows
// through the same selection and the same ordering, which is why this is the
// only clean seam and not the first of several.
//
// THE ONE LEAK, AND HOW IT IS HANDLED. `NotesService.validateContainer` needs to
// prove a note's destination folder exists before it writes, so `readFolder` is
// PUBLIC here and called from there. That is one arrow, notes -> folders, and it
// stays one arrow: nothing in this file knows what a note is.
//
// `NotesService` keeps `listFolders`/`createFolder`/`updateFolder`/`deleteFolder`
// as one-line delegates. `FoldersController` is constructed in
// `notes.controller.test.ts` with a `{ deleteFolder } as unknown as NotesService`
// cast, and four tRPC procedures call the same methods; re-pointing them at this
// class would turn a split into a transport change and break a test that has
// nothing to do with folders.

import { randomUUID } from "node:crypto";

import { HttpStatus, Injectable, Optional } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import { folders, notes } from "../database/schema";
import { NoteSearchIndexProducer } from "../search/note-search-index-producer";
import {
  activeWorkspaceId,
  assertWorkspaceInsertValues,
  TenantContextService,
  whereWorkspace,
} from "../tenant";

import { recordNoteMutation } from "./note-mutation-record";
import { FOLDER_MAX_DEPTH, NOTE_DOMAIN_EVENTS, type NoteMutation } from "./notes.constants";

import type {
  CreateFolderServiceInput,
  DeleteFolderServiceInput,
  ListFoldersServiceInput,
  ScopedInput,
  UpdateFolderServiceInput,
} from "./notes.service";
import type { WebhookDeliveryProducer } from "../webhooks/webhook-delivery.producer";
import type {
  FolderCreateResult,
  FolderDeleteResult,
  FolderPage,
  FolderSummary,
  FolderUpdateResult,
} from "@notted/shared-types";

interface FolderRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

@Injectable()
export class FoldersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
    private readonly searchIndexProducer: NoteSearchIndexProducer,
    @Optional() private readonly webhookProducer?: WebhookDeliveryProducer,
  ) {}

  async listFolders(input: ListFoldersServiceInput): Promise<FolderPage> {
    const operation = await this.authorizeWorkspaceRead(input);
    return this.authorizationEntry.run(operation, async () => {
      const conditions: SQL[] = [whereWorkspace(folders, this.tenantContext)];
      if (input.parentId !== undefined) conditions.push(eq(folders.parentId, input.parentId));
      if (input.root === true) conditions.push(isNull(folders.parentId));
      const rows = await this.database.db
        .select(this.folderSelection())
        .from(folders)
        .where(and(...conditions))
        .orderBy(asc(folders.name), asc(folders.id))
        .limit(input.limit + 1)
        .offset((input.page - 1) * input.limit);
      return Object.freeze({
        items: Object.freeze(rows.slice(0, input.limit).map((row) => this.toFolder(row))),
        page: input.page,
        limit: input.limit,
        hasMore: rows.length > input.limit,
      });
    });
  }
  async createFolder(input: CreateFolderServiceInput): Promise<FolderCreateResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "folder.create",
      resource:
        input.parentId === undefined || input.parentId === null
          ? { kind: "workspace" }
          : { kind: "folder", id: input.parentId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const folderId = randomUUID();
      const row = await this.database.transaction(
        async (tx) => {
          await this.assertFolderPlacement(tx, null, input.parentId ?? null);
          await tx.insert(folders).values(
            assertWorkspaceInsertValues(
              {
                id: folderId,
                workspaceId: activeWorkspaceId(this.tenantContext),
                parentId: input.parentId ?? null,
                name: input.name,
                createdById: input.principal.userId,
              },
              this.tenantContext,
              "folder.create",
            ),
          );
          await this.recordMutation(tx, "folderCreate", folderId, input);
          return this.readFolder(tx, folderId);
        },
        { isolationLevel: "serializable" },
      );
      return Object.freeze({ folder: Object.freeze(this.toFolder(row)) });
    });
  }
  async updateFolder(input: UpdateFolderServiceInput): Promise<FolderUpdateResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "folder.update",
      resource: { kind: "folder", id: input.folderId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const row = await this.database.transaction(
        async (tx) => {
          await this.readFolder(tx, input.folderId);
          if (input.parentId !== undefined) {
            await this.assertFolderPlacement(tx, input.folderId, input.parentId);
            const tree = await this.loadFolderTree(tx);
            for (const descendantId of this.folderSubtreeIds(tree, input.folderId).filter(
              (id) => id !== input.folderId,
            )) {
              await this.authorizationEntry.authorizeUser({
                principal: input.principal,
                workspaceId: input.workspaceId,
                action: "folder.update",
                resource: { kind: "folder", id: descendantId },
                requestId: input.requestId,
              });
            }
          }
          const changes = {
            updatedAt: new Date(),
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
          };
          const [updated] = await tx
            .update(folders)
            .set(changes)
            .where(and(eq(folders.id, input.folderId), whereWorkspace(folders, this.tenantContext)))
            .returning(this.folderSelection());
          if (updated === undefined) this.notFound();
          await this.recordMutation(tx, "folderUpdate", input.folderId, input);
          return updated;
        },
        { isolationLevel: "serializable" },
      );
      return Object.freeze({ folder: Object.freeze(this.toFolder(row)) });
    });
  }
  async deleteFolder(input: DeleteFolderServiceInput): Promise<FolderDeleteResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "folder.delete",
      resource: { kind: "folder", id: input.folderId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const result = await this.database.transaction(
        async (tx) => {
          await this.readFolder(tx, input.folderId);
          const tree = await this.loadFolderTree(tx);
          const ids = this.folderSubtreeIds(tree, input.folderId);
          const unfiled = await tx
            .update(notes)
            .set({
              folderId: null,
              version: sql`${notes.version} + 1`,
              updatedAt: new Date(),
              updatedById: input.principal.userId,
            })
            .where(and(inArray(notes.folderId, ids), whereWorkspace(notes, this.tenantContext)))
            .returning({ id: notes.id });
          await this.recordMutation(tx, "folderDelete", input.folderId, input);
          // Part 51.3: folder deletion unfiles notes. The index observes
          // `folderId` (and `updatedAt`) so each affected note must re-sync.
          // The `.returning()` call captured every affected ID; the rows
          // still exist (only `folderId` was nulled), so the IDs are valid.
          if (unfiled.length > 0) {
            await this.searchIndexProducer.scheduleSearchSync(
              tx,
              input.workspaceId,
              unfiled.map((row) => row.id),
              {
                mutation: NOTE_DOMAIN_EVENTS.folderDelete,
                correlationId: input.requestId,
                actorId: input.principal.userId,
              },
            );
          }
          const deleted = await tx
            .delete(folders)
            .where(and(eq(folders.id, input.folderId), whereWorkspace(folders, this.tenantContext)))
            .returning({ id: folders.id });
          if (deleted.length !== 1) this.notFound();
          return { removedFolders: ids.length, unfiledNotes: unfiled.length };
        },
        { isolationLevel: "serializable" },
      );
      return Object.freeze({
        id: input.folderId,
        deleted: true as const,
        removedFolders: result.removedFolders,
        unfiledNotes: result.unfiledNotes,
      });
    });
  }
  private async assertFolderPlacement(
    tx: DatabaseTransaction,
    movingFolderId: string | null,
    parentId: string | null,
  ): Promise<void> {
    if (movingFolderId !== null && parentId === movingFolderId) this.invalidFolder();
    const tree = await this.loadFolderTree(tx);
    if (parentId !== null && !tree.some((folder) => folder.id === parentId)) this.notFound();
    if (movingFolderId !== null && !tree.some((folder) => folder.id === movingFolderId))
      this.notFound();
    const parentDepth = parentId === null ? 0 : this.folderDepth(tree, parentId);
    const subtreeDepth =
      movingFolderId === null ? 1 : this.folderSubtreeDepth(tree, movingFolderId);
    if (
      movingFolderId !== null &&
      this.folderSubtreeIds(tree, movingFolderId).includes(parentId ?? "")
    )
      this.invalidFolder();
    if (parentDepth + subtreeDepth > FOLDER_MAX_DEPTH) {
      throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
        code: "FOLDER_DEPTH_EXCEEDED",
        message: "Folders may be nested up to three levels.",
      });
    }
  }
  private loadFolderTree(tx: DatabaseTransaction): Promise<FolderRow[]> {
    return tx
      .select(this.folderSelection())
      .from(folders)
      .where(whereWorkspace(folders, this.tenantContext));
  }
  private folderDepth(tree: readonly FolderRow[], folderId: string): number {
    const byId = new Map(tree.map((folder) => [folder.id, folder]));
    let depth = 0;
    let cursor: string | null = folderId;
    const seen = new Set<string>();
    while (cursor !== null) {
      if (seen.has(cursor)) this.invalidFolder();
      seen.add(cursor);
      const row = byId.get(cursor);
      if (row === undefined) this.notFound();
      depth += 1;
      cursor = row.parentId;
    }
    return depth;
  }
  private folderSubtreeIds(tree: readonly FolderRow[], rootId: string): string[] {
    const children = new Map<string, string[]>();
    for (const row of tree) {
      if (row.parentId === null) continue;
      const list = children.get(row.parentId) ?? [];
      list.push(row.id);
      children.set(row.parentId, list);
    }
    const result: string[] = [];
    const stack = [rootId];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) this.invalidFolder();
      seen.add(id);
      result.push(id);
      stack.push(...(children.get(id) ?? []));
    }
    return result;
  }
  private folderSubtreeDepth(tree: readonly FolderRow[], rootId: string): number {
    const ids = new Set(this.folderSubtreeIds(tree, rootId));
    let maximum = 1;
    for (const id of ids) {
      let depth = 1;
      let cursor = tree.find((folder) => folder.id === id)?.parentId ?? null;
      while (cursor !== null && ids.has(cursor)) {
        depth += 1;
        cursor = tree.find((folder) => folder.id === cursor)?.parentId ?? null;
      }
      maximum = Math.max(maximum, depth);
    }
    return maximum;
  }
  /** Public for `NotesService.validateContainer`; see the header. */
  async readFolder(tx: DatabaseTransaction, folderId: string): Promise<FolderRow> {
    const [row] = await tx
      .select(this.folderSelection())
      .from(folders)
      .where(and(eq(folders.id, folderId), whereWorkspace(folders, this.tenantContext)))
      .limit(1);
    if (row === undefined) this.notFound();
    return row;
  }
  private toFolder(row: FolderRow): FolderSummary {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      parentId: row.parentId,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  private folderSelection() {
    return {
      id: folders.id,
      workspaceId: folders.workspaceId,
      parentId: folders.parentId,
      name: folders.name,
      createdAt: folders.createdAt,
      updatedAt: folders.updatedAt,
    };
  }
  private invalidFolder(): never {
    throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
      code: "FOLDER_HIERARCHY_INVALID",
      message: "The requested folder hierarchy is invalid.",
    });
  }

  private async authorizeWorkspaceRead(input: ScopedInput) {
    return this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "workspace.read",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
  }

  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
  }

  private recordMutation(
    tx: DatabaseTransaction,
    mutation: NoteMutation,
    entityId: string,
    input: ScopedInput,
  ): Promise<void> {
    return recordNoteMutation(
      tx,
      { tenantContext: this.tenantContext, webhookProducer: this.webhookProducer },
      mutation,
      entityId,
      input,
    );
  }
}
