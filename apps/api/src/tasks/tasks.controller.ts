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
  bulkTaskSchema,
  createTaskSchema,
  reorderTaskSchema,
  taskListQuerySchema,
  updateTaskSchema,
  uuidSchema,
} from "@notted/shared-validators";

import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthService } from "../auth/auth.service";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { requireIdempotencyKey } from "../common/idempotency/api-idempotency";
import { getRequestId } from "../common/request/request-context";

import { TasksService, type BulkTaskAction } from "./tasks.service";

import type {
  AuthenticatedPrincipal,
  TaskBulkResult,
  TaskCreateResult,
  TaskDeleteResult,
  TaskDetail,
  TaskPage,
  TaskReorderResult,
  TaskUpdateResult,
} from "@notted/shared-types";
import type { Request } from "express";

function routeUuid(request: Request, key: "workspaceId" | "taskId"): string {
  return uuidSchema.parse(request.params[key]);
}

/**
 * `workspace.read` is the coarse membership gate the guard can answer from the
 * URL alone. Every task-specific decision — including each identifier in a bulk
 * batch — is proved again inside `TasksService`, which is the only layer that
 * knows the destination container or the batch contents.
 */
const workspaceAuthorization = (action: "workspace.read" | "task.create") => ({
  action,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: () => ({ kind: "workspace" as const }),
});

const taskAuthorization = (action: "task.read" | "task.update" | "task.delete") => ({
  action,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: (request: Request) => ({ kind: "task" as const, id: routeUuid(request, "taskId") }),
});

@Controller("workspaces/:workspaceId/tasks")
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @RequireAuthorization(workspaceAuthorization("workspace.read"))
  list(@Req() request: Request, @Query() rawQuery: unknown): Promise<TaskPage> {
    const query = taskListQuerySchema.safeParse(rawQuery);
    if (!query.success) this.invalid();
    return this.tasks.list({ ...this.scope(request), ...query.data });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireAuthorization(workspaceAuthorization("task.create"))
  create(@Req() request: Request, @Body() rawBody: unknown): Promise<TaskCreateResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = createTaskSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.tasks.create({
      ...this.scope(request),
      projectId: body.data.projectId ?? null,
      noteId: body.data.noteId ?? null,
      parentId: body.data.parentId ?? null,
      title: body.data.title,
      description: body.data.description ?? null,
      status: body.data.status ?? "todo",
      customStatusId: body.data.customStatusId ?? null,
      priority: body.data.priority ?? "low",
      assigneeId: body.data.assigneeId ?? null,
      dueDate: body.data.dueDate ?? null,
      beforeTaskId: body.data.beforeTaskId ?? null,
      tagIds: body.data.tagIds ?? [],
      recurrence: body.data.recurrence ?? "none",
      recurrenceCron: body.data.recurrenceCron ?? null,
      idempotencyKey: requireIdempotencyKey(request),
    });
  }

  // MUST stay above every `:taskId` route: Nest matches in declaration order,
  // so a later `bulk` would be swallowed as a task identifier and rejected by
  // `uuidSchema` as a 400 instead of reaching this handler.
  @Post("bulk")
  @RequireAuthorization(workspaceAuthorization("workspace.read"))
  bulk(@Req() request: Request, @Body() rawBody: unknown): Promise<TaskBulkResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = bulkTaskSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.tasks.bulk({
      ...this.scope(request),
      taskIds: body.data.taskIds,
      action: body.data.action as BulkTaskAction,
      idempotencyKey: requireIdempotencyKey(request),
    });
  }

  @Get(":taskId")
  @RequireAuthorization(taskAuthorization("task.read"))
  read(@Req() request: Request): Promise<TaskDetail> {
    return this.tasks.read(this.taskScope(request));
  }

  @Patch(":taskId")
  @RequireAuthorization(taskAuthorization("task.update"))
  update(@Req() request: Request, @Body() rawBody: unknown): Promise<TaskUpdateResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = updateTaskSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.tasks.update({ ...this.taskScope(request), ...body.data });
  }

  @Post(":taskId/reorder")
  @RequireAuthorization(taskAuthorization("task.update"))
  reorder(@Req() request: Request, @Body() rawBody: unknown): Promise<TaskReorderResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = reorderTaskSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.tasks.reorder({ ...this.taskScope(request), ...body.data });
  }

  @Delete(":taskId")
  @RequireAuthorization(taskAuthorization("task.delete"))
  remove(@Req() request: Request): Promise<TaskDeleteResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.tasks.remove(this.taskScope(request));
  }

  private scope(request: Request) {
    return {
      principal: this.principal(request),
      workspaceId: routeUuid(request, "workspaceId"),
      requestId: getRequestId(request) ?? null,
    };
  }

  private taskScope(request: Request) {
    return { ...this.scope(request), taskId: routeUuid(request, "taskId") };
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
