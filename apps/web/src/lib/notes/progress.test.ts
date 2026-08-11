import { describe, expect, it } from "vitest";

import { combineProgress, progressPercent } from "./progress";

describe("combineProgress", () => {
  it("returns an empty reading for no parts", () => {
    expect(combineProgress()).toEqual({ done: 0, total: 0 });
  });

  it("returns a single part unchanged", () => {
    expect(combineProgress({ done: 2, total: 5 })).toEqual({ done: 2, total: 5 });
  });

  it("sums done and total across several parts independently", () => {
    expect(
      combineProgress({ done: 1, total: 3 }, { done: 2, total: 4 }, { done: 0, total: 0 }),
    ).toEqual({ done: 3, total: 7 });
  });
});

describe("progressPercent", () => {
  it("is 0 rather than NaN when nothing is counted", () => {
    expect(progressPercent({ done: 0, total: 0 })).toBe(0);
  });

  it("rounds a partial reading to a whole percent", () => {
    expect(progressPercent({ done: 1, total: 3 })).toBe(33);
    expect(progressPercent({ done: 2, total: 3 })).toBe(67);
  });

  it("is exactly 100 when everything is done", () => {
    expect(progressPercent({ done: 7, total: 7 })).toBe(100);
  });
});
