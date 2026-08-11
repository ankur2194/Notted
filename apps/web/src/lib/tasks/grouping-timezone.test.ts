import { afterAll, describe, expect, it } from "vitest";

import { bucketByDay, localDayKey, monthGrid } from "./grouping";

import type { TaskSummary } from "@notted/shared-types";

/*
 * The calendar grid and the day buckets in two real zones, one on each side of
 * the equator.
 *
 * `process.env.TZ` is set at module top and again per suite: Node ≥ 16
 * invalidates the V8 date cache on that assignment, so `new Date(...)` really
 * does answer in the requested zone from that point on. Doing it here rather
 * than in the shared setup file keeps every other suite in the runner's own
 * zone, and the original value is restored afterwards.
 */
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/New_York";

const workspaceId = "40000000-0000-4000-8000-000000000001";
const creatorId = "40000000-0000-4000-8000-0000000000c1";

function task(id: string, dueDate: string | null): TaskSummary {
  return {
    id,
    workspaceId,
    projectId: null,
    noteId: null,
    parentId: null,
    title: `Task ${id}`,
    status: "todo",
    customStatusId: null,
    statusLabel: null,
    priority: "medium",
    assigneeId: null,
    dueDate,
    completedAt: null,
    sortOrder: 1,
    recurrence: "none",
    recurrenceCron: null,
    tagIds: [],
    createdById: creatorId,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function useZone(zone: string): void {
  process.env.TZ = zone;
}

afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

/** Consecutive, distinct, and 42 long — the properties a month view relies on. */
function expectContinuousGrid(grid: readonly string[], around: string, next: string): void {
  expect(grid).toHaveLength(42);
  expect(new Set(grid).size).toBe(42);
  expect(grid).toContain(around);
  expect(grid[grid.indexOf(around) + 1]).toBe(next);
}

describe("month grid in America/New_York", () => {
  it("survives the spring-forward and fall-back days", () => {
    useZone("America/New_York");
    // 2026-03-08 is 23 hours long and 2026-11-01 is 25 hours long there.
    expectContinuousGrid(monthGrid(2026, 2), "2026-03-08", "2026-03-09");
    expectContinuousGrid(monthGrid(2026, 10), "2026-11-01", "2026-11-02");
  });

  it("buckets due instants by the New York calendar day", () => {
    useZone("America/New_York");
    // 07:00 UTC is 03:00 EDT the same day; 23:00 UTC is 19:00 EDT, still the
    // same day — New York is always behind UTC.
    const morning = task("a", "2026-08-20T07:00:00.000Z");
    const evening = task("b", "2026-08-20T23:00:00.000Z");
    const buckets = bucketByDay([morning, evening]);
    expect(buckets.get("2026-08-20")).toEqual([morning, evening]);
    expect(buckets.size).toBe(1);
    expect(localDayKey(new Date("2026-08-20T02:00:00.000Z"))).toBe("2026-08-19");
  });
});

describe("month grid in Pacific/Auckland", () => {
  it("survives the fall-back and spring-forward days", () => {
    useZone("Pacific/Auckland");
    // New Zealand runs the transitions the other way round: 2026-04-05 is 25
    // hours long and 2026-09-27 is 23.
    expectContinuousGrid(monthGrid(2026, 3), "2026-04-05", "2026-04-06");
    expectContinuousGrid(monthGrid(2026, 8), "2026-09-27", "2026-09-28");
  });

  it("buckets due instants by the Auckland calendar day", () => {
    useZone("Pacific/Auckland");
    // Auckland is ahead of UTC, so the same two instants split across two days.
    const morning = task("a", "2026-08-20T07:00:00.000Z");
    const evening = task("b", "2026-08-20T23:00:00.000Z");
    const buckets = bucketByDay([morning, evening]);
    expect(buckets.get("2026-08-20")).toEqual([morning]);
    expect(buckets.get("2026-08-21")).toEqual([evening]);
  });
});
