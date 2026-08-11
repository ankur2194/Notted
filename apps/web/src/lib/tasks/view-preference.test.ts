import { describe, expect, it, vi } from "vitest";

import {
  readTaskViewPreference,
  taskViewPreferenceKey,
  writeTaskViewPreference,
} from "@/lib/tasks/view-preference";

const workspaceA = "30000000-0000-4000-8000-000000000001";
const workspaceB = "30000000-0000-4000-8000-000000000002";

describe("task view preference", () => {
  it("uses workspace-qualified keys and validates stored values", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    writeTaskViewPreference(storage, workspaceA, "board");
    expect(readTaskViewPreference(storage, workspaceA)).toBe("board");
    writeTaskViewPreference(storage, workspaceA, "calendar");
    expect(readTaskViewPreference(storage, workspaceA)).toBe("calendar");
    // A second workspace never inherits the first one's view.
    expect(readTaskViewPreference(storage, workspaceB)).toBe("list");
    values.set(taskViewPreferenceKey(workspaceA)!, "gantt");
    expect(readTaskViewPreference(storage, workspaceA)).toBe("list");
  });

  it("tolerates unavailable storage and rejects malformed workspace selectors", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("blocked");
      }),
    };
    expect(readTaskViewPreference(storage, workspaceA)).toBe("list");
    expect(() => writeTaskViewPreference(storage, workspaceA, "board")).not.toThrow();
    expect(readTaskViewPreference(null, workspaceA)).toBe("list");
    expect(taskViewPreferenceKey("not-a-workspace")).toBeNull();
  });
});
