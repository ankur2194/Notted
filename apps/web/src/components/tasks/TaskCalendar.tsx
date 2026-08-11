"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";

import type { TaskListQuery, TaskSummary } from "@notted/shared-types";

import { Button } from "@/components/ui/button";
import { taskQueryKeys } from "@/lib/notes/query-keys";
import {
  bucketByDay,
  composeDueDate,
  dueLabel,
  isOverdue,
  localDayKey,
  monthGrid,
} from "@/lib/tasks/grouping";
import { requestTaskPage } from "@/lib/tasks/requests";

const WEEKDAYS: readonly string[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
    new Date(year, month, 1),
  );
}

/** The day number a `YYYY-MM-DD` key ends in, without re-parsing it as a date. */
function dayNumber(key: string): string {
  return String(Number(key.slice(8)));
}

/**
 * Local midnight of the day *after* a day key, as the upper bound of the window.
 *
 * The last visible day has to be whole: a bound of 23:59 would leave the final
 * minute of it outside the query and silently drop a task due in it. Built with
 * the `Date` constructor, so the day after a daylight-saving change is still the
 * next calendar day.
 */
function endOfWindow(key: string): string | undefined {
  const [year, month, day] = key.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return undefined;
  if (![year, month, day].every((part) => Number.isFinite(part))) return undefined;
  return new Date(year, month - 1, day + 1).toISOString();
}

/**
 * The month grid of due dates.
 *
 * Read-focused by design: editing a task stays in the list and board views,
 * which already own every control and every rollback path. The calendar shows
 * the same rows the shared page holds, so no mutation can make it disagree with
 * them.
 */
export function TaskCalendar({
  workspaceId,
  noteId,
  tasks,
  hasMore,
  now,
  onNotice,
}: {
  readonly workspaceId: string;
  readonly noteId: string | null;
  readonly tasks: readonly TaskSummary[];
  /** True when the shared page is truncated and cannot answer for a whole month. */
  readonly hasMore: boolean;
  readonly now: Date;
  /** Writes to the container's single live region. */
  readonly onNotice: (message: string) => void;
}) {
  const [month, setMonth] = useState(() => ({ year: now.getFullYear(), month: now.getMonth() }));
  const grid = monthGrid(month.year, month.month);

  /*
   * The only branch that costs a request. While the shared page is complete it
   * already contains every task, so month navigation is pure arithmetic; once it
   * reports `hasMore` the visible month is fetched under its own cache key.
   *
   * Both bounds are composed locally, matching the Part 47 timezone contract:
   * the first instant of the first visible day through the last minute of the
   * last one, in the viewer's zone.
   */
  const windowQuery: TaskListQuery = {
    page: 1,
    limit: 100,
    ...(noteId === null ? {} : { noteId }),
    grouping: "none",
    sortBy: "dueDate",
    sortDirection: "asc",
    dueFrom: composeDueDate(grid[0] ?? "", "") ?? undefined,
    dueTo: endOfWindow(grid[41] ?? ""),
  };

  const monthTasks = useQuery({
    queryKey: taskQueryKeys.list(workspaceId, windowQuery),
    enabled: hasMore,
    queryFn: async () => {
      const result = await requestTaskPage(workspaceId, windowQuery);
      if (!result.ok) throw new Error(result.kind);
      return result.data.items;
    },
    retry: false,
  });

  const dated = hasMore ? (monthTasks.data ?? tasks) : tasks;
  const byDay = bucketByDay(dated);
  // Undated tasks always come from the shared page: the windowed query filters
  // by due date and can never return them.
  const undated = tasks.filter((task) => task.dueDate === null);
  const todayKey = localDayKey(now);
  const monthPrefix = `${month.year}-${String(month.month + 1).padStart(2, "0")}`;

  function shift(delta: number): void {
    // `new Date(year, month + delta, 1)` normalizes December→January itself.
    const at = new Date(month.year, month.month + delta, 1);
    setMonth({ year: at.getFullYear(), month: at.getMonth() });
    onNotice(`Showing ${monthLabel(at.getFullYear(), at.getMonth())}.`);
  }

  return (
    <section className="space-y-3" aria-labelledby="task-calendar-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="task-calendar-heading" className="text-sm font-semibold">
          {monthLabel(month.year, month.month)}
        </h3>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11"
            onClick={() => shift(-1)}
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
            Previous month
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11"
            onClick={() => shift(1)}
          >
            <ChevronRight aria-hidden="true" className="size-4" />
            Next month
          </Button>
        </div>
      </div>

      {!hasMore ? null : monthTasks.isError ? (
        <div className="space-y-3 rounded-md border p-3" role="alert">
          <p className="text-sm">
            The tasks due in this month could not be loaded, so the grid shows only the tasks
            already on this page. No task was changed.
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => void monthTasks.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : (
        <p className="rounded-md bg-muted p-3 text-sm" role="note">
          More tasks exist than one page holds, so this month is loaded on its own each time you
          navigate. {monthTasks.isFetching ? "Loading this month…" : null}
        </p>
      )}

      <div className="grid grid-cols-7 gap-1">
        {WEEKDAYS.map((weekday) => (
          <p key={weekday} className="p-1 text-xs font-medium text-muted-foreground">
            <abbr title={weekday}>{weekday.slice(0, 3)}</abbr>
          </p>
        ))}
      </div>
      <ul aria-labelledby="task-calendar-heading" className="grid grid-cols-7 gap-1">
        {grid.map((key) => {
          const dayTasks = byDay.get(key) ?? [];
          const outside = !key.startsWith(monthPrefix);
          return (
            <li
              key={key}
              className={`min-h-24 rounded-md border p-1 text-xs ${
                outside ? "bg-muted/30 text-muted-foreground" : ""
              }`}
            >
              {/*
               * Every state a colour hints at is also written out: the day, its
               * month when it falls outside the current one, "Today", and
               * "Overdue" per task (WCAG 1.4.1).
               */}
              <p className="font-medium">
                {dayNumber(key)}
                {outside ? <span className="sr-only"> (outside {monthPrefix})</span> : null}
                {key === todayKey ? <span className="ml-1 font-normal">(Today)</span> : null}
              </p>
              {dayTasks.length === 0 ? (
                <p className="sr-only">No tasks due.</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {dayTasks.map((task) => (
                    <li key={task.id} className="rounded bg-card p-1">
                      <span className="block truncate font-medium" title={task.title}>
                        {task.title}
                      </span>
                      <span className="block text-muted-foreground">
                        {dueLabel(task, now) ?? "No due date"}
                      </span>
                      {isOverdue(task, now) ? (
                        <span className="font-medium text-destructive">Overdue</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      <section aria-labelledby="task-calendar-undated">
        <h3 id="task-calendar-undated" className="text-sm font-semibold">
          No due date ({undated.length})
        </h3>
        {undated.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Every task on this page has a due date.
          </p>
        ) : (
          <ul aria-labelledby="task-calendar-undated" className="mt-2 grid gap-2">
            {undated.map((task) => (
              <li key={task.id} className="rounded-md border p-2 text-sm">
                {task.title}
              </li>
            ))}
          </ul>
        )}
        {hasMore ? (
          <p className="mt-2 rounded-md bg-muted p-3 text-sm" role="note">
            Undated tasks come from the first page only, so this list may be incomplete while the
            task set is truncated.
          </p>
        ) : null}
      </section>
    </section>
  );
}
