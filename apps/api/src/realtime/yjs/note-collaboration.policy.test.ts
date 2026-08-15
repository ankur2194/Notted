import { describe, expect, it } from "vitest";

import {
  COMPACTION_MIN_BYTES,
  COMPACTION_MIN_UPDATES,
  PROJECTION_DEBOUNCE_MS,
  PROJECTION_MAX_WAIT_MS,
  shouldCompact,
  type CompactionInput,
} from "./note-collaboration.policy";

function input(overrides: Partial<CompactionInput> = {}): CompactionInput {
  return { pendingUpdates: 0, pendingBytes: 0, forcedBoundary: false, ...overrides };
}

describe("collaboration compaction thresholds", () => {
  it("keeps the debounce well below its hard ceiling", () => {
    expect(PROJECTION_DEBOUNCE_MS).toBeLessThan(PROJECTION_MAX_WAIT_MS);
  });

  it("does not compact an idle room", () => {
    expect(shouldCompact(input())).toBe(false);
  });

  it("does not compact below both volume thresholds", () => {
    const belowBoth = input({
      pendingUpdates: COMPACTION_MIN_UPDATES - 1,
      pendingBytes: COMPACTION_MIN_BYTES - 1,
    });
    expect(shouldCompact(belowBoth)).toBe(false);
  });

  it("compacts at the update-count threshold", () => {
    expect(shouldCompact(input({ pendingUpdates: COMPACTION_MIN_UPDATES }))).toBe(true);
    expect(shouldCompact(input({ pendingUpdates: COMPACTION_MIN_UPDATES + 1 }))).toBe(true);
  });

  it("compacts at the byte threshold even with few rows", () => {
    expect(shouldCompact(input({ pendingUpdates: 1, pendingBytes: COMPACTION_MIN_BYTES }))).toBe(
      true,
    );
  });

  it("compacts at a forced boundary when work is pending", () => {
    expect(shouldCompact(input({ pendingUpdates: 1, forcedBoundary: true }))).toBe(true);
  });

  // The case this test file exists for: a forced projection with nothing
  // pending must NOT write an empty snapshot (it would grow the log and bump
  // the epoch on every room close for no information gain).
  it("does not compact at a forced boundary with nothing pending", () => {
    expect(shouldCompact(input({ pendingUpdates: 0, forcedBoundary: true }))).toBe(false);
  });
});
