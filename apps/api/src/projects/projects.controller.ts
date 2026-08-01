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
  createProjectSchema,
  projectListQuerySchema,
  updateProjectSchema,
  uuidSchema,
} from "@notted/shared-validators";

import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthService } from "../auth/auth.service";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { requireIdempotencyKey } from "../common/idempotency/api-idempotency";
import { getRequestId } from "../common/request/request-context";

import { ProjectsService } from "./projects.service";

import type {
  AuthenticatedPrincipal,
  ProjectCreateResult,
  ProjectDeleteResult,
  ProjectDetail,
  ProjectPage,
  ProjectStatusResult,
  ProjectUpdateResult,
} from "@notted/shared-types";
import type { Request } from "express";

function routeUuid(request: Request, key: "workspaceId" | "projectId"): string {
  return uuidSchema.parse(request.params[key]);
}

const workspaceReadAuthorization = {
  action: "workspace.read" as const,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: () => ({ kind: "workspace" as const }),
};
const createAuthorization = {
  action: "project.create" as const,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: () => ({ kind: "workspace" as const }),
};
const projectAuthorization = (action: "project.read" | "project.update" | "project.delete") => ({
  action,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: (request: Request) => ({
    kind: "project" as const,
    id: routeUuid(request, "projectId"),
  }),
});

/** Thin REST transport; service methods own authorization, tenant scope, and transactions. */
@Controller("workspaces/:workspaceId/projects")
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @RequireAuthorization(workspaceReadAuthorization)
  list(@Req() request: Request, @Query() rawQuery: unknown): Promise<ProjectPage> {
    const query = projectListQuerySchema.safeParse(rawQuery);
    if (!query.success) this.invalid();
    return this.projects.list({
      principal: this.principal(request),
      workspaceId: routeUuid(request, "workspaceId"),
      page: query.data.page,
      limit: query.data.limit,
      status: query.data.status,
      archived: query.data.archived,
      dueFrom: query.data.dueFrom,
      dueTo: query.data.dueTo,
      name: query.data.name,
      sortBy: query.data.sortBy,
      sortDirection: query.data.sortDirection,
      requestId: getRequestId(request) ?? null,
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireAuthorization(createAuthorization)
  create(@Req() request: Request, @Body() rawBody: unknown): Promise<ProjectCreateResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = createProjectSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.projects.create({
      principal: this.principal(request),
      workspaceId: routeUuid(request, "workspaceId"),
      name: body.data.name,
      description: body.data.description,
      coverImageUrl: body.data.coverImageUrl,
      color: body.data.color,
      status: body.data.status,
      dueAt: body.data.dueAt,
      idempotencyKey: requireIdempotencyKey(request),
      requestId: getRequestId(request) ?? null,
    });
  }

  @Get(":projectId")
  @RequireAuthorization(projectAuthorization("project.read"))
  read(@Req() request: Request): Promise<ProjectDetail> {
    return this.projects.read(this.projectSelector(request));
  }

  @Patch(":projectId")
  @HttpCode(HttpStatus.OK)
  @RequireAuthorization(projectAuthorization("project.update"))
  update(@Req() request: Request, @Body() rawBody: unknown): Promise<ProjectUpdateResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = updateProjectSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.projects.update({
      ...this.projectSelector(request),
      name: body.data.name,
      description: body.data.description,
      coverImageUrl: body.data.coverImageUrl,
      color: body.data.color,
      status: body.data.status,
      dueAt: body.data.dueAt,
    });
  }

  @Post(":projectId/archive")
  @HttpCode(HttpStatus.OK)
  @RequireAuthorization(projectAuthorization("project.update"))
  archive(@Req() request: Request): Promise<ProjectStatusResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.projects.archive(this.projectSelector(request));
  }

  @Post(":projectId/complete")
  @HttpCode(HttpStatus.OK)
  @RequireAuthorization(projectAuthorization("project.update"))
  complete(@Req() request: Request): Promise<ProjectStatusResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.projects.complete(this.projectSelector(request));
  }

  @Post(":projectId/restore")
  @HttpCode(HttpStatus.OK)
  @RequireAuthorization(projectAuthorization("project.update"))
  restore(@Req() request: Request): Promise<ProjectStatusResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.projects.restore(this.projectSelector(request));
  }

  @Delete(":projectId")
  @HttpCode(HttpStatus.OK)
  @RequireAuthorization(projectAuthorization("project.delete"))
  delete(@Req() request: Request): Promise<ProjectDeleteResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.projects.delete(this.projectSelector(request));
  }

  private projectSelector(request: Request) {
    return {
      principal: this.principal(request),
      workspaceId: routeUuid(request, "workspaceId"),
      projectId: routeUuid(request, "projectId"),
      requestId: getRequestId(request) ?? null,
    };
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
