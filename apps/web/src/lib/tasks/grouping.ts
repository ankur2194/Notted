import type { TaskGrouping, TaskSummary } from "@notted/shared-types";

/**
 * Pure task presentation logic: grouping, the overdue test, and the
 * date↔instant conversion the row inputs need.
 *
 * No date library and no `Intl` fallback shim: `Intl.DateTimeFormat` and
 * `Intl.RelativeTimeFormat` are baseline in every browser the app supports, and
 * the arithmetic here is calendar-day differences, which `Date` already does.
 *
 * Everything takes `now` as an argument rather than reading the clock, so the
 * boundary cases are testable and a re-render cannot silently reclassify a row.
 */

export interface TaskGroup {
  readonly key: string;
  readonly label: string;
  readonly tasks: readonly TaskSummary[];
}

/**
 * A task is overdue when its due instant has passed and it is still open.
 *
 * `completedAt` and a `canceled` status both close a task, and a closed task is
 * never overdue no matter how far past its due date it sits. The comparison is
 * strict: a task due at exactly `now` has not yet passed.
 */
export function isOverdue(task: TaskSummary, now: Date): boolean {
  if (task.dueDate === null || task.completedAt !== null || task.status === "canceled") {
    return false;
  }
  const due = Date.parse(task.dueDate);
  return Number.isFinite(due) && due < now.getTime();
}

/** Local calendar day of an instant, as a sortable `YYYY-MM-DD` key. */
function localDayKey(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Whole local calendar days from `now`'s day to `at`'s day. */
function dayDifference(at: Date, now: Date): number {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const to = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  return Math.round((to - from) / 86_400_000);
}

const STATUS_GROUPS = [
  { key: "todo", label: "To do" },
  { key: "in_progress", label: "In progress" },
  { key: "done", label: "Done" },
  { key: "canceled", label: "Canceled" },
] as const;

const PRIORITY_GROUPS = [
  { key: "urgent", label: "Urgent" },
  { key: "high", label: "High" },
  { key: "medium", label: "Medium" },
  { key: "low", label: "Low" },
] as const;

const DUE_GROUPS = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Today" },
  { key: "upcoming", label: "Upcoming" },
  { key: "earlier", label: "Earlier" },
  { key: "none", label: "No due date" },
] as const;

/**
 * Which due-date bucket a task belongs to.
 *
 * `earlier` exists because a past due date is not automatically overdue: a task
 * completed last week is neither overdue nor upcoming, and folding it into
 * either bucket would misreport it.
 */
function dueBucket(task: TaskSummary, now: Date): string {
  if (task.dueDate === null) return "none";
  const at = new Date(task.dueDate);
  if (Number.isNaN(at.getTime())) return "none";
  if (isOverdue(task, now)) return "overdue";
  if (localDayKey(at) === localDayKey(now)) return "today";
  return dayDifference(at, now) > 0 ? "upcoming" : "earlier";
}

/**
 * Partitions tasks into ordered, non-empty groups.
 *
 * `none` still returns one group so every caller renders the same heading and
 * list markup instead of branching. Assignee groups carry the raw user id as
 * both key and label — this module knows nothing about the member directory, so
 * the view substitutes a display name using `key`.
 */
export function groupTasks(
  tasks: readonly TaskSummary[],
  grouping: TaskGrouping,
  now: Date = new Date(),
): readonly TaskGroup[] {
  if (grouping === "none") {
    return [{ key: "all", label: "All tasks", tasks }];
  }
  if (grouping === "assignee") {
    const keys: string[] = [];
    for (const task of tasks) {
      const key = task.assigneeId ?? "unassigned";
      if (!keys.includes(key)) keys.push(key);
    }
    // Unassigned first when present: it is the bucket that needs action.
    keys.sort((left, right) =>
      left === "unassigned" ? -1 : right === "unassigned" ? 1 : left.localeCompare(right),
    );
    return keys.map((key) => ({
      key,
      label: key === "unassigned" ? "Unassigned" : key,
      tasks: tasks.filter((task) => (task.assigneeId ?? "unassigned") === key),
    }));
  }
  const definitions: readonly { readonly key: string; readonly label: string }[] =
    grouping === "status" ? STATUS_GROUPS : grouping === "priority" ? PRIORITY_GROUPS : DUE_GROUPS;
  const bucketOf = (task: TaskSummary): string =>
    grouping === "status"
      ? task.status
      : grouping === "priority"
        ? task.priority
        : dueBucket(task, now);
  return definitions
    .map((definition) => ({
      key: definition.key,
      label: definition.label,
      tasks: tasks.filter((task) => bucketOf(task) === definition.key),
    }))
    .filter((group) => group.tasks.length > 0);
}

/**
 * The due date rendered in the viewer's own time zone.
 *
 * Nearby days read relatively ("today", "in 3 days") because that is what a
 * task list is scanned for; anything further out gets an absolute date, since
 * "in 94 days" answers nothing. A time component is appended only when the
 * stored instant is not local midnight — a date-only due task must not sprout a
 * "00:00" the user never typed.
 */
export function dueLabel(task: TaskSummary, now: Date, locale?: string): string | null {
  if (task.dueDate === null) return null;
  const at = new Date(task.dueDate);
  if (Number.isNaN(at.getTime())) return null;
  const days = dayDifference(at, now);
  const day =
    Math.abs(days) <= 6
      ? new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day")
      : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(at);
  if (at.getHours() === 0 && at.getMinutes() === 0) return day;
  return `${day}, ${new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(at)}`;
}

/**
 * Splits a stored UTC instant into the local `YYYY-MM-DD` and `HH:MM` values
 * the native `<input type="date">` and `<input type="time">` controls expect.
 * Local midnight round-trips to an empty time, which is how "no time was set"
 * survives an edit.
 */
export function splitDueDate(dueDate: string | null): { date: string; time: string } {
  if (dueDate === null) return { date: "", time: "" };
  const at = new Date(dueDate);
  if (Number.isNaN(at.getTime())) return { date: "", time: "" };
  const pad = (value: number): string => String(value).padStart(2, "0");
  return {
    date: localDayKey(at),
    time:
      at.getHours() === 0 && at.getMinutes() === 0
        ? ""
        : `${pad(at.getHours())}:${pad(at.getMinutes())}`,
  };
}

/**
 * Composes the local date and optional local time back into the single UTC
 * instant the contract stores.
 *
 * An empty time resolves to 00:00 **local**, never 00:00 UTC: "due today" has
 * to mean the day the user is looking at, so the conversion happens here in the
 * viewer's zone rather than by string-concatenating a `Z`.
 */
export function composeDueDate(date: string, time: string): string | null {
  if (date === "") return null;
  // The defaults stand in for a missing segment only; a non-numeric segment
  // still becomes NaN and is rejected by the finiteness check below.
  const [year = Number.NaN, month = Number.NaN, day = Number.NaN] = date.split("-").map(Number);
  const [hours = 0, minutes = 0] = time === "" ? [] : time.split(":").map(Number);
  if (![year, month, day, hours, minutes].every((part) => Number.isFinite(part))) return null;
  const at = new Date(year, month - 1, day, hours, minutes, 0, 0);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** The zone every due date on this page is composed and rendered in. */
export function viewerTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}
