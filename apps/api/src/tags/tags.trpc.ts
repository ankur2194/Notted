import { Injectable } from "@nestjs/common";
import {
  createTagSchema,
  tagCreateResultSchema,
  tagDeleteResultSchema,
  tagListQuerySchema,
  tagPageSchema,
  tagUpdateResultSchema,
  updateTagSchema,
  uuidSchema,
} from "@notted/shared-validators";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { AuthService } from "../auth/auth.service";
import { requireIdempotencyKey } from "../common/idempotency/api-idempotency";
import { executeTrpc, trpc } from "../trpc/trpc.router";

import { TagsService } from "./tags.service";

/** Local authenticated procedure — not exported so its type need not be portable. */
const authenticatedProcedure = trpc.procedure.use(({ ctx, next }) => {
  if (ctx.principal === null) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication is required." });
  }
  return next({ ctx: { ...ctx, principal: ctx.principal } });
});

const tagSelectorSchema = z.object({ workspaceId: uuidSchema, tagId: uuidSchema }).strict();

function buildTagSubrouter(tags: TagsService, auth: AuthService) {
  return trpc.router({
    list: authenticatedProcedure
      .input(z.object({ workspaceId: uuidSchema, query: tagListQuerySchema }).strict())
      .output(tagPageSchema)
      .query(({ ctx, input }) =>
        executeTrpc(() =>
          tags.list({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            requestId: ctx.requestId,
            ...input.query,
          }),
        ),
      ),
    create: authenticatedProcedure
      .input(z.object({ workspaceId: uuidSchema, data: createTagSchema }).strict())
      .output(tagCreateResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return tags.create({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            requestId: ctx.requestId,
            idempotencyKey: requireIdempotencyKey(ctx.request),
            name: input.data.name,
            color: input.data.color,
          });
        }),
      ),
    update: authenticatedProcedure
      .input(
        z.object({ workspaceId: uuidSchema, tagId: uuidSchema, data: updateTagSchema }).strict(),
      )
      .output(tagUpdateResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return tags.update({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            tagId: input.tagId,
            requestId: ctx.requestId,
            ...input.data,
          });
        }),
      ),
    delete: authenticatedProcedure
      .input(tagSelectorSchema)
      .output(tagDeleteResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return tags.remove({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            tagId: input.tagId,
            requestId: ctx.requestId,
          });
        }),
      ),
  });
}

export type TagSubrouter = ReturnType<typeof buildTagSubrouter>;

/**
 * Thin first-party tag transport. Procedures share the REST Zod contracts and
 * call TagsService, which remains the sole policy/SQL authority.
 */
@Injectable()
export class TagsTrpcRouter {
  readonly tagRouter: TagSubrouter;

  constructor(tags: TagsService, auth: AuthService) {
    this.tagRouter = buildTagSubrouter(tags, auth);
  }
}
