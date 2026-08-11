"use client";

/**
 * The project timeline — a **chronological timeline, not a Gantt chart**.
 *
 * A Gantt bar means "this work is planned from X to Y". Notted has no start
 * date on a project, a note or a task, and Part 49 deliberately did not add
 * one: this view is descriptive, not plannable. Every bar is therefore derived
 * from dates the records already carry and means only "this record's life ran
 * between these two instants":
 *
 * | Record  | Bar runs from | to |
 * |---|---|---|
 * | project | `createdAt` | `dueAt`, or the last end among its children |
 * | note    | `createdAt` | `updatedAt` |
 * | task    | `createdAt` | `completedAt ?? dueDate` |
 *
 * No end is ever invented — a record with no distinct end is a marker, not a
 * bar stretched to today — and no record is ever dropped: one with no usable
 * date at all is named in the "Not scheduled" list below the chart.
 *
 * Read-only by design. It performs no mutation and adds no live region;
 * `NoteBrowser` owns the single live region for this surface.
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { TimelineItem, TimelineKind, TimelineSpan } from "@/lib/notes/timeline";
import type { NoteSummary, TaskListQuery } from "@notted/shared-types";

import { Button } from "@/components/ui/button";
import { taskQueryKeys } from "@/lib/notes/query-keys";
import { layoutTimeline, spanBounds } from "@/lib/notes/timeline";
import { requestTaskPage } from "@/lib/tasks/requests";

/**
 * ponytail: one 100-row window per axis — no accumulation, no virtualization.
 *
 * Notes come from the browser's already-cached page and tasks from a single
 * page of this size, so the DOM stays bounded near 200 rows however large the
 * project grows. Off-screen rows are skipped by native `content-visibility`
 * rather than by a windowing library; there is no virtualization dependency in
 * this repo and this ceiling does not justify adding one. Above roughly 1000
 * records, accumulate the pages onto one axis or virtualize then.
 */
const TASK_PAGE_SIZE = 100;

/** Matches `NoteCard.updatedLabel`: fixed locale and zone, so output is stable. */
const DATE_FORMAT = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

function dateText(ms: number): string {
  return DATE_FORMAT.format(new Date(ms));
}

const KIND_WORD: Readonly<Record<TimelineKind, string>> = {
  project: "Project",
  note: "Note",
  task: "Task",
};

/**
 * The row's whole meaning, in words.
 *
 * The bar beside it is decoration: its position and length carry nothing a
 * reader cannot get from this string. That is what lets the view degrade to a
 * plain ordered list with CSS off, and keeps it clear of "colour alone".
 */
function spanText(span: TimelineSpan): string {
  const head = `${KIND_WORD[span.kind]}: ${span.label} — ${dateText(span.startMs)}`;
  return span.marker ? head : `${head} to ${dateText(span.endMs)}`;
}

/** Always ends by saying the view is intact, because it is: notes still render. */
function taskFailure(kind: string): string {
  const tail = "The timeline still shows the project and its notes, and no record was dropped.";
  if (kind === "forbidden-or-not-found") {
    return `Tasks for this project could not be read, or they are no longer available. ${tail}`;
  }
  if (kind === "invalid") return `The task list could not be read safely. ${tail}`;
  return `Tasks could not be reached. You may be offline. ${tail}`;
}

