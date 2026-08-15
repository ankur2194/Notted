// Part 60 — first-party tRPC twin of `comments.controller.ts`.
//
// `apps/web` does NOT consume tRPC for comments (it uses the versioned REST
// surface). This router exists for ADR 0002 parity: both transports reuse the
// same shared Zod contracts and the same `CommentsService`, so a policy or SQL
// change can never apply to one surface and not the other.

import { Injectable } from "@nestjs/common";
import {
  commentDeleteResultSchema,
  commentListQuerySchema,
  commentMutationResultSchema,
  commentPageSchema,
  commentResolutionSchema,
  createCommentSchema,
  updateCommentSchema,
  uuidSchema,
} from "@notted/shared-validators";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { AuthService } from "../auth/auth.service";
import { requireIdempotencyKey } from "../common/idempotency/api-idempotency";
import { executeTrpc, trpc } from "../trpc/trpc.router";

import { CommentsService } from "./comments.service";

/** Local authenticated procedure — not exported so its type need not be portable. */
const authenticatedProcedure = trpc.procedure.use(({ ctx, next }) => {
  if (ctx.principal === null) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication is required." });
  }
  return next({ ctx: { ...ctx, principal: ctx.principal } });
});

const noteSelectorSchema = z.object({ workspaceId: uuidSchema, noteId: uuidSchema }).strict();
const commentSelectorSchema = noteSelectorSchema.extend({ commentId: uuidSchema }).strict();

function buildCommentSubrouter(comments: CommentsService, auth: AuthService) {
  return trpc.router({
    list: authenticatedProcedure
      .input(noteSelectorSchema.extend({ query: commentListQuerySchema }).strict())
      .output(commentPageSchema)
      .query(({ ctx, input }) =>
        executeTrpc(async () => {
          const page = await comments.list({
            workspaceId: input.workspaceId,
            noteId: input.noteId,
            principal: ctx.principal,
            requestId: ctx.requestId,
            ...input.query,
          });
          // Zod intentionally materializes mutable arrays at the transport
          // boundary; the application service keeps its immutable contract.
          return {
            ...page,
            items: page.items.map((thread) => ({ ...thread, replies: [...thread.replies] })),
          };
        }),
      ),
    create: authenticatedProcedure
      .input(noteSelectorSchema.extend({ data: createCommentSchema }).strict())
      .output(commentMutationResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return comments.create({
            workspaceId: input.workspaceId,
            noteId: input.noteId,
            principal: ctx.principal,
            requestId: ctx.requestId,
            idempotencyKey: requireIdempotencyKey(ctx.request),
            content: input.data.content,
            parentId: input.data.parentId ?? null,
            anchor: input.data.anchor ?? null,
          });
        }),
      ),
    update: authenticatedProcedure
      .input(commentSelectorSchema.extend({ data: updateCommentSchema }).strict())
      .output(commentMutationResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return comments.update({
            workspaceId: input.workspaceId,
            noteId: input.noteId,
            commentId: input.commentId,
            principal: ctx.principal,
            requestId: ctx.requestId,
            content: input.data.content,
          });
        }),
      ),
    delete: authenticatedProcedure
      .input(commentSelectorSchema)
      .output(commentDeleteResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return comments.remove({
            workspaceId: input.workspaceId,
            noteId: input.noteId,
            commentId: input.commentId,
            principal: ctx.principal,
            requestId: ctx.requestId,
          });
        }),
      ),
    setResolution: authenticatedProcedure
      .input(commentSelectorSchema.extend({ data: commentResolutionSchema }).strict())
      .output(commentMutationResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return comments.setResolution({
            workspaceId: input.workspaceId,
            noteId: input.noteId,
            commentId: input.commentId,
            principal: ctx.principal,
            requestId: ctx.requestId,
            isResolved: input.data.isResolved,
          });
        }),
      ),
  });
}

export type CommentSubrouter = ReturnType<typeof buildCommentSubrouter>;

@Injectable()
export class CommentsTrpcRouter {
  readonly commentRouter: CommentSubrouter;

  constructor(comments: CommentsService, auth: AuthService) {
    this.commentRouter = buildCommentSubrouter(comments, auth);
  }
}
