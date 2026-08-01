import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceDetail } from "@notted/shared-types";

import { WorkspaceSettings } from "@/components/workspaces/WorkspaceSettings";
import { deleteWorkspace, updateWorkspace } from "@/lib/workspaces/requests";

const { router } = vi.hoisted(() => ({
  router: { replace: vi.fn(), refresh: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/workspaces/requests", () => ({
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

const workspace = {
  id: "30000000-0000-4000-8000-000000000001",
  name: "Acme Design",
  slug: "acme-design",
  description: "Brand workspace",
  plan: "pro",
  currentUserRole: "owner",
  logoUrl: null,
  domain: null,
  settings: { defaultPageSize: "a4" },
  storageLimitBytes: 1_073_741_824,
  createdById: "10000000-0000-4000-8000-000000000001",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
} satisfies WorkspaceDetail;

describe("WorkspaceSettings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves an identity rename and refreshes from the response", async () => {
    const user = userEvent.setup();
    vi.mocked(updateWorkspace).mockResolvedValue({
      ok: true,
      data: {
        workspace: {
          ...workspace,
          name: "Acme Design Co",
          slug: "acme-design-co",
          updatedAt: "2026-08-01T01:00:00.000Z",
        },
      },
    });
    render(<WorkspaceSettings workspace={workspace} canManage={true} canDelete={true} />);

    const nameField = screen.getByLabelText("Workspace name");
    await user.clear(nameField);
    await user.type(nameField, "Acme Design Co");

    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).not.toBeDisabled();
    await user.click(save);

    await waitFor(() => expect(updateWorkspace).toHaveBeenCalledTimes(1));
    // Only the changed field is sent as a minimal diff.
    expect(updateWorkspace).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({ name: "Acme Design Co" }),
    );
    expect(await screen.findByText(/Saved at/i)).toBeVisible();
    expect(router.refresh).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled(),
    );
  });

  it("disables save when there are no changes and keeps the original values", () => {
    render(<WorkspaceSettings workspace={workspace} canManage={true} canDelete={true} />);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByLabelText("Slug")).toHaveValue("acme-design");
    expect(screen.getByLabelText("Default page size")).toHaveValue("a4");
    expect(screen.getByText("1 GiB")).toBeVisible();
    expect(screen.getByText("1,073,741,824 bytes")).toHaveClass("sr-only");
  });

  it("updates the real default page size with a nested settings patch", async () => {
    const user = userEvent.setup();
    vi.mocked(updateWorkspace).mockResolvedValue({
      ok: true,
      data: {
        workspace: {
          ...workspace,
          settings: { defaultPageSize: "letter" },
          updatedAt: "2026-08-01T01:00:00.000Z",
        },
      },
    });
    render(<WorkspaceSettings workspace={workspace} canManage={true} canDelete={true} />);

    await user.selectOptions(screen.getByLabelText("Default page size"), "letter");
    await user.click(screen.getByRole("button", { name: "Save page default" }));

    await waitFor(() =>
      expect(updateWorkspace).toHaveBeenCalledWith(workspace.id, {
        settings: { defaultPageSize: "letter" },
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(/settings saved at/i);
    expect(screen.getByLabelText("Default page size")).toHaveValue("letter");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("hides the destructive confirmation behind an exact name match", async () => {
    const user = userEvent.setup();
    vi.mocked(deleteWorkspace).mockResolvedValue({
      ok: true,
      data: { id: workspace.id, deleted: true },
    });
    render(<WorkspaceSettings workspace={workspace} canManage={true} canDelete={true} />);

    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    const confirmField = screen.getByLabelText(/Type the workspace name/i);
    expect(confirmField).toHaveFocus();

    // A wrong name keeps the confirm button disabled.
    await user.type(confirmField, "Wrong Name");
    expect(screen.getByRole("button", { name: "Permanently delete" })).toBeDisabled();
    expect(deleteWorkspace).not.toHaveBeenCalled();

    // The exact name unlocks confirmation.
    await user.clear(confirmField);
    await user.type(confirmField, workspace.name);
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));

    await waitFor(() =>
      expect(deleteWorkspace).toHaveBeenCalledWith(workspace.id, {
        confirm: true,
        expectedName: workspace.name,
      }),
    );
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/workspaces"));
    expect(router.refresh).toHaveBeenCalled();
  });

  it("restores focus to the delete trigger after cancellation", async () => {
    const user = userEvent.setup();
    render(<WorkspaceSettings workspace={workspace} canManage={true} canDelete={true} />);

    const trigger = screen.getByRole("button", { name: "Delete workspace" });
    await user.click(trigger);
    expect(screen.getByLabelText(/Type the workspace name/i)).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete workspace" })).toHaveFocus();
  });

  it("surfaces a denied delete without redirecting", async () => {
    const user = userEvent.setup();
    vi.mocked(deleteWorkspace).mockResolvedValue({ ok: false, kind: "forbidden" });
    render(<WorkspaceSettings workspace={workspace} canManage={true} canDelete={true} />);

    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    await user.type(screen.getByLabelText(/Type the workspace name/i), workspace.name);
    await user.click(screen.getByRole("button", { name: "Permanently delete" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/only the owner/i);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("disables editing and delete for a viewer and renders permission notes", () => {
    render(
      <WorkspaceSettings
        workspace={{ ...workspace, currentUserRole: "viewer", storageLimitBytes: null }}
        canManage={false}
        canDelete={false}
      />,
    );
    expect(screen.getByText(/owner or admin access to edit/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByText(/Only the workspace owner may delete/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Delete workspace" })).not.toBeInTheDocument();
    // Billing stays clearly disabled.
    expect(screen.getByRole("button", { name: "Manage billing" })).toBeDisabled();
    expect(screen.getByText(/Billing is not available/i)).toBeVisible();
    expect(screen.getByLabelText("Default page size")).toBeDisabled();
    expect(screen.getByLabelText("Default page size")).toHaveValue("a4");
    expect(screen.getByText(/Default page size is read-only/i)).toBeVisible();
    expect(screen.getByText("Plan-managed limit")).toBeVisible();
    expect(screen.getByRole("button", { name: "Replace logo" })).toBeDisabled();
  });
});
