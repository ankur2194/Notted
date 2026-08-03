import { describe, expect, it } from "vitest";

import {
  noteCollectionPath,
  noteDetailPath,
  noteListHref,
  noteViewPath,
  projectNotePath,
  standaloneNotePath,
} from "./paths";

const workspaceId = "20000000-0000-4000-8000-000000000001";
const projectId = "30000000-0000-4000-8000-000000000001";
const noteId = "30000000-0000-4000-8000-000000000002";

describe("note route paths", () => {
  it("builds the workspace-scoped collection and view routes", () => {
    expect(noteCollectionPath(workspaceId)).toBe(`/workspaces/${workspaceId}/notes`);
    expect(noteViewPath(workspaceId, "trash")).toBe(`/workspaces/${workspaceId}/notes/trash`);
    expect(noteViewPath(workspaceId, "templates")).toBe(
      `/workspaces/${workspaceId}/notes/templates`,
    );
  });

  /**
   * A note lives at a different route depending on whether it belongs to a
   * project, and the caller should never have to branch on that itself — a link
   * built from the wrong branch 404s.
   */
  it("routes a note by whether it belongs to a project", () => {
    expect(noteDetailPath(workspaceId, { id: noteId, projectId: null })).toBe(
      `/workspaces/${workspaceId}/notes/${noteId}`,
    );
    expect(noteDetailPath(workspaceId, { id: noteId, projectId })).toBe(
      `/workspaces/${workspaceId}/projects/${projectId}/notes/${noteId}`,
    );
  });

  it("encodes every interpolated identifier", () => {
    expect(standaloneNotePath("a/b", "c d")).toBe("/workspaces/a%2Fb/notes/c%20d");
    expect(projectNotePath("a/b", "c/d", "e/f")).toBe(
      "/workspaces/a%2Fb/projects/c%2Fd/notes/e%2Ff",
    );
  });

  it("omits the query string entirely for a default listing", () => {
    expect(noteListHref(workspaceId)).toBe(`/workspaces/${workspaceId}/notes`);
    expect(noteListHref(workspaceId, { view: "normal", page: 1 })).toBe(
      `/workspaces/${workspaceId}/notes`,
    );
  });

  it("keeps a non-default view in the path rather than the query", () => {
    expect(noteListHref(workspaceId, { view: "pinned" })).toBe(
      `/workspaces/${workspaceId}/notes/pinned`,
    );
  });

  it("serializes only the selectors that differ from the defaults", () => {
    expect(
      noteListHref(workspaceId, {
        page: 3,
        folderId: projectId,
        type: "task-list",
        isArchived: true,
        sortBy: "title",
        sortDirection: "asc",
      }),
    ).toBe(
      `/workspaces/${workspaceId}/notes?page=3&folderId=${projectId}&type=task-list&isArchived=true&sortBy=title&sortDirection=asc`,
    );
  });

  it("treats a null folder selector as no selector", () => {
    expect(noteListHref(workspaceId, { folderId: null })).toBe(`/workspaces/${workspaceId}/notes`);
  });

  it("keeps an explicit false archive selector so the link is not ambiguous", () => {
    expect(noteListHref(workspaceId, { isArchived: false })).toBe(
      `/workspaces/${workspaceId}/notes?isArchived=false`,
    );
  });
});