export function NoteTimeline({
  workspaceId,
  projectId,
  projectName,
  projectCreatedAt,
  projectDueAt,
  notes,
  notesHasMore,
}: {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectCreatedAt: string;
  /** The project's `dueAt` wire field; null means "derive the end from children". */
  readonly projectDueAt: string | null;
  /** The container's already-cached note page — this view fetches no notes. */
  readonly notes: readonly NoteSummary[];
  readonly notesHasMore: boolean;
}) {
  const [page, setPage] = useState(1);

  const taskQuery: TaskListQuery = {
    page,
    limit: TASK_PAGE_SIZE,
    projectId,
    grouping: "none",
    sortBy: "createdAt",
    sortDirection: "asc",
  };

  /*
   * The same `taskQueryKeys.list` factory the board and calendar use, so a
   * project board mounted beside this timeline reads one shared cache entry
   * rather than two that can disagree after a mutation.
   *
   * No `enabled` gate: `NoteBrowser` renders this component only while the
   * timeline view is showing, so mounting is the gate.
   */
  const tasks = useQuery({
    queryKey: taskQueryKeys.list(workspaceId, taskQuery),
    retry: false,
    queryFn: async () => {
      const result = await requestTaskPage(workspaceId, taskQuery);
      if (!result.ok) throw new Error(result.kind);
      return result.data;
    },
  });

  const taskRows = tasks.data?.items ?? [];
  const children: readonly TimelineItem[] = [
    ...notes.map<TimelineItem>((note) => ({
      id: note.id,
      kind: "note",
      label: note.title,
      start: note.createdAt,
      end: note.updatedAt,
    })),
    ...taskRows.map<TimelineItem>((task) => ({
      id: task.id,
      kind: "task",
      label: task.title,
      // A completed task ended when it was completed; an open one is drawn to
      // the date it is owed by. Neither is a guess about when it started.
      start: task.createdAt,
      end: task.completedAt ?? task.dueDate,
    })),
  ];

  /*
   * A project with no `dueAt` borrows the last end among its children, so the
   * frame always encloses what it frames. With no dated child there is nothing
   * to borrow and the project becomes a marker at its creation instant.
   */
  const childLayout = layoutTimeline(children);
  const projectEnd =
    projectDueAt ??
    (childLayout.spans.length === 0 ? null : new Date(childLayout.maxMs).toISOString());

  const layout = layoutTimeline([
    {
      id: projectId,
      kind: "project",
      label: projectName,
      start: projectCreatedAt,
      end: projectEnd,
    },
    ...children,
  ]);
  const projectSpan = layout.spans.find((span) => span.kind === "project");

  // Lane order, then chronological within a lane (the sort is stable): records
  // that can never overlap read as one continuous track down the page.
  const rows = layout.spans.filter((span) => span.kind !== "project");
  rows.sort((a, b) => a.lane - b.lane);

  const firstRow = (page - 1) * TASK_PAGE_SIZE + 1;
  const lastRow = (page - 1) * TASK_PAGE_SIZE + taskRows.length;
  const hasMoreTasks = tasks.data?.hasMore ?? false;
  const taskErrorKind = tasks.error instanceof Error ? tasks.error.message : "network";

  return (
    <section className="space-y-3" aria-labelledby="note-timeline-heading">
      <h3 id="note-timeline-heading" className="text-sm font-semibold">
        Project timeline — {projectName}
      </h3>
      <p className="text-xs text-muted-foreground">
        A chronological view of dates the records already carry, in UTC. It is not a plan: nothing
        here has a start date to move.
      </p>

      {notesHasMore ? (
        <p className="rounded-md bg-muted p-3 text-sm" role="note">
          Showing the first {notes.length} notes. The note list is paginated above, so this timeline
          covers only the notes currently loaded there.
        </p>
      ) : null}

      {tasks.isError ? (
        <div className="space-y-3 rounded-md border p-3">
          <p className="text-sm" role="note">
            {taskFailure(taskErrorKind)}
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => void tasks.refetch()}
          >
            Retry loading tasks
          </Button>
        </div>
      ) : null}

      {tasks.isLoading ? <p className="text-sm text-muted-foreground">Loading tasks…</p> : null}

      {/*
       * The project is the frame, not one more indistinguishable bar: its own
       * dates are stated in words on the border that encloses every child row.
       */}
      <div className="rounded-md border p-3">
        <p className="text-sm font-medium">
          {projectSpan === undefined
            ? `Project: ${projectName} — no usable date`
            : spanText(projectSpan)}
        </p>

        {children.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Nothing on this timeline yet.</p>
        ) : (
          <ol className="mt-3 space-y-1" aria-labelledby="note-timeline-heading">
            {rows.map((span) => {
              const bounds = spanBounds(span, layout);
              const barTone = span.kind === "task" ? "bg-info" : "bg-primary";
              return (
                <li
                  key={span.id}
                  className="rounded-md border px-2 py-1 text-xs [contain-intrinsic-size:auto_2.5rem] [content-visibility:auto]"
                >
                  <span className="block break-words">{spanText(span)}</span>
                  {/* Decoration: every value it encodes is in the line above. */}
                  <span
                    aria-hidden="true"
                    className="relative mt-1 block h-2 overflow-hidden rounded-full bg-muted"
                  >
                    <span
                      className={`absolute inset-y-0 min-w-[0.25rem] rounded-full ${barTone}`}
                      style={{ left: `${bounds.left}%`, width: `${bounds.width}%` }}
                    />
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {taskRows.length === 0
            ? "No tasks on this page."
            : `Showing tasks ${firstRow}–${lastRow}${hasMoreTasks ? " of more" : ""}.`}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={page === 1 || tasks.isFetching}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Load previous page
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={!hasMoreTasks || tasks.isFetching}
            onClick={() => setPage((current) => current + 1)}
          >
            Load next page
          </Button>
        </div>
      </div>

      <section aria-labelledby="note-timeline-unscheduled">
        <h4 id="note-timeline-unscheduled" className="text-sm font-semibold">
          Not scheduled ({layout.unscheduled.length})
        </h4>
        {layout.unscheduled.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Every record shown has at least one usable date.
          </p>
        ) : (
          <ul aria-labelledby="note-timeline-unscheduled" className="mt-2 grid gap-2">
            {layout.unscheduled.map((entry) => (
              <li key={entry.id} className="rounded-md border p-2 text-sm">
                {KIND_WORD[entry.kind]}: {entry.label}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
