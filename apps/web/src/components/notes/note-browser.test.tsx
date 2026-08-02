import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NoteBrowser } from "./NoteBrowser";

import type { NotePage, NoteSummary } from "@notted/shared-types";

const mocks = vi.hoisted(() => ({
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

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/notes/requests", () => ({ ...mocks }));

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

function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NoteBrowser
        workspaceId={workspaceId}
        initialPage={page}
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
});
