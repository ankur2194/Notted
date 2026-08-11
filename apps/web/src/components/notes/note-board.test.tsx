import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NoteBrowser } from "./NoteBrowser";

import type { CustomTaskStatus, NoteListQuery, NotePage, NoteSummary } from "@notted/shared-types";

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
  requestTagPage: vi.fn(),
  requestTaskPage: vi.fn(),
  requestTaskStatuses: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/notes/requests", () => ({
  copyNote: mocks.copyNote,
  createNote: mocks.createNote,
  updateNote: mocks.updateNote,
  moveNote: mocks.moveNote,
  trashNote: mocks.trashNote,
  restoreNote: mocks.restoreNote,
  permanentlyDeleteNote: mocks.permanentlyDeleteNote,
  requestNotePage: mocks.requestNotePage,
  requestFolders: mocks.requestFolders,
}));
vi.mock("@/lib/tags/requests", () => ({ requestTagPage: mocks.requestTagPage }));
vi.mock("@/lib/tasks/requests", () => ({
  requestTaskPage: mocks.requestTaskPage,
  requestTaskStatuses: mocks.requestTaskStatuses,
}));
// The timeline is a sibling view with its own suite; the board only needs it
// not to fetch here.
vi.mock("./NoteTimeline", () => ({ NoteTimeline: () => <p>Timeline</p> }));

const workspaceId = "50000000-0000-4000-8000-000000000001";
const projectId = "50000000-0000-4000-8000-000000000002";
const reviewId = "50000000-0000-4000-8000-0000000000f1";
const unknownColumnId = "50000000-0000-4000-8000-0000000000f9";

function note(id: string, title: string, overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id,
    workspaceId,
    location: "project",
    projectId,
    folderId: null,
    parentId: null,
    boardColumnId: null,
    title,
    type: "document",
    pageSize: "a4",
    sortOrder: 1,
    isTemplate: false,
    isPinned: false,
    isArchived: false,
    isDeleted: false,
    tagIds: [],
    progress: { checklist: { done: 0, total: 0 }, tasks: { done: 0, total: 0 } },
    version: 4,
    deletedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

const review: CustomTaskStatus = {
  id: reviewId,
  workspaceId,
  projectId,
  name: "In review",
  color: "#6b7280",
  sortOrder: 1,
  isBuiltIn: false,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const first = note("50000000-0000-4000-8000-00000000000a", "First", { sortOrder: 1 });
const second = note("50000000-0000-4000-8000-00000000000b", "Second", { sortOrder: 2 });
const page: NotePage = { items: [first, second], page: 1, limit: 50, hasMore: false };
const query: NoteListQuery = {
  page: 1,
  limit: 50,
  scope: "project",
  projectId,
  view: "normal",
  sortBy: "sortOrder",
  sortDirection: "asc",
};

function view(initialPage: NotePage = page) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NoteBrowser
        workspaceId={workspaceId}
        initialPage={initialPage}
        initialFolders={{ items: [], page: 1, limit: 100, hasMore: false }}
        query={query}
        canCreate
        title="Project notes"
        description="Browse"
        embedded
        projectIds={[projectId]}
        project={{
          id: projectId,
          name: "Launch",
          createdAt: "2026-07-01T00:00:00.000Z",
          dueAt: "2026-09-01T00:00:00.000Z",
        }}
      />
    </QueryClientProvider>,
  );
}

async function openBoard(initialPage: NotePage = page) {
  const user = userEvent.setup();
  view(initialPage);
  await user.click(screen.getByRole("button", { name: "Board" }));
  return user;
}

