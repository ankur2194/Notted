/**
 * Optimistic-update arithmetic for the task list: what a row will look like once
 * the server agrees, and what to say when it does not.
 *
 * Split out of `TaskListView.tsx` (933 lines) because none of it is a component:
 * every function here takes values and returns values, with no hook, no state
 * and no DOM. They are the parts of that file a test can exercise without
 * mounting anything, and `lib/tasks/grouping.ts` next door already established
 * that this is where the list's pure logic lives.
 */

import type { ApiRequestFailureKind } from "@/lib/api/request-json";
import type { TaskSummary } from "@notted/shared-types";
import type { BulkTaskInput, UpdateTaskInput } from "@notted/shared-validators";

/**
 * Every selected task plus every descendant of one that is on this page.
 *
 * Deleting a task cascades through `tasks.parent_id`, so selecting three
 * parents can destroy far more than three rows. A confirmation that only
 * counted the selection would understate what the user is about to do.
 *
 * This is a FLOOR, not an exact number: a subtask that lives on a later page
 * cannot be counted from here, which is why the copy says "at least". The
 * server reports the true total back as `affected`.
 */
export function deletionScope(
  items: readonly TaskSummary[],
  selectedIds: ReadonlySet<string>,
): Set<string> {
  const children = new Map<string, string[]>();
  for (const item of items) {
    if (item.parentId === null) continue;
    children.set(item.parentId, [...(children.get(item.parentId) ?? []), item.id]);
  }
  const scope = new Set<string>();
  const stack = items.filter((item) => selectedIds.has(item.id)).map((item) => item.id);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (scope.has(id)) continue;
    scope.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return scope;
}

export function failureMessage(
  action: string,
  kind: ApiRequestFailureKind,
  restoredSubject: "task" | "list" | "order" = "task",
): string {
  const restored = `The previous ${restoredSubject} was restored`;
  if (kind === "forbidden-or-not-found")
    return `${action} was denied or the task is no longer available. ${restored}.`;
  if (kind === "version-conflict" || kind === "conflict")
    return `${action} conflicted with a recent change by someone else. ${restored}; reload and retry.`;
  if (kind === "invalid") return `${action} was not accepted. ${restored}.`;
  return `${action} could not reach Notted. ${restored}; check your connection and retry.`;
}

/**
 * The row as it will look once the server agrees.
 *
 * Only fields the request actually carries are changed, and `completedAt` is
 * derived from `status` because that pair drives both the checkbox and the
 * overdue test — leaving it stale would show a completed task as overdue until
 * the refetch landed.
 */
export function optimisticTask(task: TaskSummary, input: UpdateTaskInput, at: string): TaskSummary {
  return {
    ...task,
    title: input.title ?? task.title,
    status: input.status ?? task.status,
    customStatusId: input.customStatusId === undefined ? task.customStatusId : input.customStatusId,
    // The board already shows the destination column's own heading, so the row
    // label is simply dropped until the server answers with the real one rather
    // than guessed at here.
    statusLabel: input.customStatusId === undefined ? task.statusLabel : null,
    completedAt:
      input.status === undefined
        ? task.completedAt
        : input.status === "done"
          ? (task.completedAt ?? at)
          : null,
    priority: input.priority ?? task.priority,
    assigneeId: input.assigneeId === undefined ? task.assigneeId : input.assigneeId,
    dueDate: input.dueDate === undefined ? task.dueDate : input.dueDate,
    tagIds: input.tagIds === undefined ? task.tagIds : [...input.tagIds],
    recurrence: input.recurrence ?? task.recurrence,
    recurrenceCron: input.recurrenceCron === undefined ? task.recurrenceCron : input.recurrenceCron,
  };
}

export function applyBulk(
  task: TaskSummary,
  action: BulkTaskInput["action"],
  at: string,
): TaskSummary {
  switch (action.kind) {
    case "status":
      return {
        ...task,
        status: action.status,
        completedAt: action.status === "done" ? (task.completedAt ?? at) : null,
      };
    case "priority":
      return { ...task, priority: action.priority };
    case "assign":
      return { ...task, assigneeId: action.assigneeId };
    case "tag":
      return { ...task, tagIds: [...action.tagIds] };
    case "delete":
      // A delete removes the row rather than rewriting it; the caller drops it.
      return task;
  }
}
