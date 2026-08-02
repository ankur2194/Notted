import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestWorkspaceMembers: vi.fn(),
  requestNoteShares: vi.fn(),
  upsertNoteShare: vi.fn(),
  revokeNoteShare: vi.fn(),
}));
vi.mock("@/lib/notes/requests", () => mocks);

import { ShareModal } from "./ShareModal";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const noteId = "30000000-0000-4000-8000-000000000002";
const userId = "30000000-0000-4000-8000-000000000003";
const actorId = "30000000-0000-4000-8000-000000000004";

let mockWriteText: ReturnType<typeof vi.fn>;

function view() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ShareModal
        workspaceId={workspaceId}
        noteId={noteId}
        internalPath={`/workspaces/${workspaceId}/notes/${noteId}`}
        currentActorId={actorId}
      />
    </QueryClientProvider>,
  );
}

describe("ShareModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestWorkspaceMembers.mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            id: actorId,
            userId: actorId,
            workspaceId,
            name: "Current actor",
            email: "actor@example.test",
            role: "owner",
            joinedAt: "2026-08-01T00:00:00.000Z",
          },
          {
            id: userId,
            userId,
            workspaceId,
            name: "Workspace editor",
            email: "editor@example.test",
            role: "editor",
            joinedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        page: 1,
        limit: 100,
        hasMore: false,
      },
    });
    mocks.requestNoteShares.mockResolvedValue({ ok: true, data: { items: [] } });

    mockWriteText = vi.fn().mockResolvedValue(undefined);
  });

  it("loads only the workspace member endpoint, grants view/edit, copies an authenticated link, and revokes", async () => {
    const user = userEvent.setup();
    // userEvent.setup() attaches its own clipboard stub to the real jsdom
    // navigator (the object the component module sees), so the mock must be
    // installed after setup() and on `window.navigator` itself. Replacing the
    // `navigator` global binding (e.g. vi.stubGlobal) only affects the test
    // file's populated global and never reaches the component.
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: mockWriteText },
      configurable: true,
      writable: true,
    });
    mocks.upsertNoteShare.mockResolvedValue({
      ok: true,
      data: {
        share: {
          id: userId,
          noteId,
          userId,
          permission: "edit",
          createdAt: "2026-08-01T00:00:00.000Z",
        },
      },
    });
    mocks.revokeNoteShare.mockResolvedValue({ ok: true, data: { noteId, userId, revoked: true } });
    view();
    await user.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByRole("option", { name: /Workspace editor/u })).toBeVisible();
    expect(screen.queryByRole("option", { name: /Current actor/u })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Workspace member"), userId);
    await user.selectOptions(screen.getByLabelText("Permission"), "edit");
    await user.click(screen.getByRole("button", { name: "Grant access" }));
    expect(mocks.upsertNoteShare).toHaveBeenCalledWith(workspaceId, noteId, userId, {
      permission: "edit",
    });
    const current = await screen.findByText("Workspace editor");
    await user.click(within(current.closest("li")!).getByRole("button", { name: "Revoke" }));
    expect(mocks.revokeNoteShare).toHaveBeenCalledWith(workspaceId, noteId, userId);
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(mockWriteText).toHaveBeenCalledWith(
      expect.stringContaining(`/workspaces/${workspaceId}/notes/${noteId}`),
    );
    expect(screen.getByText(/Requires Notted access/u)).toBeVisible();
  });

  it("renders existing comment grants without offering comment for new grants", async () => {
    mocks.requestNoteShares.mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            id: userId,
            noteId,
            userId,
            permission: "comment",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      },
    });
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByText(/Comment \(existing grant/u)).toBeVisible();
    expect(screen.getByLabelText(/Permission for Workspace editor/u)).toBeDisabled();
  });
});