describe("NoteBoard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.requestNotePage.mockResolvedValue({ ok: true, data: page });
    mocks.requestFolders.mockResolvedValue({
      ok: true,
      data: { items: [], page: 1, limit: 100, hasMore: false },
    });
    mocks.requestTagPage.mockResolvedValue({
      ok: true,
      data: { items: [], page: 1, limit: 100, hasMore: false },
    });
    mocks.requestTaskStatuses.mockResolvedValue({ ok: true, data: { items: [review] } });
    mocks.requestTaskPage.mockResolvedValue({
      ok: true,
      data: { items: [], page: 1, limit: 100, hasMore: false },
    });
  });

  it("leads with a 'No column' bucket followed by the project's columns", async () => {
    await openBoard();
    expect(await screen.findByRole("heading", { level: 3, name: "In review (0)" })).toBeVisible();
    // Note cards use `h3` for their own titles, so the column headings are
    // picked out by the id their `ul` is labelled by.
    expect(
      screen
        .getAllByRole("heading", { level: 3 })
        .filter((heading) => heading.id.startsWith("note-board-column-"))
        .map((heading) => heading.textContent),
    ).toEqual(["No column (2)", "In review (0)"]);
  });

  it("moves a card with one move carrying the version, column and absolute container", async () => {
    mocks.moveNote.mockReturnValue(new Promise(() => undefined));
    const user = await openBoard();
    await screen.findByRole("heading", { level: 3, name: "In review (0)" });

    const selector = screen.getByLabelText("Column for First");
    await user.selectOptions(selector, within(selector).getByRole("option", { name: "In review" }));
    await user.click(screen.getByRole("button", { name: "Move to column for First" }));

    expect(mocks.moveNote).toHaveBeenCalledTimes(1);
    expect(mocks.moveNote).toHaveBeenCalledWith(workspaceId, first.id, {
      expectedVersion: first.version,
      projectId,
      folderId: null,
      parentId: null,
      beforeNoteId: null,
      boardColumnId: reviewId,
    });
    expect(mocks.updateNote).not.toHaveBeenCalled();
  });

  it("rolls a rejected column move back and offers the existing reload affordance", async () => {
    mocks.moveNote.mockResolvedValue({ ok: false, kind: "version-conflict" });
    const user = await openBoard();
    await screen.findByRole("heading", { level: 3, name: "In review (0)" });

    const selector = screen.getByLabelText("Column for First");
    await user.selectOptions(selector, within(selector).getByRole("option", { name: "In review" }));
    await user.click(screen.getByRole("button", { name: "Move to column for First" }));

    expect(await screen.findByText(/conflicted with a newer saved version/iu)).toBeVisible();
    // One banner, the container's: the board adds no second live region.
    expect(screen.getAllByRole("button", { name: "Reload latest notes" })).toHaveLength(1);
    expect(await screen.findByRole("heading", { level: 3, name: "No column (2)" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 3, name: "In review (0)" })).toBeVisible();
  });

  it("explains a truncated board and disables reordering on it", async () => {
    const truncated: NotePage = { ...page, hasMore: true };
    mocks.requestNotePage.mockResolvedValue({ ok: true, data: truncated });
    await openBoard(truncated);
    await screen.findByRole("heading", { level: 3, name: "In review (0)" });

    const notices = screen.getAllByRole("note").map((element) => element.textContent ?? "");
    expect(notices.some((text) => /truncated/iu.test(text))).toBe(true);
    expect(notices.some((text) => /Reordering inside a column/iu.test(text))).toBe(true);
    expect(screen.getByRole("button", { name: "Move down First" })).toBeDisabled();
  });

  it("keeps a note whose column is unknown on the board instead of hiding it", async () => {
    const stray = note("50000000-0000-4000-8000-00000000000c", "Stray", {
      boardColumnId: unknownColumnId,
      sortOrder: 3,
    });
    const withStray: NotePage = { ...page, items: [first, second, stray] };
    mocks.requestNotePage.mockResolvedValue({ ok: true, data: withStray });
    await openBoard(withStray);
    await screen.findByRole("heading", { level: 3, name: "In review (0)" });

    expect(
      within(screen.getByRole("list", { name: "No column (3)" })).getByRole("link", {
        name: "Stray",
      }),
    ).toBeVisible();
  });

  it("says only 'No column' is shown when the column list cannot be loaded", async () => {
    mocks.requestTaskStatuses.mockResolvedValue({ ok: false, kind: "unavailable" });
    await openBoard();

    expect(await screen.findByText(/only “No column” is shown/iu)).toBeVisible();
    expect(
      within(screen.getByRole("list", { name: "No column (2)" })).getByRole("link", {
        name: "First",
      }),
    ).toBeVisible();
  });
});
