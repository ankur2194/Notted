import { describe, expect, it, vi } from "vitest";

import {
  noteViewPreferenceKey,
  readNoteViewPreference,
  writeNoteViewPreference,
} from "@/lib/notes/view-preference";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const projectId = "30000000-0000-4000-8000-000000000002";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("note view preference", () => {
  it("defaults to list when nothing is stored or the stored value is unknown", () => {
    const storage = memoryStorage();
    expect(readNoteViewPreference(storage, workspaceId, null)).toBe("list");
    storage.values.set(noteViewPreferenceKey(workspaceId, null)!, "gantt");
    expect(readNoteViewPreference(storage, workspaceId, null)).toBe("list");
  });

  it("round-trips each mode and keeps project scopes independent", () => {
    const storage = memoryStorage();
    writeNoteViewPreference(storage, workspaceId, projectId, "board");
    expect(readNoteViewPreference(storage, workspaceId, projectId)).toBe("board");
    writeNoteViewPreference(storage, workspaceId, projectId, "timeline");
    expect(readNoteViewPreference(storage, workspaceId, projectId)).toBe("timeline");
    // The workspace root cannot offer board or timeline, so it never inherits
    // the project's choice.
    expect(readNoteViewPreference(storage, workspaceId, null)).toBe("list");
    writeNoteViewPreference(storage, workspaceId, null, "grid");
    expect(readNoteViewPreference(storage, workspaceId, null)).toBe("grid");
    expect(readNoteViewPreference(storage, workspaceId, projectId)).toBe("timeline");
  });

  it("rejects a malformed workspace selector", () => {
    const storage = memoryStorage();
    expect(noteViewPreferenceKey("not-a-workspace", null)).toBeNull();
    writeNoteViewPreference(storage, "not-a-workspace", null, "board");
    expect(storage.values.size).toBe(0);
    expect(readNoteViewPreference(storage, "not-a-workspace", null)).toBe("list");
  });

  it("tolerates storage that throws and storage that is absent", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("blocked");
      }),
    };
    expect(readNoteViewPreference(storage, workspaceId, projectId)).toBe("list");
    expect(() => writeNoteViewPreference(storage, workspaceId, projectId, "board")).not.toThrow();
    expect(readNoteViewPreference(null, workspaceId, projectId)).toBe("list");
  });
});
