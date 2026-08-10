import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TaskListView } from "./TaskListView";

import type { TaskPage, TaskSummary } from "@notted/shared-types";

const mocks = vi.hoisted(() => ({
  requestTaskPage: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  reorderTask: vi.fn(),
  deleteTask: vi.fn(),
  bulkUpdateTasks: vi.fn(),
  refresh: vi.fn(),
  requestTagPage: vi.fn(),
  fetchWorkspaceMemberDirectory: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/tasks/requests", () => ({
  requestTaskPage: mocks.requestTaskPage,
  createTask: mocks.createTask,
  updateTask: mocks.updateTask,
  reorderTask: mocks.reorderTask,
  deleteTask: mocks.deleteTask,
  bulkUpdateTasks: mocks.bulkUpdateTasks,
}));
vi.mock("@/lib/tags/requests", () => ({ requestTagPage: mocks.requestTagPage }));
vi.mock("@/lib/notes/member-directory", () => ({
  fetchWorkspaceMemberDirectory: mocks.fetchWorkspaceMemberDirectory,
}));

const workspaceId = "40000000-0000-4000-8000-000000000001";
const noteId = "40000000-0000-4000-8000-000000000002";

function task(id: string, title: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id,
    workspaceId,
    projectId: null,
    noteId,
    parentId: null,
    title,
    status: "todo",
    customStatusId: null,
    statusLabel: null,
    priority: "medium",
    assigneeId: null,
    dueDate: null,
    completedAt: null,
    sortOrder: 1,
    recurrence: "none",
    recurrenceCron: null,
    tagIds: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

const alpha = task("40000000-0000-4000-8000-00000000000a", "Alpha", {
  // Long past, so overdue holds against the real browser clock.
  dueDate: "2020-01-01T09:00:00.000Z",
  sortOrder: 1,
});
const beta = task("40000000-0000-4000-8000-00000000000b", "Beta", {
  status: "in_progress",
  sortOrder: 2,
});
const gamma = task("40000000-0000-4000-8000-00000000000c", "Gamma", {
  status: "done",
  completedAt: "2026-08-02T00:00:00.000Z",
  sortOrder: 3,
});
const page: TaskPage = { items: [alpha, beta, gamma], page: 1, limit: 100, hasMore: false };

function view(initial: TaskPage = page, canEdit = true) {
  const client = new QueryClient({
    // `initialData` plus an infinite stale time keeps the mount refetch from
    // racing the optimistic writes each test is asserting on.
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TaskListView
        workspaceId={workspaceId}
        noteId={noteId}
        projectId={null}
        initialTasks={initial}
        canEdit={canEdit}
      />
    </QueryClientProvider>,
  );
}

describe("TaskListView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestTaskPage.mockResolvedValue({ ok: true, data: page });
    mocks.requestTagPage.mockResolvedValue({
      ok: true,
      data: { items: [], page: 1, limit: 100, hasMore: false },
    });
    mocks.fetchWorkspaceMemberDirectory.mockResolvedValue({
      items: [],
      page: 1,
      limit: 100,
      hasMore: false,
    });
  });

  it("renders one labelled group per occupied status and omits the empty ones", async () => {
    view();
    await userEvent.selectOptions(screen.getByLabelText("Group tasks by"), "status");

    expect(screen.getByRole("heading", { level: 3, name: "To do (1)" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 3, name: "In progress (1)" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 3, name: "Done (1)" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: /^Canceled/u })).not.toBeInTheDocument();

    expect(
      within(screen.getByRole("list", { name: "To do (1)" })).getByDisplayValue("Alpha"),
    ).toBeVisible();
    expect(
      within(screen.getByRole("list", { name: "Done (1)" })).getByDisplayValue("Gamma"),
    ).toBeVisible();
  });

  it("moves a task between groups as soon as it is completed", async () => {
    const user = userEvent.setup();
    mocks.updateTask.mockReturnValue(new Promise(() => undefined));
    view();
    await user.selectOptions(screen.getByLabelText("Group tasks by"), "status");
    await user.click(screen.getByRole("checkbox", { name: "Complete Alpha" }));

    expect(screen.queryByRole("heading", { name: "To do (1)" })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "Done (2)" })).getByDisplayValue("Alpha"),
    ).toBeVisible();
  });

  it("says the word Overdue on a past-due open task and not on a completed one", () => {
    view();
    const overdue = screen.getAllByText("Overdue");
    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toBeVisible();
  });

  it("applies one bulk request to every selected row and restores all of them on failure", async () => {
    const user = userEvent.setup();
    let settle!: (value: unknown) => void;
    mocks.bulkUpdateTasks.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    view();

    await user.click(screen.getByRole("checkbox", { name: "Select all tasks" }));
    expect(screen.getByText("3 of 3 tasks selected")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Mark complete" }));
    expect(mocks.bulkUpdateTasks).toHaveBeenCalledTimes(1);
    // The third argument is the required `Idempotency-Key`; the controller
    // rejects a bulk request without one, so its absence is a real defect.
    expect(mocks.bulkUpdateTasks).toHaveBeenCalledWith(
      workspaceId,
      { taskIds: [alpha.id, beta.id, gamma.id], action: { kind: "status", status: "done" } },
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
    );
    for (const box of screen.getAllByRole("checkbox", { name: /^Complete / })) {
      expect(box).toBeChecked();
    }
    // The optimistic completion clears the overdue state too, since a closed
    // task is never overdue.
    expect(screen.queryByText("Overdue")).not.toBeInTheDocument();

    settle({ ok: false, kind: "unavailable" });
    expect(await screen.findByText(/previous list was restored/iu)).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Complete Alpha" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Complete Beta" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Complete Gamma" })).toBeChecked();
    expect(screen.getByText("Overdue")).toBeVisible();
  });

  it("reports a partly skipped bulk change instead of claiming every task changed", async () => {
    const user = userEvent.setup();
    mocks.bulkUpdateTasks.mockResolvedValue({
      ok: true,
      data: {
        updated: [alpha.id],
        skipped: [{ taskId: beta.id, reason: "unavailable" }],
        affected: 1,
      },
    });
    view({ items: [alpha, beta], page: 1, limit: 100, hasMore: false });

    await user.click(screen.getByRole("checkbox", { name: "Select all tasks" }));
    await user.click(screen.getByRole("button", { name: "Mark complete" }));

    expect(
      await screen.findByText(/1 of 2 tasks changed, 1 unavailable and left unchanged/iu),
    ).toBeVisible();
  });

  it("says a replayed bulk change was already applied instead of claiming it changed rows", async () => {
    const user = userEvent.setup();
    // `applyBulk` returns the authorized count for every non-delete action, so
    // `affected: 0` alongside a non-empty `updated` is the idempotent replay of
    // a batch that already landed. This call wrote nothing.
    mocks.bulkUpdateTasks.mockResolvedValue({
      ok: true,
      data: { updated: [alpha.id, beta.id], skipped: [], affected: 0 },
    });
    view({ items: [alpha, beta], page: 1, limit: 100, hasMore: false });

    await user.click(screen.getByRole("checkbox", { name: "Select all tasks" }));
    await user.click(screen.getByRole("button", { name: "Mark complete" }));

    // dnd-kit mounts its own `role="status"` live region, so the assertion
    // targets the narrative text rather than the role.
    expect(await screen.findByText(/already applied/iu)).toBeVisible();
    expect(screen.queryByText(/2 of 2 tasks changed/iu)).not.toBeInTheDocument();
  });

  /**
   * The cascade is the whole point: `tasks` deletes through its self parent FK,
   * so a user selecting one parent destroys its whole subtree. A confirmation
   * that named only the selection would understate that, and the report
   * afterwards has to use the server's true count rather than the click count.
   */
  it("names the cascaded subtasks before deleting and reports the true total after", async () => {
    const user = userEvent.setup();
    const child = task("40000000-0000-4000-8000-00000000000d", "Child", {
      parentId: alpha.id,
      sortOrder: 4,
    });
    const grandchild = task("40000000-0000-4000-8000-00000000000e", "Grandchild", {
      parentId: child.id,
      sortOrder: 5,
    });
    const nested: TaskPage = {
      items: [alpha, child, grandchild],
      page: 1,
      limit: 100,
      hasMore: false,
    };
    mocks.requestTaskPage.mockResolvedValue({ ok: true, data: nested });
    mocks.bulkUpdateTasks.mockResolvedValue({
      ok: true,
      data: { updated: [alpha.id], skipped: [], affected: 3 },
    });
    view(nested);

    await user.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    await user.click(screen.getByRole("button", { name: "Delete selected" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/at least 2 subtasks/iu)).toBeVisible();
    expect(within(dialog).getByText(/at least 3 tasks in total/iu)).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(mocks.bulkUpdateTasks).toHaveBeenCalledWith(
      workspaceId,
      { taskIds: [alpha.id], action: { kind: "delete" } },
      expect.any(String),
    );
    expect(await screen.findByText(/3 rows removed including subtasks/iu)).toBeVisible();
  });

  it("offers no editing affordances without permission", () => {
    view(page, false);
    expect(screen.getByRole("note")).toHaveTextContent(/cannot change them/iu);
    expect(screen.queryByRole("toolbar", { name: "Bulk task actions" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("New task")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Title for Alpha")).toBeDisabled();
  });

  it("adds an optimistic row and restores the list when creation fails", async () => {
    const user = userEvent.setup();
    let settle!: (value: unknown) => void;
    mocks.createTask.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    view();

    await user.type(screen.getByLabelText("New task"), "Delta");
    await user.click(screen.getByRole("button", { name: "Add task" }));
    expect(screen.getByLabelText("Title for Delta")).toBeVisible();
    // `projectId` is load-bearing, not cosmetic: the server requires
    // `note.projectId === task.projectId`, so omitting it 404s every create on
    // a project-scoped task-list note.
    expect(mocks.createTask).toHaveBeenCalledWith(
      workspaceId,
      { noteId, projectId: null, title: "Delta" },
      expect.any(String),
    );

    settle({ ok: false, kind: "unavailable" });
    expect(await screen.findByText(/previous list was restored/iu)).toBeVisible();
    expect(screen.queryByLabelText("Title for Delta")).not.toBeInTheDocument();
  });
});
