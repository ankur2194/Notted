import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, vi } from "vitest";

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
  type: "document",
  pageSize: "a4",
  isTemplate: false,
  isPinned: false,
  isArchived: false,
  isDeleted: false,
  tagIds: [],
  version: 1,
  deletedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
});

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ): DOMRect {
    const noteItems = Array.from(document.querySelectorAll('ul[aria-label="Notes"] > li'));
    const index = noteItems.indexOf(this);
    return {
      x: 0,
      y: Math.max(index, 0) * 100,
      top: Math.max(index, 0) * 100,
      left: 0,
      right: 400,
      bottom: Math.max(index, 0) * 100 + 100,
      width: 400,
      height: 100,
    } as unknown as DOMRect;
  });
});

afterEach(() => vi.restoreAllMocks());

describe("keyboard probe", () => {
  it("probes keydown events", async () => {
    const first = item("30000000-0000-4000-8000-000000000002", "First", 1);
    const second = item("30000000-0000-4000-8000-000000000003", "Second", 2);
    const user = userEvent.setup();
    render(
      <NoteList
        notes={[first, second]}
        folders={[]}
        pendingIds={new Set()}
        controlsFor={() => null}
        onMove={vi.fn()}
      />,
    );
    const handle = screen.getByRole("button", { name: "Drag Second" });
    handle.focus();
    const ev = new window.KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      bubbles: true,
      cancelable: true,
    });
    console.log(
      "[DEBUG] manual KeyboardEvent.code:",
      JSON.stringify(ev.code),
      "key:",
      JSON.stringify(ev.key),
    );
    const seen: Array<Record<string, unknown>> = [];
    document.addEventListener("keydown", (event) => {
      seen.push({
        code: event.code,
        key: event.key,
        isTrusted: event.isTrusted,
        own: Object.getOwnPropertyDescriptor(event, "code") ? "own" : "proto",
      });
    });
    await user.keyboard("{Space}");
    console.log("[DEBUG] seen:", JSON.stringify(seen));
  });
});
