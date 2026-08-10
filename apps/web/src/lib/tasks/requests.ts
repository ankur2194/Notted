import { TASK_API_PATHS } from "@notted/shared-types";
import {
  bulkTaskSchema,
  createTaskSchema,
  reorderTaskSchema,
  taskBulkResultSchema,
  taskCreateResultSchema,
  taskDeleteResultSchema,
  taskListQuerySchema,
  taskPageSchema,
  taskReorderResultSchema,
  taskUpdateResultSchema,
  updateTaskSchema,
} from "@notted/shared-validators";

import type { ApiRequestResult } from "@/lib/api/request-json";
import type {
  TaskBulkResult,
  TaskCreateResult,
  TaskDeleteResult,
  TaskListQuery,
  TaskPage,
  TaskReorderResult,
  TaskUpdateResult,
} from "@notted/shared-types";
import type {
  BulkTaskInput,
  CreateTaskInput,
  ReorderTaskInput,
  UpdateTaskInput,
} from "@notted/shared-validators";

import { json, requestJson, validIds } from "@/lib/api/request-json";

function taskSearch(query: TaskListQuery): string {
  const params = new URLSearchParams({
    page: String(query.page),
    limit: String(query.limit),
    grouping: query.grouping,
    sortBy: query.sortBy,
    sortDirection: query.sortDirection,
  });
  for (const [key, value] of [
    ["noteId", query.noteId],
    ["projectId", query.projectId],
    ["parentId", query.parentId],
    ["assigneeId", query.assigneeId],
    ["status", query.status],
    ["priority", query.priority],
    ["tagId", query.tagId],
    ["dueFrom", query.dueFrom],
    ["dueTo", query.dueTo],
  ] as const) {
    if (value !== undefined) params.set(key, value);
  }
  // `isCompleted` is an explicit tri-state on the wire: absent means "either",
  // so it is only ever sent as the literal "true"/"false" the query contract
  // accepts, never as an empty string.
  if (query.isCompleted !== undefined) params.set("isCompleted", String(query.isCompleted));
  return params.toString();
}

/**
 * Restates an already-parsed `TaskListQuery` in the query-string shape
 * `taskListQuerySchema` accepts as input: callers hold the schema's *output*,
 * where `isCompleted` is a real boolean, while its input form is the raw
 * `"true"`/`"false"` string. Re-validating the output directly would reject
 * every completion-filtered query and silently render an empty list.
 */
function listQueryInput(query: TaskListQuery): Record<string, unknown> {
  return {
    ...query,
    isCompleted: query.isCompleted === undefined ? undefined : String(query.isCompleted),
  };
}

export function requestTaskPage(
  workspaceId: string,
  query: TaskListQuery,
): Promise<ApiRequestResult<TaskPage>> {
  const parsed = taskListQuerySchema.safeParse(listQueryInput(query));
  if (!validIds(workspaceId) || !parsed.success) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    `${TASK_API_PATHS.collection(workspaceId)}?${taskSearch(parsed.data)}`,
    {},
    (value) => taskPageSchema.safeParse(value),
  );
}

export function createTask(
  workspaceId: string,
  input: CreateTaskInput,
  idempotencyKey: string,
): Promise<ApiRequestResult<TaskCreateResult>> {
  const parsed = createTaskSchema.safeParse(input);
  if (!validIds(workspaceId) || !parsed.success || idempotencyKey.length < 8) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    TASK_API_PATHS.collection(workspaceId),
    json("POST", parsed.data, { "Idempotency-Key": idempotencyKey }),
    (value) => taskCreateResultSchema.safeParse(value),
  );
}

export function updateTask(
  workspaceId: string,
  taskId: string,
  input: UpdateTaskInput,
): Promise<ApiRequestResult<TaskUpdateResult>> {
  const parsed = updateTaskSchema.safeParse(input);
  if (!validIds(workspaceId, taskId) || !parsed.success) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    TASK_API_PATHS.detail(workspaceId, taskId),
    json("PATCH", parsed.data),
    (value) => taskUpdateResultSchema.safeParse(value),
  );
}

/**
 * Placement is always an anchor (`beforeTaskId`), never an index: `sortOrder` is
 * a double and the server computes the midpoint, so two clients reordering at
 * once converge instead of fighting over integer positions.
 */
export function reorderTask(
  workspaceId: string,
  taskId: string,
  input: ReorderTaskInput,
): Promise<ApiRequestResult<TaskReorderResult>> {
  const parsed = reorderTaskSchema.safeParse(input);
  if (!validIds(workspaceId, taskId) || !parsed.success) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    TASK_API_PATHS.reorder(workspaceId, taskId),
    json("POST", parsed.data),
    (value) => taskReorderResultSchema.safeParse(value),
  );
}

export function deleteTask(
  workspaceId: string,
  taskId: string,
): Promise<ApiRequestResult<TaskDeleteResult>> {
  if (!validIds(workspaceId, taskId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(TASK_API_PATHS.detail(workspaceId, taskId), { method: "DELETE" }, (value) =>
    taskDeleteResultSchema.safeParse(value),
  );
}

/**
 * One request for a whole selection. The result reports `skipped` separately:
 * a task the caller may not touch collapses to `unavailable` rather than
 * failing the batch, so the UI must reconcile against `updated` and never
 * assume every selected row changed.
 */
export function bulkUpdateTasks(
  workspaceId: string,
  input: BulkTaskInput,
  idempotencyKey: string,
): Promise<ApiRequestResult<TaskBulkResult>> {
  const parsed = bulkTaskSchema.safeParse(input);
  if (!validIds(workspaceId) || !parsed.success || idempotencyKey.length < 8) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  // `POST /tasks/bulk` calls `requireIdempotencyKey`, exactly like `POST /tasks`.
  // Omitting the header answers 400 and rolls the whole selection back.
  return requestJson(
    TASK_API_PATHS.bulk(workspaceId),
    json("POST", parsed.data, { "Idempotency-Key": idempotencyKey }),
    (value) => taskBulkResultSchema.safeParse(value),
  );
}
