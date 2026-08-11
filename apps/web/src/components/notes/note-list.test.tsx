import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NoteList } from "./NoteList";

import type { NoteSummary } from "@notted/shared-types";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const item = (id: string, title: string, sortOrder: number): NoteSummary => ({
  id,
  title,
  sortOrder,
  workspaceId,
  location: "workspace-root",
  projectId: null,
  folderId: null,
  parentId: null,
  boardColumnId: null,
  type: "document",
  pageSize: "a4",
  isTemplate: false,
  isPinned: false,
  isArchived: false,
  isDeleted: false,
  tagIds: [],
  progress: { checklist: { done: 0, total: 0 }, tasks: { done: 0, total: 0 } },
  version: 1,
  deletedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
});

// jsdom measures every element as a zero-size, zero-offset rect. That defeats
// dnd-kit's keyboard DnD: the sortable coordinate getter only targets items
// strictly above the dragged one, and `KeyboardSensor`'s start handler would
// call the jsdom-unimplemented `scrollIntoView` for a zero-height node (which
// aborts the drag). Report a realistic layout instead, where each note item
// occupies its own row below the previous one, so collision detection and
// keyboard moves behave like in a browser.
function rect(top: number, height: number, width: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: width,
    bottom: top + height,
    width,
    height,
  } as unknown as DOMRect;
}

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ): DOMRect {
    const noteItems = Array.from(document.querySelectorAll('ul[aria-label="Notes"] > li'));
    const index = noteItems.indexOf(this);
    return index === -1 ? rect(0, 400, 400) : rect(index * 100, 100, 400);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NoteList movement", () => {
  it("wires the dnd-kit keyboard sensor and visible alternatives to the same bounded move selector", async () => {
    const first = item("30000000-0000-4000-8000-000000000002", "First", 1);
    const second = item("30000000-0000-4000-8000-000000000003", "Second", 2);
    const onMove = vi.fn();
    const user = userEvent.setup();
    render(
      <NoteList
        notes={[first, second]}
        folders={[]}
        pendingIds={new Set()}
        controlsFor={() => null}
        onMove={onMove}
      />,
    );
    const handle = screen.getByRole("button", { name: "Drag Second" });
    handle.focus();
    // user-event's keyMap stores Space as { key: " ", code: "Space" } and
    // matches `{tag}` descriptors by key, so "{Space}" falls back to
    // { key: "Space", code: "Unknown" }, which dnd-kit's KeyboardSensor
    // (activated by key code) ignores. A literal space character produces
    // key " " and code "Space", matching a real Space keypress.
    await user.keyboard(" {ArrowUp} ");
    await waitFor(() =>
      expect(onMove).toHaveBeenCalledWith(
        second,
        expect.objectContaining({
          projectId: null,
          folderId: null,
          parentId: null,
          beforeNoteId: first.id,
        }),
      ),
    );
    onMove.mockClear();
    await user.click(screen.getAllByRole("button", { name: "Move up" }).at(-1)!);
    expect(onMove).toHaveBeenCalledWith(
      second,
      expect.objectContaining({ beforeNoteId: first.id }),
    );
  });

  it("disables relative controls for an incomplete or non-authoritative projection", () => {
    const first = item("30000000-0000-4000-8000-000000000002", "First", 1);
    const second = item("30000000-0000-4000-8000-000000000003", "Second", 2);
    render(
      <NoteList
        notes={[first, second]}
        folders={[]}
        pendingIds={new Set()}
        controlsFor={() => null}
        onMove={vi.fn()}
        relativeOrderingDisabled
      />,
    );
    expect(
      screen
        .getAllByRole("button", { name: "Move up" })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    expect(screen.getByText(/complete first-page sibling view/u)).toBeVisible();
  });
});
