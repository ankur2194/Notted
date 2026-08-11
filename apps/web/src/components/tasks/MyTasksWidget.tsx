"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import type { ApiRequestFailureKind } from "@/lib/api/request-json";
import type { TaskListQuery, TaskSummary } from "@notted/shared-types";

import { Button } from "@/components/ui/button";
import { noteDetailPath } from "@/lib/notes/paths";
import { taskQueryKeys } from "@/lib/notes/query-keys";
import { dueLabel, isOverdue, viewerTimeZone } from "@/lib/tasks/grouping";
import { requestTaskPage, updateTask } from "@/lib/tasks/requests";

/** How often the overdue boundary is re-evaluated against the browser clock. */
const CLOCK_INTERVAL_MS = 60_000;

/**
 * Twenty open assignments, soonest due first.
 *
 * This is a dashboard summary, not the task views: there is deliberately no
 * paging control. A viewer with more than twenty open tasks is sent to the
 * workspace task views rather than given a second pager here.
 *
 * ponytail: hard cap, not a page-1 pager. Add paging here only if the dashboard
 * is ever meant to replace the task views rather than point at them.
 */
const LIMIT = 20;

function loadFailure(kind: string): string {
  if (kind === "forbidden-or-not-found") {
    return "You do not have permission to read tasks in this workspace, or it is no longer available. No task data was rendered.";
  }
  if (kind === "invalid") {
    return "The task list could not be read safely, so nothing was rendered.";
  }
  return "Your tasks could not be reached. You may be offline. Nothing was changed.";
}

function completionFailure(kind: ApiRequestFailureKind, title: string): string {
  if (kind === "forbidden-or-not-found") {
    return `Completing “${title}” was denied or the task is no longer available. Nothing was changed.`;
  }
  if (kind === "version-conflict" || kind === "conflict") {
    return `Completing “${title}” conflicted with a recent change by someone else. Nothing was changed; reload and retry.`;
  }
  if (kind === "invalid") return `Completing “${title}” was not accepted. Nothing was changed.`;
  return `Completing “${title}” could not reach Notted. You may be offline; nothing was changed.`;
}

/**
 * The viewer's own open tasks, on the dashboard home.
 *
 * `workspaceId` and `assigneeId` are nullable because the dashboard renders
 * before a workspace is necessarily selected: with no workspace there is no
 * tenant to scope a task query to, so the widget renders nothing at all rather
 * than an empty state that would imply the viewer has no work.
 */
