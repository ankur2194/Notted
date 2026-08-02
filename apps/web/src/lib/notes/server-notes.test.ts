import { describe, expect, it } from "vitest";

import { parseNoteSearchParams } from "./server-notes";

describe("server note query parsing", () => {
  it("validates route search values and keeps project selectors server-owned", () => {
    const projectId = "30000000-0000-4000-8000-000000000001";
    expect(
      parseNoteSearchParams({ page: "2", type: "task-list" }, { view: "recent", projectId }),
    ).toMatchObject({ page: 2, scope: "project", projectId, view: "recent", type: "task-list" });
    expect(
      parseNoteSearchParams({ page: "not-a-page", projectId: "forged", isArchived: "yes" }),
    ).toMatchObject({ page: 1, scope: "workspace-root", view: "normal" });
    expect(parseNoteSearchParams({}, { view: "trash" })).toMatchObject({
      sortBy: "deletedAt",
      sortDirection: "desc",
    });
    expect(parseNoteSearchParams({}, { view: "pinned" })).toMatchObject({
      sortBy: "updatedAt",
      sortDirection: "desc",
    });
    expect(parseNoteSearchParams({ isArchived: "true" })).toMatchObject({
      sortBy: "updatedAt",
      sortDirection: "desc",
    });
  });
});
