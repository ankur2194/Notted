import { describe, expect, it } from "vitest";

import { PRESENCE_COLOR_COUNT, presenceColorIndex } from "./presence-color";

/**
 * CROSS-PACKAGE FIXTURE TABLE. The web twin
 * (`apps/web/src/lib/collaboration/user-color.ts`) asserts the SAME numbers, so
 * a drift in either hash body turns into a failing test on both sides rather
 * than into two peers painting one person in two colours.
 *
 *   "00000000-0000-4000-8000-000000000001" -> 3
 *   "00000000-0000-4000-8000-000000000002" -> 4
 *   "alice"                                -> 4
 *   "bob"                                  -> 5
 *   ""                                     -> 0
 */
const FIXTURES: readonly (readonly [string, number])[] = [
  ["00000000-0000-4000-8000-000000000001", 3],
  ["00000000-0000-4000-8000-000000000002", 4],
  ["alice", 4],
  ["bob", 5],
  ["", 0],
];

describe("presenceColorIndex", () => {
  it.each(FIXTURES)("pins the shared fixture index for %j", (userId, expected) => {
    expect(presenceColorIndex(userId)).toBe(expected);
  });

  it("is deterministic for the same input", () => {
    const userId = "00000000-0000-4000-8000-00000000abcd";
    expect(presenceColorIndex(userId)).toBe(presenceColorIndex(userId));
  });

  it("never leaves the palette, including for the empty string", () => {
    expect(presenceColorIndex("")).toBe(0);
    for (let index = 0; index < 200; index += 1) {
      const slot = presenceColorIndex(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
      expect(Number.isInteger(slot)).toBe(true);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(PRESENCE_COLOR_COUNT);
    }
  });

  it("reaches every one of the eight buckets", () => {
    // Distribution sanity only: a hash that collapsed onto one slot would paint
    // a whole room in a single colour and still pass every other assertion.
    const seen = new Set<number>();
    for (let index = 0; index < 200; index += 1) {
      seen.add(presenceColorIndex(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`));
    }
    expect(seen.size).toBe(PRESENCE_COLOR_COUNT);
  });
});
