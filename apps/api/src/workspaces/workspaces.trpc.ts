import { HttpStatus, Injectable } from "@nestjs/common";
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
import { initTRPC, TRPCError, type TRPC_ERROR_CODE_KEY } from "@trpc/server";
import { z } from "zod";

import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthService } from "../auth/auth.service";
import { AuthorizationDeniedError } from "../authorization/authorization.errors";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { requireIdempotencyKey } from "../common/idempotency/api-idempotency";
import { getRequestId } from "../common/request/request-context";

import { WorkspacesService } from "./workspaces.service";

import type { AuthenticatedPrincipal } from "@notted/shared-types";
import type { Request } from "express";

export const WORKSPACE_TRPC_PATH = "/api/v1/trpc" as const;

export interface WorkspaceTrpcContext {
  readonly request: Request;
  readonly principal: AuthenticatedPrincipal | null;
  readonly requestId: string | null;
}

const trpc = initTRPC.context<WorkspaceTrpcContext>().create({ isDev: false });

const workspaceSelectorSchema = z.object({ workspaceId: uuidSchema }).strict();
const workspaceUpdateInputSchema = z
  .object({ workspaceId: uuidSchema, data: updateWorkspaceSchema })
  .strict();
const workspaceDeleteInputSchema = z
  .object({ workspaceId: uuidSchema, data: workspaceDeleteSchema })
  .strict();

function trpcCodeForStatus(status: number): TRPC_ERROR_CODE_KEY {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return "BAD_REQUEST";
    case HttpStatus.UNAUTHORIZED:
      return "UNAUTHORIZED";
    case HttpStatus.FORBIDDEN:
      return "FORBIDDEN";
    case HttpStatus.NOT_FOUND:
      return "NOT_FOUND";
    case HttpStatus.CONFLICT:
      return "CONFLICT";
    default:
      return "INTERNAL_SERVER_ERROR";
  }
}

function safeTrpcError(error: unknown): TRPCError {
  if (error instanceof TRPCError) return error;
  if (error instanceof ApiHttpException) {
    return new TRPCError({
      code: trpcCodeForStatus(error.getStatus()),
      message: error.safeResponse.message,
    });
  }
  if (error instanceof AuthorizationDeniedError) {
    return new TRPCError({
      code: trpcCodeForStatus(error.decision.httpStatus),
      message: error.decision.safeMessage,
    });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "The request could not be completed.",
  });
}

async function executeTrpc<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error: unknown) {
    throw safeTrpcError(error);
  }
}

function buildWorkspacesTrpcRouter(workspaces: WorkspacesService, auth: AuthService) {
  const authenticated = trpc.procedure.use(({ ctx, next }) => {
    if (ctx.principal === null) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication is required." });
    }
    return next({ ctx: { ...ctx, principal: ctx.principal } });
  });

  return trpc.router({
    workspace: trpc.router({
      create: authenticated
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
      list: authenticated
        .input(workspaceListQuerySchema)
        .output(workspacePageSchema)
        .query(async ({ ctx, input }) => {
          const page = await executeTrpc(() =>
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
          );
          return { ...page, items: [...page.items] };
        }),
      read: authenticated
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
      update: authenticated
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
      delete: authenticated
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
    }),
  });
}

export type WorkspacesTrpcAppRouter = ReturnType<typeof buildWorkspacesTrpcRouter>;

/**
 * Thin first-party workspace transport. Procedures share the REST Zod
 * contracts and call WorkspacesService, which remains the sole policy/SQL
 * authority.
 */
@Injectable()
export class WorkspacesTrpcRouter {
  readonly router: WorkspacesTrpcAppRouter;

  constructor(workspaces: WorkspacesService, auth: AuthService) {
    this.router = buildWorkspacesTrpcRouter(workspaces, auth);
  }

  createContext(request: Request): WorkspaceTrpcContext {
    return Object.freeze({
      request,
      principal: getAuthPrincipal(request) ?? null,
      requestId: getRequestId(request) ?? null,
    });
  }
}
