import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VersionHistory } from "./VersionHistory";

import type { NoteDocument } from "@notted/shared-types";
import type { ComponentProps } from "react";

const refresh = vi.fn();
const requestNoteDetail = vi.fn();
const requestNoteVersions = vi.fn();
const requestNoteVersion = vi.fn();
const restoreNoteVersion = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/notes/requests", () => ({
  requestNoteDetail: (...args: unknown[]) => requestNoteDetail(...args),
  requestNoteVersions: (...args: unknown[]) => requestNoteVersions(...args),
  requestNoteVersion: (...args: unknown[]) => requestNoteVersion(...args),
  restoreNoteVersion: (...args: unknown[]) => restoreNoteVersion(...args),
}));
vi.mock("./NoteEditorSurface", () => ({
  NoteEditorSurface: (props: { editable: boolean; bindToNoteSave: boolean; ariaLabel: string }) => (
    <div
      data-testid="historical-preview"
      data-editable={props.editable}
      data-save={props.bindToNoteSave}
    >
      {props.ariaLabel}
    </div>
  ),
}));

const workspaceId = "30000000-0000-4000-8000-000000000001";
const noteId = "30000000-0000-4000-8000-000000000002";
const versionId = "30000000-0000-4000-8000-000000000003";
const currentDocument = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "After text" }] }],
} as NoteDocument;
const summary = {
  id: versionId,
  version: 1,
  title: "Historical title",
  author: { id: "30000000-0000-4000-8000-000000000004", name: "Ada" },
  createdAt: "2026-08-01T12:00:00.000Z",
  isCurrent: false,
};
const historical = {
  ...summary,
  content: {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Before text" }] }],
  } as NoteDocument,
};

function renderHistory(overrides: Partial<ComponentProps<typeof VersionHistory>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <VersionHistory
        workspaceId={workspaceId}
        noteId={noteId}
        currentVersion={2}
        currentDocument={currentDocument}
        canRestore
        {...overrides}
      />
    </QueryClientProvider>,
  );
  return { queryClient, invalidate };
}

describe("VersionHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestNoteVersions.mockResolvedValue({
      ok: true,
      data: { items: [summary], hasMore: false, nextCursor: null },
    });
    requestNoteVersion.mockResolvedValue({ ok: true, data: historical });
    // The server is the owner of `notes.content`; by default it agrees with the
    // prop so every other test reads exactly as it did before.
    requestNoteDetail.mockResolvedValue({ ok: true, data: { content: currentDocument } });
    restoreNoteVersion.mockResolvedValue({ ok: false, kind: "conflict" });
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
  });

  it("renders loading, empty, error, retry, and permission states", async () => {
    let resolveHistory!: (value: unknown) => void;
    requestNoteVersions.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveHistory = resolve;
      }),
    );
    renderHistory({ canRestore: false });
    await userEvent.click(screen.getByRole("button", { name: "Version history" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading versions");
    resolveHistory({ ok: true, data: { items: [], hasMore: false, nextCursor: null } });
    expect(await screen.findByText(/No retained versions/u)).toBeVisible();

    requestNoteVersions.mockResolvedValueOnce({ ok: false, kind: "forbidden-or-not-found" });
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: "Version history" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/permission/u);
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("labels version, author, time and semantic before/after screen-reader summary", async () => {
    renderHistory();
    await userEvent.click(screen.getByRole("button", { name: "Version history" }));
    await userEvent.click(await screen.findByRole("button", { name: /Version 1/u }));
    expect(
      await screen.findByRole("heading", { name: /Version 1: Historical title/u }),
    ).toBeVisible();
    expect(screen.getByText(/Ada/u)).toBeVisible();
    expect(screen.getByLabelText("Before — selected version")).toBeVisible();
    expect(screen.getByLabelText("After — current version")).toBeVisible();
    expect(
      screen.getByText(/Comparison contains 1 additions and 1 deletions/u),
    ).toBeInTheDocument();
    expect(screen.getByTestId("historical-preview")).toHaveAttribute("data-editable", "false");
    expect(screen.getByTestId("historical-preview")).toHaveAttribute("data-save", "false");
  });

  it("returns focus to the trigger on Escape and keeps the dialog width bounded", async () => {
    renderHistory();
    const trigger = screen.getByRole("button", { name: "Version history" });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Version history" });
    expect(dialog).toHaveClass("max-w-6xl", "overflow-hidden");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it.each(["dirty", "saving", "retrying", "offline", "conflict"] as const)(
    "blocks restore while autosave is %s",
    async (saveStatus) => {
      renderHistory({ saveStatus });
      await userEvent.click(screen.getByRole("button", { name: "Version history" }));
      await userEvent.click(await screen.findByRole("button", { name: /Version 1/u }));
      expect(await screen.findByRole("button", { name: "Restore this version" })).toBeDisabled();
      expect(screen.getByText(/Finish or resolve autosave/u)).toBeVisible();
    },
  );

  it("diffs against the server's current content, not the document this tab last saved", async () => {
    // A peer edited the note after this page loaded. In a collaborative session
    // the server's Yjs projection owns `notes.content`, so `currentDocument` —
    // whatever THIS tab last saved — describes a document nobody has.
    requestNoteDetail.mockResolvedValue({
      ok: true,
      data: {
        content: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Peer text" }] }],
        },
      },
    });
    renderHistory();
    await userEvent.click(screen.getByRole("button", { name: "Version history" }));
    await userEvent.click(await screen.findByRole("button", { name: /Version 1/u }));

    // Segments carry an sr-only kind prefix, so the assertion is on those.
    const after = await screen.findByLabelText("After — current version");
    await waitFor(() => expect(after).toHaveTextContent(/Added: Peer/u));
    expect(after).not.toHaveTextContent(/Added: After/u);
  });

  it("refuses restore while the collaborative session still holds unsent updates", async () => {
    // Unsent Yjs updates never reach React state, so `saveStatus` is "idle" and
    // the button renders enabled. The guard has to be re-asked on the click.
    renderHistory({ saveStatus: "idle", hasUnacknowledgedWork: () => true });
    await userEvent.click(screen.getByRole("button", { name: "Version history" }));
    await userEvent.click(await screen.findByRole("button", { name: /Version 1/u }));

    const restore = await screen.findByRole("button", { name: "Restore this version" });
    expect(restore).toBeEnabled();
    await userEvent.click(restore);

    expect(restoreNoteVersion).not.toHaveBeenCalled();
    expect(screen.getByText(/have not been saved/u)).toBeInTheDocument();
  });

  it("announces conflicts without refreshing, then refreshes caches/router after success", async () => {
    const { invalidate } = renderHistory();
    await userEvent.click(screen.getByRole("button", { name: "Version history" }));
    await userEvent.click(await screen.findByRole("button", { name: /Version 1/u }));
    await userEvent.click(await screen.findByRole("button", { name: "Restore this version" }));
    expect(await screen.findByText(/Restore conflicted/u)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();

    restoreNoteVersion.mockResolvedValueOnce({ ok: true, data: { note: { version: 3 } } });
    await userEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["notes", workspaceId] }),
    );
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getByText(/restored as new version 3/u)).toBeInTheDocument();
  });
});
