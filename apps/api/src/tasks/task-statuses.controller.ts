import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  createTaskStatusSchema,
  taskStatusListQuerySchema,
  updateTaskStatusSchema,
  uuidSchema,
} from "@notted/shared-validators";

import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthService } from "../auth/auth.service";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { requireIdempotencyKey } from "../common/idempotency/api-idempotency";
import { getRequestId } from "../common/request/request-context";

import { TaskStatusesService } from "./task-statuses.service";

import type {
  AuthenticatedPrincipal,
  CustomTaskStatusList,
  TaskStatusDeleteResult,
  TaskStatusMutationResult,
} from "@notted/shared-types";
import type { Request } from "express";

function routeUuid(request: Request, key: "workspaceId" | "statusId"): string {
  return uuidSchema.parse(request.params[key]);
}

const workspaceId = (request: Request): string => routeUuid(request, "workspaceId");

/**
 * Listing columns is plain workspace membership. A `projectId` in the query
 * narrows the answer, and `TaskStatusesService` proves `project.read` on it
 * before any SQL — the guard cannot, because the project is a query parameter
 * rather than part of the path.
 */
const READ_AUTHORIZATION = {
  action: "workspace.read" as const,
  workspaceId,
  resource: () => ({ kind: "workspace" as const }),
};

/**
 * Managing columns reuses `settings.update`, which the central policy already
 * grants to owner and admin and denies to editor and viewer. No new action and
 * no new resource kind: a bespoke role check here would be a second, untested
 * copy of the permission matrix.
 */
const MANAGE_AUTHORIZATION = {
  action: "settings.update" as const,
  workspaceId,
  resource: () => ({ kind: "settings" as const }),
};

@Controller("workspaces/:workspaceId/task-statuses")
export class TaskStatusesController {
  constructor(
    private readonly statuses: TaskStatusesService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @RequireAuthorization(READ_AUTHORIZATION)
  list(@Req() request: Request, @Query() rawQuery: unknown): Promise<CustomTaskStatusList> {
    const query = taskStatusListQuerySchema.safeParse(rawQuery ?? {});
    if (!query.success) this.invalid();
    return this.statuses.list({ ...this.scope(request), ...query.data });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireAuthorization(MANAGE_AUTHORIZATION)
  create(@Req() request: Request, @Body() rawBody: unknown): Promise<TaskStatusMutationResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = createTaskStatusSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.statuses.create({
      ...this.scope(request),
      projectId: body.data.projectId,
      name: body.data.name,
      ...(body.data.color === undefined ? {} : { color: body.data.color }),
      idempotencyKey: requireIdempotencyKey(request),
    });
  }

  @Patch(":statusId")
  @RequireAuthorization(MANAGE_AUTHORIZATION)
  update(@Req() request: Request, @Body() rawBody: unknown): Promise<TaskStatusMutationResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = updateTaskStatusSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.statuses.update({ ...this.statusScope(request), ...body.data });
  }

  @Delete(":statusId")
  @RequireAuthorization(MANAGE_AUTHORIZATION)
  remove(@Req() request: Request): Promise<TaskStatusDeleteResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.statuses.remove(this.statusScope(request));
  }

  private scope(request: Request) {
    return {
      principal: this.principal(request),
      workspaceId: workspaceId(request),
      requestId: getRequestId(request) ?? null,
    };
  }

  private statusScope(request: Request) {
    return { ...this.scope(request), statusId: routeUuid(request, "statusId") };
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
