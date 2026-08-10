"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { CreateTaskForm } from "./CreateTaskForm";
import { TaskRow } from "./TaskRow";
import { TaskSortableList } from "./TaskSortableList";

import type { ApiRequestFailureKind } from "@/lib/api/request-json";
import type {
  TagListQuery,
  TagSummary,
  TaskGrouping,
  TaskListQuery,
  TaskPage,
  TaskPriority,
  TaskSummary,
} from "@notted/shared-types";
import type { BulkTaskInput, UpdateTaskInput } from "@notted/shared-validators";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { fetchWorkspaceMemberDirectory } from "@/lib/notes/member-directory";
import { noteQueryKeys, tagQueryKeys, taskQueryKeys } from "@/lib/notes/query-keys";
import { requestTagPage } from "@/lib/tags/requests";
import { groupTasks } from "@/lib/tasks/grouping";
import {
  bulkUpdateTasks,
  createTask,
  deleteTask,
  reorderTask,
  requestTaskPage,
  updateTask,
} from "@/lib/tasks/requests";

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
function deletionScope(
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

const TAG_LIST_QUERY = {
  page: 1,
  limit: 100,
  sortBy: "name",
  sortDirection: "asc",
} as const satisfies TagListQuery;

const GROUPINGS: readonly { readonly value: TaskGrouping; readonly label: string }[] = [
  { value: "none", label: "None" },
  { value: "status", label: "Status" },
  { value: "priority", label: "Priority" },
  { value: "assignee", label: "Assignee" },
  { value: "dueDate", label: "Due date" },
];

const BULK_PRIORITIES: readonly { readonly value: TaskPriority; readonly label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

/** How often the overdue boundary is re-evaluated against the browser clock. */
const CLOCK_INTERVAL_MS = 60_000;

function failureMessage(
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
function optimisticTask(task: TaskSummary, input: UpdateTaskInput, at: string): TaskSummary {
  return {
    ...task,
    title: input.title ?? task.title,
    status: input.status ?? task.status,
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

function applyBulk(task: TaskSummary, action: BulkTaskInput["action"], at: string): TaskSummary {
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
      return task;
  }
}

export function TaskListView({
  workspaceId,
  noteId,
  projectId,
  initialTasks,
  canEdit,
}: {
  readonly workspaceId: string;
  readonly noteId: string;
  /**
   * The note's own project, or `null` at the workspace root. Load-bearing on
   * create: the server requires `note.projectId === task.projectId`, so
   * omitting it 404s every task on a project-scoped note.
   */
  readonly projectId: string | null;
  readonly initialTasks: TaskPage | null;
  readonly canEdit: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [grouping, setGrouping] = useState<TaskGrouping>("none");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkPriority, setBulkPriority] = useState<TaskPriority>("medium");
  const [status, setStatus] = useState("");
  const [now, setNow] = useState(() => new Date());
  const selectAllRef = useRef<HTMLInputElement>(null);

  // Overdue is a comparison against the browser clock, so a page left open has
  // to re-evaluate it. A minute is finer than any due-date the UI can express.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  /*
   * Server grouping stays `none` and the client groups locally: regrouping is a
   * pure repartition of rows already in hand, so making it a query parameter
   * would refetch the same page and reset every in-flight optimistic edit.
   */
  const query = useMemo<TaskListQuery>(
    () => ({
      page: 1,
      limit: 100,
      noteId,
      grouping: "none",
      sortBy: "sortOrder",
      sortDirection: "asc",
    }),
    [noteId],
  );

  const tasksQuery = useQuery({
    queryKey: taskQueryKeys.list(workspaceId, query),
    initialData: initialTasks ?? undefined,
    queryFn: async () => {
      const result = await requestTaskPage(workspaceId, query);
      if (!result.ok) throw new Error(result.kind);
      return result.data;
    },
  });

  /*
   * Neither directory below gates the task list. A workspace whose members or
   * tags cannot be read still has readable, editable tasks — the assignee
   * options and tag chips degrade to an explained empty state instead of
   * blanking the page.
   */
  const membersQuery = useQuery({
    queryKey: noteQueryKeys.members(workspaceId),
    queryFn: () => fetchWorkspaceMemberDirectory(workspaceId),
    retry: false,
  });
  const tagsQuery = useQuery({
    queryKey: tagQueryKeys.list(workspaceId, TAG_LIST_QUERY),
    queryFn: async () => {
      const result = await requestTagPage(workspaceId, TAG_LIST_QUERY);
      return result.ok ? result.data.items : [];
    },
  });

  const members = membersQuery.data?.items ?? [];
  const tags: readonly TagSummary[] = tagsQuery.data ?? [];
  const page = tasksQuery.data;
  const operationPending = pendingIds.size > 0;

  const selectedCount =
    page === undefined ? 0 : page.items.filter((t) => selectedIds.has(t.id)).length;
  useEffect(() => {
    if (selectAllRef.current === null) return;
    selectAllRef.current.indeterminate =
      selectedCount > 0 && page !== undefined && selectedCount < page.items.length;
  }, [selectedCount, page]);

  function setPage(next: TaskPage): void {
    queryClient.setQueryData(taskQueryKeys.list(workspaceId, query), next);
  }

  function markPending(taskId: string, pending: boolean): void {
    setPendingIds((current) => {
      const next = new Set(current);
      if (pending) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  }

  async function reconcile(): Promise<void> {
    await tasksQuery.refetch();
    router.refresh();
  }

  async function create(
    title: string,
    temporaryId: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    if (page === undefined) return false;
    const snapshot = { ...page, items: [...page.items] };
    const at = new Date().toISOString();
    const temporary: TaskSummary = {
      id: temporaryId,
      workspaceId,
      projectId,
      noteId,
      parentId: null,
      title,
      status: "todo",
      customStatusId: null,
      statusLabel: null,
      // Matches the column default, so the row does not visibly change
      // priority the moment the server response replaces it.
      priority: "low",
      assigneeId: null,
      dueDate: null,
      completedAt: null,
      sortOrder: page.items.length + 1,
      recurrence: "none",
      recurrenceCron: null,
      tagIds: [],
      createdAt: at,
      updatedAt: at,
    };
    setPage({ ...page, items: [...page.items, temporary] });
    markPending(temporaryId, true);
    setStatus(`Adding ${title}…`);
    const result = await createTask(workspaceId, { noteId, projectId, title }, idempotencyKey);
    markPending(temporaryId, false);
    if (!result.ok) {
      setPage(snapshot);
      setStatus(failureMessage("Adding the task", result.kind, "list"));
      return false;
    }
    setPage({ ...snapshot, items: [...snapshot.items, result.data.task] });
    setStatus(`Added ${result.data.task.title}.`);
    await reconcile();
    return true;
  }

  async function update(task: TaskSummary, input: UpdateTaskInput): Promise<void> {
    if (page === undefined || operationPending) return;
    const snapshot = { ...page, items: [...page.items] };
    const at = new Date().toISOString();
    markPending(task.id, true);
    setPage({
      ...page,
      items: page.items.map((item) =>
        item.id === task.id ? optimisticTask(item, input, at) : item,
      ),
    });
    setStatus(`Updating ${task.title}…`);
    const result = await updateTask(workspaceId, task.id, input);
    markPending(task.id, false);
    if (!result.ok) {
      setPage(snapshot);
      setStatus(failureMessage("The task update", result.kind));
      return;
    }
    // A recurring task that was just completed returns its next occurrence, so
    // the row appears without waiting for the refetch below.
    const spawned = result.data.spawned;
    setPage({
      ...snapshot,
      items: [
        ...snapshot.items.map((item) => (item.id === task.id ? result.data.task : item)),
        ...(spawned === null ? [] : [spawned]),
      ],
    });
    setStatus(
      spawned === null
        ? `Updated ${result.data.task.title}.`
        : `Completed ${result.data.task.title}. The next occurrence was added.`,
    );
    await reconcile();
  }

  async function remove(task: TaskSummary): Promise<void> {
    if (page === undefined || operationPending) return;
    const snapshot = { ...page, items: [...page.items] };
    markPending(task.id, true);
    setPage({ ...page, items: page.items.filter((item) => item.id !== task.id) });
    setStatus(`Deleting ${task.title}…`);
    const result = await deleteTask(workspaceId, task.id);
    markPending(task.id, false);
    if (!result.ok) {
      setPage(snapshot);
      setStatus(failureMessage("Deleting the task", result.kind, "list"));
      return;
    }
    setStatus(`Deleted ${task.title}.`);
    await reconcile();
  }

  async function reorder(
    task: TaskSummary,
    beforeTaskId: string | null,
    position: number,
  ): Promise<void> {
    if (page === undefined || operationPending) return;
    const snapshot = { ...page, items: [...page.items] };
    const others = page.items.filter((item) => item.id !== task.id);
    markPending(task.id, true);
    setPage({
      ...page,
      items: [...others.slice(0, position - 1), task, ...others.slice(position - 1)],
    });
    setStatus(`Moving ${task.title}…`);
    // Deliberately no `noteId`/`projectId`/`parentId`: the server reads ANY
    // explicit container field as an absolute move, where an omitted sibling
    // means root rather than "keep". Sending only the anchor keeps this a pure
    // in-group reorder, so dragging a subtask cannot silently re-parent it and
    // a task on a project note cannot be moved out of its project.
    const result = await reorderTask(workspaceId, task.id, { beforeTaskId });
    markPending(task.id, false);
    if (!result.ok) {
      setPage(snapshot);
      setStatus(failureMessage("The move", result.kind, "order"));
      return;
    }
    setStatus(`Moved ${task.title} to position ${position} of ${snapshot.items.length}.`);
    await reconcile();
  }

  async function bulk(action: BulkTaskInput["action"], describe: string): Promise<void> {
    if (page === undefined || operationPending) return;
    const ids = page.items.filter((item) => selectedIds.has(item.id)).map((item) => item.id);
    if (ids.length === 0) return;
    const snapshot = { ...page, items: [...page.items] };
    const at = new Date().toISOString();
    setPendingIds(new Set(ids));
    setPage({
      ...page,
      items:
        action.kind === "delete"
          ? page.items.filter((item) => !ids.includes(item.id))
          : page.items.map((item) => (ids.includes(item.id) ? applyBulk(item, action, at) : item)),
    });
    setStatus(`${describe} for ${ids.length} tasks…`);
    const result = await bulkUpdateTasks(
      workspaceId,
      { taskIds: ids, action },
      crypto.randomUUID(),
    );
    setPendingIds(new Set());
    if (!result.ok) {
      setPage(snapshot);
      setStatus(failureMessage(describe, result.kind, "list"));
      return;
    }
    setSelectedIds(new Set());
    const skipped = result.data.skipped.length;
    // `applyBulk` returns the authorized count for every non-delete action, so
    // a zero alongside a non-empty `updated` means this call wrote nothing —
    // the idempotent replay of a batch that already landed. Announcing "N of N
    // changed" there would claim work the request did not do.
    if (result.data.affected === 0 && result.data.updated.length > 0) {
      setStatus(`${describe}: already applied. Nothing was changed by this request.`);
      await reconcile();
      return;
    }
    // `affected` counts cascaded subtasks the selection never named, so a
    // delete is reported by what it destroyed rather than by what was clicked.
    const cascaded =
      action.kind === "delete" && result.data.affected > result.data.updated.length
        ? `, ${result.data.affected} rows removed including subtasks`
        : "";
    setStatus(
      `${describe}: ${result.data.updated.length} of ${ids.length} tasks changed${cascaded}` +
        (skipped === 0 ? "." : `, ${skipped} unavailable and left unchanged.`),
    );
    await reconcile();
  }

  if (tasksQuery.isError) {
    return (
      <section className="rounded-xl border bg-card p-6" role="alert">
        <h3 className="text-lg font-semibold">Tasks unavailable</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          The task list could not be loaded. No task was changed.
        </p>
        <Button className="mt-4" onClick={() => void reconcile()}>
          Retry
        </Button>
      </section>
    );
  }

  if (page === undefined) {
    return (
      <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        Loading tasks…
      </p>
    );
  }

  const memberNames = new Map(members.map((member) => [member.userId, member.name]));
  const groups = groupTasks(page.items, grouping, now).map((group) =>
    grouping === "assignee" && group.key !== "unassigned"
      ? { ...group, label: memberNames.get(group.key) ?? "Unknown member" }
      : group,
  );
  /** Subtasks the cascade will take that the user did not select outright. */
  const cascadedCount = deletionScope(page.items, selectedIds).size - selectedCount;
  const orderable = grouping === "none" && page.page === 1 && !page.hasMore;
  const dragDisabled = !canEdit || operationPending || !orderable;
  // Only a structural reason is explained. A momentary pending state disables
  // the controls too, but announcing it would be noise on every keystroke.
  const dragDisabledReason = !canEdit
    ? null
    : grouping !== "none"
      ? "Reordering is unavailable while tasks are grouped, because a drop could only be placed against part of the order. Choose grouping “None” to reorder."
      : orderable
        ? null
        : "Reordering is available only in the complete first page of tasks sorted by task order.";

  return (
    <div className="space-y-4">
      {canEdit ? null : (
        <p className="rounded-md border bg-muted/30 p-3 text-sm" role="note">
          Your current role can read these tasks but cannot change them. Backend authorization
          remains authoritative.
        </p>
      )}
      {membersQuery.isError ? (
        <p className="rounded-md border bg-muted/30 p-3 text-sm" role="note">
          The workspace member list could not be loaded, so assignment is limited to “Unassigned”
          until it is available.
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="task-grouping">
            Group tasks by
          </label>
          <select
            id="task-grouping"
            className="min-h-11 rounded-md border bg-background px-3 text-sm"
            value={grouping}
            onChange={(event) => setGrouping(event.target.value as TaskGrouping)}
          >
            {GROUPINGS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        {canEdit ? <CreateTaskForm disabled={operationPending} onCreate={create} /> : null}
      </div>

      {/* One live region for the whole list: every optimistic result, failure
          and rollback is announced here, so a screen reader hears one ordered
          narrative instead of competing per-row regions. */}
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="min-h-6 text-sm text-muted-foreground"
      >
        {status}
      </p>

      {page.items.length === 0 ? (
        <section className="rounded-xl border border-dashed p-6 text-center">
          <h3 className="font-semibold">No tasks yet</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {canEdit
              ? "Add the first task above. The note’s own content is unaffected."
              : "This task list is empty."}
          </p>
        </section>
      ) : (
        <>
          {canEdit ? (
            <div className="space-y-2">
              <p className="text-sm">
                {selectedCount} of {page.items.length} tasks selected
              </p>
              <div
                role="toolbar"
                aria-label="Bulk task actions"
                className="flex flex-wrap items-end gap-2 rounded-md border bg-muted/30 p-2"
              >
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    className="size-4"
                    aria-label="Select all tasks"
                    checked={selectedCount > 0 && selectedCount === page.items.length}
                    disabled={operationPending}
                    onChange={(event) =>
                      setSelectedIds(
                        event.target.checked
                          ? new Set(page.items.map((item) => item.id))
                          : new Set(),
                      )
                    }
                  />
                  Select all
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={operationPending || selectedCount === 0}
                  onClick={() => void bulk({ kind: "status", status: "done" }, "Mark complete")}
                >
                  Mark complete
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={operationPending || selectedCount === 0}
                  onClick={() => void bulk({ kind: "status", status: "todo" }, "Mark to do")}
                >
                  Mark to do
                </Button>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="bulk-priority">
                    Priority for selected tasks
                  </label>
                  <select
                    id="bulk-priority"
                    className="min-h-11 rounded-md border bg-background px-3 text-sm"
                    value={bulkPriority}
                    disabled={operationPending}
                    onChange={(event) => setBulkPriority(event.target.value as TaskPriority)}
                  >
                    {BULK_PRIORITIES.map((entry) => (
                      <option key={entry.value} value={entry.value}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={operationPending || selectedCount === 0}
                  onClick={() =>
                    void bulk({ kind: "priority", priority: bulkPriority }, "Set priority")
                  }
                >
                  Apply priority
                </Button>
                <Dialog
                  open={deleteOpen}
                  onOpenChange={(open) => !operationPending && setDeleteOpen(open)}
                >
                  <DialogTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={operationPending || selectedCount === 0}
                    >
                      Delete selected
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>
                        Delete {selectedCount} selected {selectedCount === 1 ? "task" : "tasks"}?
                      </DialogTitle>
                      <DialogDescription>
                        {cascadedCount === 0
                          ? "This cannot be undone. Deleted tasks are removed outright; there is no task trash to restore from."
                          : `This also deletes at least ${cascadedCount} subtask${
                              cascadedCount === 1 ? "" : "s"
                            } beneath the selection, for at least ${
                              selectedCount + cascadedCount
                            } tasks in total. It cannot be undone, and there is no task trash to restore from.`}
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <DialogClose asChild>
                        <Button variant="outline" disabled={operationPending}>
                          Cancel
                        </Button>
                      </DialogClose>
                      <Button
                        variant="destructive"
                        disabled={operationPending}
                        onClick={() => {
                          setDeleteOpen(false);
                          void bulk({ kind: "delete" }, "Delete selected");
                        }}
                      >
                        Delete
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </div>
          ) : null}
          <TaskSortableList
            groups={groups}
            dragDisabled={dragDisabled}
            dragDisabledReason={dragDisabledReason}
            idPrefix="tasks"
            onReorder={(task, beforeTaskId, position) => void reorder(task, beforeTaskId, position)}
            renderTask={(task, movement) => (
              <TaskRow
                task={task}
                members={members}
                tags={tags}
                now={now}
                pending={pendingIds.has(task.id)}
                // Every mutation returns early while another is in flight, so
                // leaving other rows enabled would let a click flip a control
                // and snap back with nothing requested and nothing announced.
                disabled={!canEdit || operationPending}
                selected={selectedIds.has(task.id)}
                onSelectedChange={(next) =>
                  setSelectedIds((current) => {
                    const updated = new Set(current);
                    if (next) updated.add(task.id);
                    else updated.delete(task.id);
                    return updated;
                  })
                }
                onUpdate={(target, input) => void update(target, input)}
                onDelete={(target) => void remove(target)}
                movement={movement}
              />
            )}
          />
        </>
      )}
    </div>
  );
}
