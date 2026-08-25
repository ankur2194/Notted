import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  uuidSchema,
  workspaceDeleteSchema,
  workspaceListQuerySchema,
} from "@notted/shared-validators";

import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthGuard } from "../auth/auth.guard";
import { AuthService } from "../auth/auth.service";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { requireIdempotencyKey } from "../common/idempotency/api-idempotency";
import { getRequestId } from "../common/request/request-context";

import { WorkspacesService } from "./workspaces.service";

import type {
  AuthenticatedPrincipal,
  WorkspaceCreateResult,
  WorkspaceDeleteResult,
  WorkspaceDetail,
  WorkspacePage,
  WorkspaceUpdateResult,
} from "@notted/shared-types";
import type { Request } from "express";

/**
 * Resolve the workspace selector from the route param. Throws on a non-UUID id;
 * the authorization guard maps that to a concealed 404 so existence of any
 * workspace (cross-tenant or guessed) is never disclosed.
 */
function workspaceIdFromRoute(request: Request): string {
  return uuidSchema.parse(request.params.id);
}

const READ_AUTHORIZATION = {
  action: "workspace.read" as const,
  workspaceId: workspaceIdFromRoute,
  resource: () => ({ kind: "workspace" as const }),
};

const UPDATE_AUTHORIZATION = {
  action: "settings.update" as const,
  workspaceId: workspaceIdFromRoute,
  resource: () => ({ kind: "settings" as const }),
};

const DELETE_AUTHORIZATION = {
  action: "workspace.delete" as const,
  workspaceId: workspaceIdFromRoute,
  resource: () => ({ kind: "workspaceDeletion" as const }),
};

/**
 * Thin REST transport for the workspace lifecycle. Mounted under the global
 * `/api/v1` prefix as `/api/v1/workspaces`. Create/list are user-scoped (any
 * authenticated user may create a workspace and list their own memberships) and
 * therefore use {@link AuthGuard} only; read/update/delete prove workspace
 * membership through `@RequireAuthorization` before the service is reached.
 * Mutations require a trusted origin (CSRF defense).
 */
@Controller("workspaces")
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly auth: AuthService,
  ) {}

  @Post()
  @UseGuards(AuthGuard)
  create(@Req() request: Request, @Body() rawBody: unknown): Promise<WorkspaceCreateResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = createWorkspaceSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.workspaces.create({
      principal: this.principal(request),
      name: body.data.name,
      slug: body.data.slug,
      description: body.data.description ?? null,
      settings: body.data.settings,
      idempotencyKey: requireIdempotencyKey(request),
      requestId: getRequestId(request) ?? null,
    });
  }

  @Get()
  @UseGuards(AuthGuard)
  list(@Req() request: Request, @Query() rawQuery: unknown): Promise<WorkspacePage> {
    const query = workspaceListQuerySchema.safeParse(rawQuery);
    if (!query.success) this.invalid();
    return this.workspaces.list({
      principal: this.principal(request),
      page: query.data.page,
      limit: query.data.limit,
      name: query.data.name,
      plan: query.data.plan,
      currentUserRole: query.data.currentUserRole,
      sortBy: query.data.sortBy,
      sortDirection: query.data.sortDirection,
    });
  }

  @Get(":id")
  @RequireAuthorization(READ_AUTHORIZATION)
  read(@Req() request: Request): Promise<WorkspaceDetail> {
    return this.workspaces.read({
      principal: this.principal(request),
      workspaceId: workspaceIdFromRoute(request),
      requestId: getRequestId(request) ?? null,
    });
  }

  @Patch(":id")
  @RequireAuthorization(UPDATE_AUTHORIZATION)
  update(@Req() request: Request, @Body() rawBody: unknown): Promise<WorkspaceUpdateResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = updateWorkspaceSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.workspaces.update({
      principal: this.principal(request),
      workspaceId: workspaceIdFromRoute(request),
      name: body.data.name,
      slug: body.data.slug,
      description: body.data.description,
      settings: body.data.settings,
      requestId: getRequestId(request) ?? null,
    });
  }

  @Delete(":id")
  @RequireAuthorization(DELETE_AUTHORIZATION)
  delete(@Req() request: Request, @Body() rawBody: unknown): Promise<WorkspaceDeleteResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = workspaceDeleteSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.workspaces.delete({
      principal: this.principal(request),
      workspaceId: workspaceIdFromRoute(request),
      confirmed: true,
      expectedName: body.data.expectedName,
      requestId: getRequestId(request) ?? null,
    });
  }

  private principal(request: Request): AuthenticatedPrincipal {
    const principal = getAuthPrincipal(request);
    if (principal === undefined) throw new Error("Authorization guard did not attach a principal");
    return principal;
  }

  private invalid(): never {
    throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
      code: "VALIDATION_ERROR",
      message: "The request is invalid.",
    });
  }
}
