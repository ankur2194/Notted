import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// `NoteDetailView` now wraps the editor in `PageContainer` (Part 37), which
// offers a `router.refresh()` reload affordance on a version conflict. No app
// router is mounted in jsdom, so `useRouter` needs a stub here.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

// Part 58. An editable note now opens a collaborative session, and no socket
// server exists in jsdom. These cases are about the detail view's own markup,
// so the session resolves to solo — exactly the degraded path they already
// assert against.
vi.mock("@/lib/collaboration/useNoteCollaboration", () => ({
  useNoteCollaboration: () => ({ mode: "solo", binding: null, epoch: 0, status: "offline" }),
}));

import { NoteCard } from "./NoteCard";
import { NoteDetailView } from "./NoteDetailView";
import { NoteLifecycleActions } from "./NoteLifecycleActions";
import { NoteTree } from "./NoteTree";
import { ShareModal } from "./ShareModal";

import type { NoteSummary } from "@notted/shared-types";
import type { ReactNode } from "react";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const note: NoteSummary = {
  id: "30000000-0000-4000-8000-000000000002",
  workspaceId,
  location: "workspace-root",
  projectId: null,
  folderId: null,
  parentId: null,
  boardColumnId: null,
  title: "Quarterly notes",
  type: "document",
  pageSize: "a4",
  sortOrder: 1,
  isTemplate: true,
  isPinned: true,
  isArchived: false,
  isDeleted: false,
  tagIds: [],
  progress: { checklist: { done: 0, total: 0 }, tasks: { done: 0, total: 0 } },
  version: 3,
  deletedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function providers(children: ReactNode) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

describe("note components", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders safe metadata and only an explicitly supplied plain-text excerpt", () => {
    render(<NoteCard note={note} excerpt={'Plain text <script>alert("no")</script>'} />);
    expect(screen.getByRole("link", { name: note.title })).toHaveAttribute(
      "href",
      `/workspaces/${workspaceId}/notes/${note.id}`,
    );
    expect(screen.getByText(/Standalone · Unfiled/u)).toBeInTheDocument();
    expect(screen.getByText(/<script>/u)).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    // Nothing to count means no bar at all: an empty track would read as "0%
    // done" on every plain document rather than "not applicable".
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("states combined checklist and task progress in words as well as a bar", () => {
    render(
      <NoteCard
        note={{
          ...note,
          progress: { checklist: { done: 1, total: 3 }, tasks: { done: 2, total: 4 } },
        }}
      />,
    );
    const bar = screen.getByRole("progressbar", {
      name: `Checklist and task progress for ${note.title}`,
    });
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    expect(bar).toHaveAttribute("aria-valuemax", "7");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(screen.getByText("3/7 done")).toBeVisible();
  });

  it("splits checklist and task progress in the note detail header", () => {
    // The card shows one combined number because it has room for one; the
    // header can afford to name both halves, so a reader can tell an unchecked
    // inline box from an open task row instead of guessing at a single ratio.
    render(
      providers(
        <NoteDetailView
          note={{
            ...note,
            progress: { checklist: { done: 1, total: 3 }, tasks: { done: 2, total: 4 } },
            content: { type: "doc", content: [] },
            contentPlain: "",
            createdById: note.id,
            updatedById: null,
            currentActorId: note.id,
            capabilities: { canUpdate: false, canDelete: false, canShare: false, canExport: false },
          }}
          workspaceName="Alpha"
        />,
      ),
    );
    const bar = screen.getByRole("progressbar", {
      name: `Checklist and task progress for ${note.title}`,
    });
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    expect(bar).toHaveAttribute("aria-valuemax", "7");
    expect(screen.getByText(/3\/7 done · 1\/3 checklist items · 2\/4 tasks/u)).toBeVisible();
  });

  it("renders deep-link breadcrumbs and persisted content without interpreting it as HTML", async () => {
    // The note body is rendered exactly once, by the editor. Persisted text that
    // looks like markup must reach the screen as characters: TipTap is fed
    // contract JSON, never an HTML string, so `<b>` stays literal text.
    render(
      providers(
        <NoteDetailView
          note={{
            ...note,
            content: {
              type: "doc",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "<b>literal text</b>" }] },
              ],
            },
            contentPlain: "<b>literal text</b>",
            createdById: note.id,
            updatedById: null,
            currentActorId: note.id,
            capabilities: { canUpdate: true, canDelete: true, canShare: true, canExport: true },
          }}
          workspaceName="Alpha"
        />,
      ),
    );
    expect(screen.getByRole("navigation", { name: "Note breadcrumbs" })).toHaveTextContent("Alpha");
    const surface = await screen.findByRole("textbox", { name: `Note content: ${note.title}` });
    await waitFor(() => expect(surface).toHaveTextContent("<b>literal text</b>"));
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByRole("toolbar", { name: "Note formatting" })).toBeInTheDocument();
    // Exactly one rendering of the body: the placeholder plain-text panel that
    // used to duplicate it below the editor is gone.
    expect(screen.getAllByText("<b>literal text</b>")).toHaveLength(1);
  });

  it("presents server-derived sharing capability without treating UI state as authority", () => {
    render(
      providers(
        <NoteDetailView
          note={{
            ...note,
            content: { type: "doc", content: [] },
            contentPlain: "",
            createdById: note.id,
            updatedById: null,
            currentActorId: note.id,
            capabilities: { canUpdate: false, canDelete: false, canShare: false, canExport: false },
          }}
          workspaceName="Alpha"
        />,
      ),
    );
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    expect(screen.getByText(/do not have permission to manage sharing/u)).toBeVisible();
  });

  it("renders the editor read only when the update capability is absent", () => {
    render(
      providers(
        <NoteDetailView
          note={{
            ...note,
            content: { type: "doc", content: [] },
            contentPlain: "",
            createdById: note.id,
            updatedById: null,
            currentActorId: note.id,
            capabilities: { canUpdate: false, canDelete: false, canShare: false, canExport: false },
          }}
          workspaceName="Alpha"
        />,
      ),
    );
    expect(screen.queryByRole("toolbar", { name: "Note formatting" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("toolbar", { name: "Note editor actions (read only)" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Bold/u })).not.toBeInTheDocument();
    expect(screen.getByText(/do not have permission to edit it/u)).toHaveAttribute("role", "note");
  });

  it("renders the editor read only for a trashed note even with the update capability", () => {
    render(
      providers(
        <NoteDetailView
          note={{
            ...note,
            isDeleted: true,
            deletedAt: "2026-08-02T00:00:00.000Z",
            content: { type: "doc", content: [] },
            contentPlain: "",
            createdById: note.id,
            updatedById: null,
            currentActorId: note.id,
            capabilities: { canUpdate: true, canDelete: true, canShare: true, canExport: true },
          }}
          workspaceName="Alpha"
        />,
      ),
    );
    expect(screen.queryByRole("toolbar", { name: "Note formatting" })).not.toBeInTheDocument();
    expect(screen.getByText(/This note is in the trash/u)).toHaveAttribute("role", "note");
  });

  it("keeps sidebar failure bounded and exposes truncation to the full browser", () => {
    const { rerender } = render(
      <NoteTree workspaceId={workspaceId} state={{ status: "unavailable" }} />,
    );
    expect(screen.getByText(/Other workspace tools remain available/u)).toBeInTheDocument();
    rerender(
      <NoteTree
        workspaceId={workspaceId}
        state={{
          status: "ready",
          folders: [],
          navigation: { items: [], limit: 500, returned: 0, truncated: true },
        }}
      />,
    );
    expect(screen.getByRole("link", { name: /Open the full note browser/u })).toHaveAttribute(
      "href",
      `/workspaces/${workspaceId}/notes`,
    );
  });

  it("uses separate 44px disclosure and link controls with tree semantics", async () => {
    const user = userEvent.setup();
    const child = {
      id: "30000000-0000-4000-8000-000000000006",
      projectId: null,
      folderId: null,
      parentId: note.id,
      title: "Child",
      type: "document" as const,
      sortOrder: 2,
      isTemplate: false,
      isPinned: false,
      isArchived: false,
      version: 1,
      updatedAt: note.updatedAt,
    };
    const parent = { ...child, id: note.id, parentId: null, title: note.title, sortOrder: 1 };
    render(
      <NoteTree
        workspaceId={workspaceId}
        state={{
          status: "ready",
          folders: [],
          navigation: { items: [parent, child], limit: 500, returned: 2, truncated: false },
        }}
      />,
    );
    const disclosure = screen.getByRole("button", { name: `Collapse ${note.title}` });
    const link = screen.getByRole("link", { name: note.title });
    expect(disclosure).not.toContainElement(link);
    expect(disclosure).toHaveClass("size-11");
    expect(disclosure.closest("li")).toHaveAttribute("role", "treeitem");
    await user.keyboard("{Tab}");
    disclosure.focus();
    await user.keyboard("{ArrowLeft}");
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
  });

  it("requires explicit destructive confirmation and restores focus when canceled", async () => {
    const user = userEvent.setup();
    const remove = vi.fn();
    render(
      <NoteLifecycleActions
        note={note}
        pending={false}
        onTrash={remove}
        onRestore={vi.fn()}
        onPermanentDelete={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Move to trash/u });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: /Move .* to trash/u })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(trigger).toHaveFocus();
    expect(remove).not.toHaveBeenCalled();
  });

  it("requires the exact title before permanent deletion", async () => {
    const user = userEvent.setup();
    const permanentlyDelete = vi.fn();
    render(
      <NoteLifecycleActions
        note={{ ...note, isDeleted: true, deletedAt: note.updatedAt }}
        pending={false}
        onTrash={vi.fn()}
        onRestore={vi.fn()}
        onPermanentDelete={permanentlyDelete}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));
    const dialog = screen.getByRole("dialog", { name: /Permanently delete/u });
    const confirm = within(dialog).getByRole("button", { name: "Delete permanently" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Note title"), note.title);
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(permanentlyDelete).toHaveBeenCalledTimes(1);
  });

  it("labels the copied link as authenticated-only and shows finite loading states", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    render(
      providers(
        <ShareModal
          workspaceId={workspaceId}
          noteId={note.id}
          internalPath={`/workspaces/${workspaceId}/notes/${note.id}`}
          currentActorId={note.id}
        />,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(screen.getByText(/Requires Notted access/u)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Loading authorized workspace members/u);
    expect(screen.getByText(/not a public link/iu)).toBeInTheDocument();
  });
});
