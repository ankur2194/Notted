import { describe, expect, it, vi } from "vitest";

import {
  projectViewPreferenceKey,
  readProjectViewPreference,
  writeProjectViewPreference,
} from "@/lib/projects/view-preference";

const workspaceA = "30000000-0000-4000-8000-000000000001";
const workspaceB = "30000000-0000-4000-8000-000000000002";

describe("project view preference", () => {
  it("uses workspace-qualified keys and validates stored values", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    writeProjectViewPreference(storage, workspaceA, "list");
    expect(readProjectViewPreference(storage, workspaceA)).toBe("list");
    expect(readProjectViewPreference(storage, workspaceB)).toBe("grid");
    values.set(projectViewPreferenceKey(workspaceA)!, "project-secret");
    expect(readProjectViewPreference(storage, workspaceA)).toBe("grid");
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
    expect(readProjectViewPreference(storage, workspaceA)).toBe("grid");
    expect(() => writeProjectViewPreference(storage, workspaceA, "list")).not.toThrow();
    expect(projectViewPreferenceKey("not-a-workspace")).toBeNull();
  });
});
