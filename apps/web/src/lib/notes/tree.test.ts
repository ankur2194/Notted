import { describe, expect, it } from "vitest";

import { buildNoteTree, optimisticMove } from "./tree";

import type { NoteNavigationItem, NoteSummary } from "@notted/shared-types";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const note = (
  id: string,
  parentId: string | null,
  sortOrder: number,
  projectId: string | null = null,
): NoteNavigationItem => ({
  id,
  parentId,
  projectId,
  folderId: null,
  title: id,
  type: "document",
  sortOrder,
  isTemplate: false,
  isPinned: false,
  isArchived: false,
  version: 1,
  updatedAt: "2026-08-01T00:00:00.000Z",
});

describe("note tree helpers", () => {
  it("separates projects and standalone containers while preserving hierarchy and stable order", () => {
    const parent = "30000000-0000-4000-8000-000000000002";
    const child = "30000000-0000-4000-8000-000000000003";
    const projectId = "30000000-0000-4000-8000-000000000004";
    const groups = buildNoteTree([
      note(child, parent, 2),
      note(parent, null, 1),
      note("30000000-0000-4000-8000-000000000005", null, 1, projectId),
    ]);
    expect(groups.standalone.get("unfiled")?.[0]?.note.id).toBe(parent);
    expect(groups.standalone.get("unfiled")?.[0]?.children[0]?.note.id).toBe(child);
    expect(groups.projects.has(projectId)).toBe(true);
  });

  it("moves from a complete clone so callers can restore exact parent, container, and order", () => {
    const first = {
      ...note("30000000-0000-4000-8000-000000000002", null, 1),
      workspaceId,
      location: "workspace-root" as const,
      pageSize: "a4" as const,
      isDeleted: false,
      tagIds: [],
      deletedAt: null,
      createdAt: "2026-08-01T00:00:00.000Z",
    } satisfies NoteSummary;
    const second = { ...first, id: "30000000-0000-4000-8000-000000000003", sortOrder: 2 };
    const moved = optimisticMove(
      [first, second],
      second.id,
      { projectId: null, folderId: null, parentId: first.id },
      null,
    );
    expect(moved.find((item) => item.id === second.id)?.parentId).toBe(first.id);
    expect(first.parentId).toBeNull();
    expect(second.sortOrder).toBe(2);
  });
});
