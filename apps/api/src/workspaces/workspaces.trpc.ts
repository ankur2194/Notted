import { Injectable } from "@nestjs/common";
import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  uuidSchema,
  workspaceCreateResultSchema,
  workspaceDeleteResultSchema,
  workspaceDeleteSchema,
  workspaceDetailSchema,
  workspaceListQuerySchema,
  workspacePageSchema,
  workspaceUpdateResultSchema,
} from "@notted/shared-validators";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { AuthService } from "../auth/auth.service";
import { requireIdempotencyKey } from "../common/idempotency/api-idempotency";
import { createTrpcContext, type TrpcContext } from "../trpc/trpc.context";
import { executeTrpc, TRPC_PATH, trpc } from "../trpc/trpc.router";

import { WorkspacesService } from "./workspaces.service";

import type { Request } from "express";

export const WORKSPACE_TRPC_PATH = TRPC_PATH;
export type WorkspaceTrpcContext = TrpcContext;

/** Local authenticated procedure — not exported so its type need not be portable. */
const authenticatedProcedure = trpc.procedure.use(({ ctx, next }) => {
  if (ctx.principal === null) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication is required." });
  }
  return next({ ctx: { ...ctx, principal: ctx.principal } });
});

const workspaceSelectorSchema = z.object({ workspaceId: uuidSchema }).strict();
const workspaceUpdateInputSchema = z
  .object({ workspaceId: uuidSchema, data: updateWorkspaceSchema })
  .strict();
const workspaceDeleteInputSchema = z
  .object({ workspaceId: uuidSchema, data: workspaceDeleteSchema })
  .strict();

function buildWorkspaceSubrouter(workspaces: WorkspacesService, auth: AuthService) {
  return trpc.router({
    create: authenticatedProcedure
      .input(createWorkspaceSchema)
      .output(workspaceCreateResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return workspaces.create({
            principal: ctx.principal,
            name: input.name,
            slug: input.slug,
            description: input.description ?? null,
            domain: input.domain ?? null,
            settings: input.settings,
            idempotencyKey: requireIdempotencyKey(ctx.request),
            requestId: ctx.requestId,
          });
        }),
      ),
    list: authenticatedProcedure
      .input(workspaceListQuerySchema)
      .output(workspacePageSchema)
      .query(({ ctx, input }) =>
        executeTrpc(() =>
          workspaces.list({
            principal: ctx.principal,
            page: input.page,
            limit: input.limit,
            name: input.name,
            plan: input.plan,
            currentUserRole: input.currentUserRole,
            sortBy: input.sortBy,
            sortDirection: input.sortDirection,
          }),
        ),
      ),
    read: authenticatedProcedure
      .input(workspaceSelectorSchema)
      .output(workspaceDetailSchema)
      .query(({ ctx, input }) =>
        executeTrpc(() =>
          workspaces.read({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            requestId: ctx.requestId,
          }),
        ),
      ),
    update: authenticatedProcedure
      .input(workspaceUpdateInputSchema)
      .output(workspaceUpdateResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return workspaces.update({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            name: input.data.name,
            slug: input.data.slug,
            description: input.data.description,
            domain: input.data.domain,
            settings: input.data.settings,
            requestId: ctx.requestId,
          });
        }),
      ),
    delete: authenticatedProcedure
      .input(workspaceDeleteInputSchema)
      .output(workspaceDeleteResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return workspaces.delete({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            confirmed: true,
            expectedName: input.data.expectedName,
            requestId: ctx.requestId,
          });
        }),
      ),
  });
}

export type WorkspaceTrpcSubrouter = ReturnType<typeof buildWorkspaceSubrouter>;

function buildWorkspaceCompatRouter(subrouter: WorkspaceTrpcSubrouter) {
  return trpc.router({ workspace: subrouter });
}
export type WorkspacesCompatRouter = ReturnType<typeof buildWorkspaceCompatRouter>;

/**
 * Thin first-party workspace transport. Procedures share the REST Zod
 * contracts and call WorkspacesService, which remains the sole policy/SQL
 * authority.
 */
@Injectable()
export class WorkspacesTrpcRouter {
  readonly workspaceRouter: WorkspaceTrpcSubrouter;
  readonly router: WorkspacesCompatRouter;

  constructor(workspaces: WorkspacesService, auth: AuthService) {
    this.workspaceRouter = buildWorkspaceSubrouter(workspaces, auth);
    // Compatibility wrapper for existing Part 26 callers/tests. Runtime uses
    // TrpcRootRouter to compose this subrouter with notes and folders.
    this.router = buildWorkspaceCompatRouter(this.workspaceRouter);
  }

  createContext(request: Request): WorkspaceTrpcContext {
    return createTrpcContext(request);
  }
}
