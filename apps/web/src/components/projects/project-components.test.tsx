import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectDetail } from "@notted/shared-types";

import { CreateProjectModal } from "@/components/projects/CreateProjectModal";
import { ProjectCollection } from "@/components/projects/ProjectCollection";
import { ProjectLifecycleActions } from "@/components/projects/ProjectLifecycleActions";
import { createProject } from "@/lib/projects/requests";

const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/projects/requests", () => ({
  createProject: vi.fn(),
  updateProject: vi.fn(),
  transitionProject: vi.fn(),
  deleteProject: vi.fn(),
}));

const project = {
  id: "30000000-0000-4000-8000-000000000002",
  workspaceId: "30000000-0000-4000-8000-000000000001",
  name: "Launch",
  description: "Plan the launch",
  coverImageUrl: "/api/v1/attachments/30000000-0000-4000-8000-000000000004",
  color: "#3b82f6",
  status: "active",
  isArchived: false,
  isRestricted: false,
  dueAt: "2026-08-10T00:00:00.000Z",
  createdById: "30000000-0000-4000-8000-000000000003",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  lastActivityAt: "2026-08-03T00:00:00.000Z",
  members: [],
  taskProgress: { coverage: "tasks-and-checklists", completed: 1, total: 2 },
} satisfies ProjectDetail;

describe("project components", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("switches between semantic grid/list views and isolates the stored workspace preference", async () => {
    const user = userEvent.setup();
    render(<ProjectCollection workspaceId={project.workspaceId} projects={[project]} />);
    expect(screen.getByRole("list", { name: "Projects grid" })).toBeVisible();
    expect(screen.getByText("Cover attached")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByRole("list", { name: "Projects compact list" })).toBeVisible();
    expect(window.localStorage.getItem(`notted:projects:view:${project.workspaceId}`)).toBe("list");
  });

  it("reuses the idempotency key for an unchanged failed create submission", async () => {
    const user = userEvent.setup();
    vi.mocked(createProject).mockResolvedValue({ ok: false, kind: "unavailable" });
    render(<CreateProjectModal workspaceId={project.workspaceId} />);
    await user.click(screen.getByRole("button", { name: "Create project" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Project name"), "Launch");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await screen.findByRole("alert");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createProject).mock.calls[1]?.[2]).toBe(
      vi.mocked(createProject).mock.calls[0]?.[2],
    );
  });

  it("presents role limits and returns focus after canceling confirmed delete", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ProjectLifecycleActions project={project} canManage={false} />);
    expect(screen.getByRole("note")).toHaveTextContent(/not shown for your workspace role/i);
    rerender(<ProjectLifecycleActions project={project} canManage />);
    const trigger = screen.getByRole("button", { name: "Delete project" });
    await user.click(trigger);
    expect(screen.getByRole("button", { name: "Permanently delete" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
