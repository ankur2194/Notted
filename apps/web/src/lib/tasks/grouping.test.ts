import { describe, expect, it } from "vitest";

import { composeDueDate, dueLabel, groupTasks, isOverdue, splitDueDate } from "./grouping";

import type { TaskSummary } from "@notted/shared-types";

const workspaceId = "40000000-0000-4000-8000-000000000001";

function task(id: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id,
    workspaceId,
    projectId: null,
    noteId: null,
    parentId: null,
    title: `Task ${id.slice(-1)}`,
    status: "todo",
    customStatusId: null,
    statusLabel: null,
    priority: "medium",
    assigneeId: null,
    dueDate: null,
    completedAt: null,
    sortOrder: 1,
    recurrence: "none",
    recurrenceCron: null,
    tagIds: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A local wall-clock instant, so no assertion depends on the runner's zone. */
function local(year: number, month: number, day: number, hours = 0, minutes = 0): string {
  return new Date(year, month - 1, day, hours, minutes, 0, 0).toISOString();
}

const now = new Date(2026, 7, 9, 12, 0, 0, 0);

describe("isOverdue", () => {
  it("is false at exactly now and true one millisecond later", () => {
    const atNow = task("a", { dueDate: new Date(now.getTime()).toISOString() });
    const justPast = task("b", { dueDate: new Date(now.getTime() - 1).toISOString() });
    expect(isOverdue(atNow, now)).toBe(false);
    expect(isOverdue(justPast, now)).toBe(true);
  });

  it("never reports a closed task as overdue", () => {
    const past = local(2026, 8, 1);
    expect(isOverdue(task("c", { dueDate: past }), now)).toBe(true);
    expect(
      isOverdue(task("d", { dueDate: past, completedAt: local(2026, 8, 2), status: "done" }), now),
    ).toBe(false);
    expect(isOverdue(task("e", { dueDate: past, status: "canceled" }), now)).toBe(false);
  });

  it("is false without a due date", () => {
    expect(isOverdue(task("f"), now)).toBe(false);
  });
});

describe("groupTasks", () => {
  it("returns one group for `none` without dropping anything", () => {
    const items = [task("a"), task("b")];
    expect(groupTasks(items, "none", now)).toEqual([
      { key: "all", label: "All tasks", tasks: items },
    ]);
  });

  it("partitions by status in lifecycle order and omits empty groups", () => {
    const todo = task("a");
    const done = task("b", { status: "done", completedAt: local(2026, 8, 8) });
    const groups = groupTasks([todo, done], "status", now);
    expect(groups.map((group) => group.label)).toEqual(["To do", "Done"]);
    expect(groups[0]?.tasks).toEqual([todo]);
    expect(groups[1]?.tasks).toEqual([done]);
  });

  it("partitions by priority from urgent down", () => {
    const low = task("a", { priority: "low" });
    const urgent = task("b", { priority: "urgent" });
    expect(groupTasks([low, urgent], "priority", now).map((group) => group.label)).toEqual([
      "Urgent",
      "Low",
    ]);
  });

  it("puts unassigned first and keys assignee groups by user id", () => {
    const assigneeId = "40000000-0000-4000-8000-0000000000aa";
    const mine = task("a", { assigneeId });
    const nobody = task("b");
    const groups = groupTasks([mine, nobody], "assignee", now);
    expect(groups.map((group) => group.key)).toEqual(["unassigned", assigneeId]);
    expect(groups[0]?.label).toBe("Unassigned");
    expect(groups[0]?.tasks).toEqual([nobody]);
  });

  it("separates overdue, today, upcoming, earlier and undated tasks", () => {
    const overdue = task("a", { dueDate: local(2026, 8, 1) });
    const today = task("b", { dueDate: local(2026, 8, 9, 18) });
    const upcoming = task("c", { dueDate: local(2026, 8, 20) });
    const earlier = task("d", {
      dueDate: local(2026, 8, 1),
      status: "done",
      completedAt: local(2026, 8, 2),
    });
    const undated = task("e");
    const groups = groupTasks([overdue, today, upcoming, earlier, undated], "dueDate", now);
    expect(groups.map((group) => group.label)).toEqual([
      "Overdue",
      "Today",
      "Upcoming",
      "Earlier",
      "No due date",
    ]);
    expect(groups[1]?.tasks).toEqual([today]);
    expect(groups[3]?.tasks).toEqual([earlier]);
  });
});

describe("dueLabel", () => {
  it("has no label without a due date", () => {
    expect(dueLabel(task("a"), now, "en-US")).toBeNull();
  });

  it("reads nearby days relatively and omits a midnight time", () => {
    expect(dueLabel(task("a", { dueDate: local(2026, 8, 9) }), now, "en-US")).toBe("today");
    expect(dueLabel(task("b", { dueDate: local(2026, 8, 10) }), now, "en-US")).toBe("tomorrow");
    expect(dueLabel(task("c", { dueDate: local(2026, 8, 8) }), now, "en-US")).toBe("yesterday");
  });

  it("appends a time only when one was set", () => {
    const label = dueLabel(task("a", { dueDate: local(2026, 8, 9, 14, 30) }), now, "en-US");
    expect(label).toContain("today, ");
    expect(label).toMatch(/2:30/u);
  });

  it("falls back to an absolute date beyond a week", () => {
    expect(dueLabel(task("a", { dueDate: local(2026, 12, 25) }), now, "en-US")).toBe(
      "Dec 25, 2026",
    );
  });
});

describe("date and instant conversion", () => {
  it("resolves a date with no time to local midnight", () => {
    expect(composeDueDate("2026-08-20", "")).toBe(local(2026, 8, 20));
  });

  it("round-trips a local date and time through the stored instant", () => {
    const instant = composeDueDate("2026-08-20", "09:30");
    expect(instant).toBe(local(2026, 8, 20, 9, 30));
    expect(splitDueDate(instant)).toEqual({ date: "2026-08-20", time: "09:30" });
  });

  it("reports no time for a local-midnight instant", () => {
    expect(splitDueDate(local(2026, 8, 20))).toEqual({ date: "2026-08-20", time: "" });
  });

  it("rejects an empty or unparseable date", () => {
    expect(composeDueDate("", "09:30")).toBeNull();
    expect(composeDueDate("not-a-date", "")).toBeNull();
    expect(splitDueDate(null)).toEqual({ date: "", time: "" });
  });
});
