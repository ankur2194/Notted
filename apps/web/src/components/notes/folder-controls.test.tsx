import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createFolder: vi.fn(),
  updateFolder: vi.fn(),
  deleteFolder: vi.fn(),
}));
vi.mock("@/lib/notes/requests", () => mocks);

import { FolderControls } from "./FolderControls";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const root = {
  id: "30000000-0000-4000-8000-000000000002",
  workspaceId,
  parentId: null,
  name: "Root",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};
const child = {
  ...root,
  id: "30000000-0000-4000-8000-000000000003",
  parentId: root.id,
  name: "Child",
};
const grandchild = {
  ...root,
  id: "30000000-0000-4000-8000-000000000004",
  parentId: child.id,
  name: "Grandchild",
};

function view(status = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FolderControls
        workspaceId={workspaceId}
        folders={[root, child, grandchild]}
        canDelete
        onStatus={status}
      />
    </QueryClientProvider>,
  );
  return status;
}

describe("FolderControls", () => {
  beforeEach(() => vi.clearAllMocks());

  it("disables depth-four destinations and supports rename rollback messaging", async () => {
    mocks.updateFolder.mockResolvedValue({ ok: false, kind: "unavailable" });
    const user = userEvent.setup();
    const status = view();
    await user.click(screen.getByRole("button", { name: "Create folder" }));
    expect(
      within(screen.getByRole("dialog")).getByRole("option", { name: /Grandchild · level 3/u }),
    ).toBeDisabled();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    const rootItem = screen.getByText("Root").closest("li")!;
    await user.click(within(rootItem).getByRole("button", { name: "Rename" }));
    await user.clear(within(rootItem).getByLabelText("New folder name"));
    await user.type(within(rootItem).getByLabelText("New folder name"), "Changed");
    await user.click(within(rootItem).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(status).toHaveBeenCalledWith(expect.stringContaining("previous name was kept")),
    );
  });

  it("confirms deletion, explains unfiling, and moves focus to a stable heading after success", async () => {
    mocks.deleteFolder.mockResolvedValue({
      ok: true,
      data: { id: root.id, deleted: true, removedFolders: 3, unfiledNotes: 2 },
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const user = userEvent.setup();
    view();
    const rootItem = screen.getByText("Root").closest("li")!;
    await user.click(within(rootItem).getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(/keeps their notes as unfiled/u);
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete folder" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Standalone folders" })).toHaveFocus(),
    );
  });
});
