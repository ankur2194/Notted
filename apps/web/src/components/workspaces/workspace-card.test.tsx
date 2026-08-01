import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceSummary } from "@notted/shared-types";

import { WorkspaceCard } from "@/components/workspaces/WorkspaceCard";
import { selectWorkspace } from "@/lib/shell/requests";

const { router } = vi.hoisted(() => ({
  router: { push: vi.fn(), refresh: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/shell/requests", () => ({ selectWorkspace: vi.fn() }));

const workspace = {
  id: "30000000-0000-4000-8000-000000000001",
  name: "Acme Design",
  slug: "acme-design",
  description: "Brand workspace",
  plan: "pro",
  currentUserRole: "editor",
  logoUrl: null,
  updatedAt: "2026-08-01T00:00:00.000Z",
} satisfies WorkspaceSummary;

describe("WorkspaceCard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("selects a workspace before navigating and refreshing the shell", async () => {
    const user = userEvent.setup();
    vi.mocked(selectWorkspace).mockResolvedValue({ ok: true, data: true });
    render(<WorkspaceCard workspace={workspace} />);

    await user.click(screen.getByRole("link", { name: "Open Acme Design workspace" }));

    expect(selectWorkspace).toHaveBeenCalledWith(workspace.id);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/workspaces/${workspace.id}`));
    expect(router.refresh).toHaveBeenCalled();
  });

  it("does not navigate when the active-workspace selection is denied", async () => {
    const user = userEvent.setup();
    vi.mocked(selectWorkspace).mockResolvedValue({ ok: false, kind: "forbidden" });
    render(<WorkspaceCard workspace={workspace} />);

    await user.click(screen.getByRole("link", { name: "Open Acme Design workspace" }));

    expect(await screen.findByRole("status")).toHaveTextContent(/could not switch workspaces/i);
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("opens an already-current workspace without rewriting the selection", async () => {
    const user = userEvent.setup();
    render(<WorkspaceCard workspace={workspace} currentWorkspaceId={workspace.id} />);

    await user.click(screen.getByRole("link", { name: "Open Acme Design workspace" }));

    expect(selectWorkspace).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith(`/workspaces/${workspace.id}`);
    expect(router.refresh).toHaveBeenCalled();
  });
});
