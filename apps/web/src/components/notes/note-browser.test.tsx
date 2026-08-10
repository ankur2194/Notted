import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NoteBrowser } from "./NoteBrowser";

import type { NotePage, NoteSummary } from "@notted/shared-types";

const mocks = vi.hoisted(() => ({
  copyNote: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  moveNote: vi.fn(),
  trashNote: vi.fn(),
  restoreNote: vi.fn(),
  permanentlyDeleteNote: vi.fn(),
  requestNotePage: vi.fn(),
  requestFolders: vi.fn(),
  refresh: vi.fn(),
}));
const tagMocks = vi.hoisted(() => ({ requestTagPage: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/notes/requests", () => ({ ...mocks }));
vi.mock("@/lib/tags/requests", () => ({ ...tagMocks }));

const workspaceId = "30000000-0000-4000-8000-000000000001";
const base = (id: string, title: string, sortOrder: number): NoteSummary => ({
  id,
  workspaceId,
  location: "workspace-root",
  projectId: null,
  folderId: null,
  parentId: null,
  title,
  type: "document",
  pageSize: "a4",
  sortOrder,
  isTemplate: false,
  isPinned: false,
  isArchived: false,
  isDeleted: false,
  tagIds: [],
  version: 2,
  deletedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
});
const first = base("30000000-0000-4000-8000-000000000002", "First", 1);
const second = base("30000000-0000-4000-8000-000000000003", "Second", 2);
const page: NotePage = { items: [first, second], page: 1, limit: 50, hasMore: false };
const query = {
  page: 1,
  limit: 50,
  scope: "workspace-root" as const,
  view: "normal" as const,
  sortBy: "sortOrder" as const,
  sortDirection: "asc" as const,
};

function view(initialPage: NotePage = page) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NoteBrowser
        workspaceId={workspaceId}
        initialPage={initialPage}
        initialFolders={{ items: [], page: 1, limit: 100, hasMore: false }}
        query={query}
        canCreate
        title="Notes"
        description="Browse"
      />
    </QueryClientProvider>,
  );
}

describe("NoteBrowser optimistic behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestNotePage.mockResolvedValue({ ok: true, data: page });
    mocks.requestFolders.mockResolvedValue({
      ok: true,
      data: { items: [], page: 1, limit: 100, hasMore: false },
    });
    tagMocks.requestTagPage.mockResolvedValue({
      ok: true,
      data: { items: [], page: 1, limit: 100, hasMore: false },
    });
  });

  it("inserts an accessible temporary create and restores the exact prior list on network failure", async () => {
    let resolve!: (value: unknown) => void;
    mocks.createNote.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole("button", { name: "Create note" }));
    await user.type(screen.getByLabelText("Title"), "Temporary");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create" }));
    expect(screen.getByRole("link", { name: "Temporary" })).toBeVisible();
    resolve({ ok: false, kind: "unavailable" });
    expect(await screen.findByText(/previous list was restored/iu)).toBeVisible();
    expect(screen.queryByRole("link", { name: "Temporary" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "First" })).toBeVisible();
  });

  it("restores the exact previous title/version on a 409 and offers reload", async () => {
    mocks.updateNote.mockResolvedValue({ ok: false, kind: "version-conflict" });
    const user = userEvent.setup();
    view();
    const firstCard = screen.getByRole("link", { name: "First" }).closest("article")!;
    await user.click(within(firstCard).getByRole("button", { name: "Rename" }));
    const input = within(firstCard).getByLabelText("New note title");
    await user.clear(input);
    await user.type(input, "Changed");
    await user.click(within(firstCard).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/exact previous title, version/iu)).toBeVisible();
    expect(screen.getByRole("link", { name: "First" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Reload latest notes" })).toBeVisible();
  });

  it("provides keyboard-independent move controls and restores exact order after failure", async () => {
    mocks.moveNote.mockResolvedValue({ ok: false, kind: "unavailable" });
    const user = userEvent.setup();
    view();
    const secondCard = screen.getByRole("link", { name: "Second" }).closest("article")!;
    await user.click(within(secondCard).getByRole("button", { name: "Move up" }));
    expect(await screen.findByText(/previous state was restored/iu)).toBeVisible();
    expect(
      screen
        .getAllByRole("link")
        .filter((link) => ["First", "Second"].includes(link.textContent ?? ""))
        .map((link) => link.textContent),
    ).toEqual(["First", "Second"]);
    const restoredSecondCard = screen.getByRole("link", { name: "Second" }).closest("article")!;
    expect(within(restoredSecondCard).getByRole("button", { name: "Indent" })).toBeEnabled();
    expect(within(restoredSecondCard).getByRole("button", { name: "Outdent" })).toBeDisabled();
  });

  it("shows a pending template row for 'Save as template' and rolls the list back on failure", async () => {
    let resolve!: (value: unknown) => void;
    mocks.copyNote.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const user = userEvent.setup();
    view();
    const firstCard = screen.getByRole("link", { name: "First" }).closest("article")!;
    await user.click(within(firstCard).getByRole("button", { name: "Save as template" }));
    // The copy carries the source title, so the optimistic row is the second
    // "First" link — its presence before the request resolves is the assertion.
    expect(screen.getAllByRole("link", { name: "First" })).toHaveLength(2);
    expect(mocks.copyNote).toHaveBeenCalledWith(
      workspaceId,
      first.id,
      {
        asTemplate: true,
        includeTags: true,
        projectId: null,
        folderId: null,
        parentId: null,
      },
      expect.any(String),
    );
    resolve({ ok: false, kind: "unavailable" });
    const announcement = await screen.findByText(/Saving as a template could not reach Notted/iu);
    expect(announcement.closest("[aria-live='polite']")).not.toBeNull();
    expect(screen.getAllByRole("link", { name: "First" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Second" })).toBeVisible();
  });

  it("copies a template into an ordinary note and announces the result", async () => {
    const template = base("30000000-0000-4000-8000-000000000004", "Weekly review", 1);
    const templatePage: NotePage = {
      items: [{ ...template, isTemplate: true }],
      page: 1,
      limit: 50,
      hasMore: false,
    };
    mocks.requestNotePage.mockResolvedValue({ ok: true, data: templatePage });
    mocks.copyNote.mockResolvedValue({
      ok: true,
      data: { note: { ...template, id: "30000000-0000-4000-8000-000000000005" } },
    });
    const user = userEvent.setup();
    view(templatePage);
    await user.click(screen.getByRole("button", { name: "Create from template" }));
    const announcement = await screen.findByText("Created Weekly review from the template.");
    expect(announcement.closest("[aria-live='polite']")).not.toBeNull();
    expect(mocks.copyNote).toHaveBeenCalledWith(
      workspaceId,
      template.id,
      {
        asTemplate: false,
        includeTags: true,
        projectId: null,
        folderId: null,
        parentId: null,
      },
      expect.any(String),
    );
  });

  it("labels tag chips by name and keeps the notes readable when the tag listing fails", async () => {
    const tagId = "30000000-0000-4000-8000-0000000000a1";
    const tagged: NotePage = { ...page, items: [{ ...first, tagIds: [tagId] }] };
    // `initialPage` only seeds the query; the mount refetch replaces it, so the
    // listing mock has to carry the tagged note too or the card renders with no
    // tag ids at all and the chip group never appears.
    mocks.requestNotePage.mockResolvedValue({ ok: true, data: tagged });
    tagMocks.requestTagPage.mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            id: tagId,
            workspaceId,
            name: "Roadmap",
            color: "#6b7280",
            noteCount: 1,
            taskCount: 0,
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        page: 1,
        limit: 100,
        hasMore: false,
      },
    });
    const resolved = view(tagged);
    // Scoped to the chip group: the same tag name also legitimately appears as
    // a checkbox label inside the row's tag picker.
    const chips = await screen.findByLabelText("Note tags");
    expect(within(chips).getByText("Roadmap")).toBeVisible();
    expect(within(chips).getAllByText("Roadmap")).toHaveLength(1);
    resolved.unmount();

    tagMocks.requestTagPage.mockResolvedValue({ ok: false, kind: "unavailable" });
    view(tagged);
    // The unresolved id is dropped rather than shown raw, and the note list
    // itself never enters the error gate.
    expect(await screen.findByRole("link", { name: "First" })).toBeVisible();
    expect(screen.queryByText("Roadmap")).not.toBeInTheDocument();
    expect(screen.queryByText(tagId)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("assigns and removes a tag through one full-replace update and rolls back on conflict", async () => {
    const tagId = "30000000-0000-4000-8000-0000000000a1";
    const tag = {
      id: tagId,
      workspaceId,
      name: "Roadmap",
      color: "#6b7280",
      noteCount: 0,
      taskCount: 0,
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    tagMocks.requestTagPage.mockResolvedValue({
      ok: true,
      data: { items: [tag], page: 1, limit: 100, hasMore: false },
    });
    mocks.updateNote.mockResolvedValue({
      ok: true,
      data: { note: { ...first, tagIds: [tagId], version: first.version + 1 } },
    });
    const user = userEvent.setup();
    // The listing mock decides what is on screen after the mount refetch, not
    // `initialPage`. Both are narrowed to one note, and the click is still
    // scoped to that note's own picker: the chip group and the picker both
    // carry the tag name, and every note on screen renders its own picker.
    const single: NotePage = { ...page, items: [first] };
    mocks.requestNotePage.mockResolvedValue({ ok: true, data: single });
    const assigning = view(single);
    const assigningPicker = await screen.findByRole("group", { name: `Tags for ${first.title}` });
    await user.click(await within(assigningPicker).findByRole("checkbox", { name: "Roadmap" }));
    // Assignment is a full replace of the whole tag set, not a per-edge call:
    // the server exposes no assign/remove route on purpose.
    expect(mocks.updateNote).toHaveBeenCalledWith(workspaceId, first.id, {
      expectedVersion: first.version,
      tagIds: [tagId],
    });
    assigning.unmount();

    // Removal sends the emptied set back through the same path, and a stale
    // version restores the previous selection instead of leaving the
    // optimistic empty set on screen.
    mocks.updateNote.mockClear();
    mocks.updateNote.mockResolvedValue({ ok: false, kind: "version-conflict" });
    const tagged = { ...first, tagIds: [tagId] };
    const taggedPage: NotePage = { ...page, items: [tagged] };
    mocks.requestNotePage.mockResolvedValue({ ok: true, data: taggedPage });
    view(taggedPage);
    const removingPicker = await screen.findByRole("group", { name: `Tags for ${first.title}` });
    await user.click(await within(removingPicker).findByRole("checkbox", { name: "Roadmap" }));
    expect(mocks.updateNote).toHaveBeenCalledWith(workspaceId, first.id, {
      expectedVersion: tagged.version,
      tagIds: [],
    });
    expect(await screen.findByText(/conflicted with a newer saved version/)).toBeVisible();
    expect(within(removingPicker).getByRole("checkbox", { name: "Roadmap" })).toBeChecked();
  });
});
