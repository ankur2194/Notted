import { Injectable } from "@nestjs/common";
import {
  bulkTaskSchema,
  createTaskSchema,
  reorderTaskSchema,
  taskBulkResultSchema,
  taskCreateResultSchema,
  taskDeleteResultSchema,
  taskDetailSchema,
  taskListInputSchema,
  taskPageSchema,
  taskReorderResultSchema,
  taskUpdateResultSchema,
  updateTaskSchema,
  uuidSchema,
} from "@notted/shared-validators";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { AuthService } from "../auth/auth.service";
import { requireIdempotencyKey } from "../common/idempotency/api-idempotency";
import { executeTrpc, trpc } from "../trpc/trpc.router";

import { TasksService, type BulkTaskAction } from "./tasks.service";

/** Local authenticated procedure — not exported so its type need not be portable. */
const authenticatedProcedure = trpc.procedure.use(({ ctx, next }) => {
  if (ctx.principal === null) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication is required." });
  }
  return next({ ctx: { ...ctx, principal: ctx.principal } });
});

const taskSelectorSchema = z.object({ workspaceId: uuidSchema, taskId: uuidSchema }).strict();
const withTaskData = <T extends z.ZodType>(data: T) =>
  z.object({ workspaceId: uuidSchema, taskId: uuidSchema, data }).strict();

function buildTaskSubrouter(tasks: TasksService, auth: AuthService) {
  return trpc.router({
    list: authenticatedProcedure
      .input(z.object({ workspaceId: uuidSchema, query: taskListInputSchema }).strict())
      .output(taskPageSchema)
      .query(({ ctx, input }) =>
        executeTrpc(() =>
          tasks.list({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            requestId: ctx.requestId,
            ...input.query,
          }),
        ),
      ),
    read: authenticatedProcedure
      .input(taskSelectorSchema)
      .output(taskDetailSchema)
      .query(({ ctx, input }) =>
        executeTrpc(() =>
          tasks.read({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            taskId: input.taskId,
            requestId: ctx.requestId,
          }),
        ),
      ),
    create: authenticatedProcedure
      .input(z.object({ workspaceId: uuidSchema, data: createTaskSchema }).strict())
      .output(taskCreateResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return tasks.create({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            requestId: ctx.requestId,
            idempotencyKey: requireIdempotencyKey(ctx.request),
            projectId: input.data.projectId ?? null,
            noteId: input.data.noteId ?? null,
            parentId: input.data.parentId ?? null,
            title: input.data.title,
            description: input.data.description ?? null,
            status: input.data.status ?? "todo",
            customStatusId: input.data.customStatusId ?? null,
            priority: input.data.priority ?? "low",
            assigneeId: input.data.assigneeId ?? null,
            dueDate: input.data.dueDate ?? null,
            beforeTaskId: input.data.beforeTaskId ?? null,
            tagIds: input.data.tagIds ?? [],
            recurrence: input.data.recurrence ?? "none",
            recurrenceCron: input.data.recurrenceCron ?? null,
          });
        }),
      ),
    update: authenticatedProcedure
      .input(withTaskData(updateTaskSchema))
      .output(taskUpdateResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return tasks.update({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            taskId: input.taskId,
            requestId: ctx.requestId,
            ...input.data,
          });
        }),
      ),
    reorder: authenticatedProcedure
      .input(withTaskData(reorderTaskSchema))
      .output(taskReorderResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return tasks.reorder({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            taskId: input.taskId,
            requestId: ctx.requestId,
            ...input.data,
          });
        }),
      ),
    delete: authenticatedProcedure
      .input(taskSelectorSchema)
      .output(taskDeleteResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return tasks.remove({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            taskId: input.taskId,
            requestId: ctx.requestId,
          });
        }),
      ),
    bulk: authenticatedProcedure
      .input(z.object({ workspaceId: uuidSchema, data: bulkTaskSchema }).strict())
      .output(taskBulkResultSchema)
      .mutation(({ ctx, input }) =>
        executeTrpc(async () => {
          auth.assertTrustedMutationOrigin(ctx.request);
          return tasks.bulk({
            principal: ctx.principal,
            workspaceId: input.workspaceId,
            requestId: ctx.requestId,
            idempotencyKey: requireIdempotencyKey(ctx.request),
            taskIds: input.data.taskIds,
            action: input.data.action as BulkTaskAction,
          });
        }),
      ),
  });
}

export type TaskSubrouter = ReturnType<typeof buildTaskSubrouter>;

/**
 * Thin first-party task transport. Procedures share the REST Zod contracts and
 * call TasksService, which remains the sole policy/SQL authority.
 */
@Injectable()
export class TasksTrpcRouter {
  readonly taskRouter: TaskSubrouter;

  constructor(tasks: TasksService, auth: AuthService) {
    this.taskRouter = buildTaskSubrouter(tasks, auth);
  }
}
