import { Injectable } from "@nestjs/common";
import {
  createFolderSchema,
  createNoteSchema,
  deleteFolderSchema,
  deleteNoteSchema,
  folderCreateResultSchema,
  folderDeleteResultSchema,
  folderListQuerySchema,
  folderPageSchema,
  folderUpdateResultSchema,
  moveNoteSchema,
  noteCreateResultSchema,
  noteDeleteResultSchema,
  noteDetailSchema,
  noteListQuerySchema,
  noteMoveResultSchema,
  noteNavigationQuerySchema,
  noteNavigationSchema,
  notePageSchema,
  notePermanentDeleteResultSchema,
  noteRestoreResultSchema,
  noteUpdateResultSchema,
  permanentDeleteNoteSchema,
  restoreNoteSchema,
  updateFolderSchema,
  updateNoteSchema,
  uuidSchema,
} from "@notted/shared-validators";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { AuthService } from "../auth/auth.service";
import { requireIdempotencyKey } from "../common/idempotency/api-idempotency";
import { executeTrpc, trpc } from "../trpc/trpc.router";

import { NotesService } from "./notes.service";

/** Local authenticated procedure — not exported so its type need not be portable. */
const authenticatedProcedure = trpc.procedure.use(({ ctx, next }) => {
  if (ctx.principal === null) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication is required." });
  }
  return next({ ctx: { ...ctx, principal: ctx.principal } });
});

const noteSelectorSchema = z.object({ workspaceId: uuidSchema, noteId: uuidSchema }).strict();
const withData = <T extends z.ZodType>(data: T) =>
  z.object({ workspaceId: uuidSchema, noteId: uuidSchema, data }).strict();
const withFolderData = <T extends z.ZodType>(data: T) =>
  z.object({ workspaceId: uuidSchema, folderId: uuidSchema, data }).strict();

function buildNoteSubrouter(notes: NotesService, auth: AuthService) {
  return trpc.router({
    list: authenticatedProcedure
      .input(z.object({ workspaceId: uuidSchema, query: noteListQuerySchema }).strict())
      .output(notePageSchema)
      .query(({ ctx, input }) =>
        executeTrpc(() =>
          notes.list({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            requestId: ctx.requestId,
            ...input.query,
          }),
        ),
      ),
    create: authenticatedProcedure
      .input(z.object({ workspaceId: uuidSchema, data: createNoteSchema }).strict())
      .output(noteCreateResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return notes.create({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            requestId: ctx.requestId,
            idempotencyKey: requireIdempotencyKey(ctx.request),
            title: input.data.title,
            projectId: input.data.projectId ?? null,
            folderId: input.data.folderId ?? null,
            parentId: input.data.parentId ?? null,
            type: input.data.type,
            pageSize: input.data.pageSize,
            isTemplate: input.data.isTemplate,
            isPinned: input.data.isPinned,
            isArchived: input.data.isArchived,
            tagIds: input.data.tagIds,
            content: input.data.content,
          });
        }),
      ),
    read: authenticatedProcedure
      .input(noteSelectorSchema)
      .output(noteDetailSchema)
      .query(({ ctx, input }) =>
        executeTrpc(() =>
          notes.read({ ...input, principal: ctx.principal, requestId: ctx.requestId }),
        ),
      ),
    update: authenticatedProcedure
      .input(withData(updateNoteSchema))
      .output(noteUpdateResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return notes.update({
            workspaceId: input.workspaceId,
            noteId: input.noteId,
            principal: ctx.principal,
            requestId: ctx.requestId,
            ...input.data,
          });
        }),
      ),
    move: authenticatedProcedure
      .input(withData(moveNoteSchema))
      .output(noteMoveResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return notes.move({
            workspaceId: input.workspaceId,
            noteId: input.noteId,
            principal: ctx.principal,
            requestId: ctx.requestId,
            ...input.data,
          });
        }),
      ),
    delete: authenticatedProcedure
      .input(withData(deleteNoteSchema))
      .output(noteDeleteResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return notes.softDelete({
            workspaceId: input.workspaceId,
            noteId: input.noteId,
            principal: ctx.principal,
            requestId: ctx.requestId,
            ...input.data,
          });
        }),
      ),
    restore: authenticatedProcedure
      .input(withData(restoreNoteSchema))
      .output(noteRestoreResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return notes.restore({
            workspaceId: input.workspaceId,
            noteId: input.noteId,
            principal: ctx.principal,
            requestId: ctx.requestId,
            ...input.data,
          });
        }),
      ),
    permanentDelete: authenticatedProcedure
      .input(withData(permanentDeleteNoteSchema))
      .output(notePermanentDeleteResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return notes.permanentDelete({
            workspaceId: input.workspaceId,
            noteId: input.noteId,
            principal: ctx.principal,
            requestId: ctx.requestId,
            expectedVersion: input.data.expectedVersion,
            expectedTitle: input.data.expectedTitle,
          });
        }),
      ),
    navigation: authenticatedProcedure
      .input(z.object({ workspaceId: uuidSchema, query: noteNavigationQuerySchema }).strict())
      .output(noteNavigationSchema)
      .query(({ ctx, input }) =>
        executeTrpc(() =>
          notes.navigation({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            requestId: ctx.requestId,
            ...input.query,
          }),
        ),
      ),
  });
}

function buildFolderSubrouter(notes: NotesService, auth: AuthService) {
  return trpc.router({
    list: authenticatedProcedure
      .input(z.object({ workspaceId: uuidSchema, query: folderListQuerySchema }).strict())
      .output(folderPageSchema)
      .query(({ ctx, input }) =>
        executeTrpc(() =>
          notes.listFolders({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            requestId: ctx.requestId,
            ...input.query,
          }),
        ),
      ),
    create: authenticatedProcedure
      .input(z.object({ workspaceId: uuidSchema, data: createFolderSchema }).strict())
      .output(folderCreateResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return notes.createFolder({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            requestId: ctx.requestId,
            ...input.data,
          });
        }),
      ),
    update: authenticatedProcedure
      .input(withFolderData(updateFolderSchema))
      .output(folderUpdateResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return notes.updateFolder({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            folderId: input.folderId,
            requestId: ctx.requestId,
            ...input.data,
          });
        }),
      ),
    delete: authenticatedProcedure
      .input(withFolderData(deleteFolderSchema))
      .output(folderDeleteResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return notes.deleteFolder({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            folderId: input.folderId,
            requestId: ctx.requestId,
          });
        }),
      ),
  });
}

export type NoteSubrouter = ReturnType<typeof buildNoteSubrouter>;
export type FolderSubrouter = ReturnType<typeof buildFolderSubrouter>;

/**
 * Thin first-party note/folder transport. Procedures share the REST Zod
 * contracts and call NotesService, which remains the sole policy/SQL
 * authority.
 */
@Injectable()
export class NotesTrpcRouter {
  readonly noteRouter: NoteSubrouter;
  readonly folderRouter: FolderSubrouter;

  constructor(notes: NotesService, auth: AuthService) {
    this.noteRouter = buildNoteSubrouter(notes, auth);
    this.folderRouter = buildFolderSubrouter(notes, auth);
  }
}