export function MyTasksWidget({
  workspaceId,
  assigneeId,
  canEdit,
}: {
  readonly workspaceId: string | null;
  readonly assigneeId: string | null;
  readonly canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("");
  /*
   * One completion at a time: the in-flight row is the only checked box and
   * every other box is disabled while it runs.
   *
   * ponytail: serialized rather than a pending set, because the widget writes
   * nothing optimistically and a second concurrent completion would race the
   * same invalidation. Move to a set if bulk completion is ever added here.
   */
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  // Overdue is a comparison against the browser clock (Part 47: there is no
  // server `isOverdue`), so a dashboard left open has to re-evaluate it.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const enabled = workspaceId !== null && assigneeId !== null;
  // The placeholders below never reach the network: the query is disabled
  // without both ids, and the component returns before rendering anything.
  const query = useMemo<TaskListQuery>(
    () => ({
      page: 1,
      limit: LIMIT,
      assigneeId: assigneeId ?? undefined,
      isCompleted: false,
      grouping: "none",
      sortBy: "dueDate",
      sortDirection: "asc",
    }),
    [assigneeId],
  );

  const tasksQuery = useQuery({
    queryKey: taskQueryKeys.list(workspaceId ?? "", query),
    enabled,
    retry: false,
    queryFn: async () => {
      const result = await requestTaskPage(workspaceId ?? "", query);
      if (!result.ok) throw new Error(result.kind);
      return result.data;
    },
  });

  if (workspaceId === null || assigneeId === null) return null;
  // A `const` so the narrowing above survives into the callbacks below; a
  // narrowed parameter does not.
  const activeWorkspaceId = workspaceId;

  async function complete(task: TaskSummary): Promise<void> {
    setPendingId(task.id);
    setStatus(`Completing “${task.title}”…`);
    const result = await updateTask(activeWorkspaceId, task.id, { status: "done" });
    setPendingId(null);
    if (!result.ok) {
      setStatus(completionFailure(result.kind, task.title));
      return;
    }
    setStatus(`“${task.title}” is complete.`);
    /*
     * One invalidation of the whole task root is the entire cross-view
     * consistency contract for this widget: the list, board and calendar views
     * all hang off `taskQueryKeys.all(workspaceId)`, so refetching that prefix
     * is what keeps them from disagreeing with this checkbox. Nothing here
     * edits another view's cache entry by hand — bespoke cache surgery is how
     * two surfaces end up telling the user different things.
     */
    await queryClient.invalidateQueries({ queryKey: taskQueryKeys.all(activeWorkspaceId) });
  }

  const heading = (
    <h2 id="my-tasks-heading" className="text-xl font-semibold">
      My tasks
    </h2>
  );

  if (tasksQuery.isPending) {
    return (
      <section aria-labelledby="my-tasks-heading" className="rounded-xl border bg-card p-5">
        {heading}
        <p className="mt-2 text-sm text-muted-foreground">Loading your tasks…</p>
      </section>
    );
  }

  if (tasksQuery.isError) {
    const kind = tasksQuery.error instanceof Error ? tasksQuery.error.message : "unavailable";
    return (
      <section aria-labelledby="my-tasks-heading" className="rounded-xl border bg-card p-5">
        {heading}
        <p className="mt-2 text-sm text-muted-foreground" role="alert">
          {loadFailure(kind)}
        </p>
        {kind === "forbidden-or-not-found" ? null : (
          <Button className="mt-4" type="button" onClick={() => void tasksQuery.refetch()}>
            Retry
          </Button>
        )}
      </section>
    );
  }

  const tasks = tasksQuery.data.items;

  return (
    <section aria-labelledby="my-tasks-heading" className="rounded-xl border bg-card p-5">
      {heading}
      <p className="mt-1 text-sm text-muted-foreground">
        Open tasks assigned to you, soonest due first. Due times are shown in {viewerTimeZone()}.
      </p>

      {canEdit ? null : (
        <p className="mt-3 rounded-md border bg-muted/30 p-3 text-sm" role="note">
          Your current role can read these tasks but cannot change them. Backend authorization
          remains authoritative.
        </p>
      )}

      {/* One live region for the widget: every completion, failure and refusal
          is announced here, so a screen reader hears a single narrative rather
          than competing per-row regions. */}
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="mt-3 min-h-6 text-sm text-muted-foreground"
      >
        {status}
      </p>

      {tasks.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Nothing is assigned to you right now.
        </p>
      ) : (
        <ul className="space-y-2" aria-label="My open tasks">
          {tasks.map((task) => {
            const overdue = isOverdue(task, now);
            const due = dueLabel(task, now);
            return (
              <li
                key={task.id}
                /*
                 * The border is the quiet half of the signal. The word
                 * "Overdue" below is the load-bearing half: colour alone
                 * conveys nothing to a screen reader and nothing at all to a
                 * viewer who cannot distinguish the hues (WCAG 1.4.1).
                 */
                className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-3 ${
                  overdue ? "border-destructive" : ""
                }`}
              >
                {canEdit ? (
                  <label
                    className="flex min-h-11 items-center gap-2"
                    htmlFor={`my-task-${task.id}`}
                  >
                    <input
                      id={`my-task-${task.id}`}
                      type="checkbox"
                      className="size-4"
                      checked={pendingId === task.id}
                      disabled={pendingId !== null}
                      onChange={() => void complete(task)}
                    />
                    <span className="sr-only">Complete {task.title}</span>
                  </label>
                ) : null}
                <span className="min-w-0 flex-1 break-words text-sm font-medium">
                  {task.noteId === null ? (
                    task.title
                  ) : (
                    <Link
                      className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      /*
                       * A task's `projectId` is the note's own: the server
                       * requires `note.projectId === task.projectId`, so this
                       * is the note's real container, not a guess.
                       */
                      href={noteDetailPath(activeWorkspaceId, {
                        id: task.noteId,
                        projectId: task.projectId,
                      })}
                    >
                      {task.title}
                    </Link>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {due === null ? "No due date" : `Due ${due}`}
                </span>
                {overdue ? (
                  <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                    Overdue
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
