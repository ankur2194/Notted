import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MyTasksWidget } from "./MyTasksWidget";

import type { TaskPage, TaskSummary } from "@notted/shared-types";

const mocks = vi.hoisted(() => ({
  requestTaskPage: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock("@/lib/tasks/requests", () => ({
  requestTaskPage: mocks.requestTaskPage,
  updateTask: mocks.updateTask,
}));

const workspaceId = "50000000-0000-4000-8000-000000000001";
const assigneeId = "50000000-0000-4000-8000-000000000002";
const noteId = "50000000-0000-4000-8000-000000000003";

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
    assigneeId,
    dueDate: null,
    completedAt: null,
    sortOrder: 1,
    recurrence: "none",
    recurrenceCron: null,
    tagIds: [],
    createdById: assigneeId,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

// Long past, so overdue holds against the real browser clock the widget reads.
const late = task("50000000-0000-4000-8000-00000000000a", "Ship the release", {
  dueDate: "2020-01-01T09:00:00.000Z",
});
const later = task("50000000-0000-4000-8000-00000000000b", "Write the changelog");
const page: TaskPage = { items: [late, later], page: 1, limit: 20, hasMore: false };
const empty: TaskPage = { items: [], page: 1, limit: 20, hasMore: false };

function view(
  { canEdit = true, workspace = workspaceId as string | null } = {},
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={client}>
      <MyTasksWidget workspaceId={workspace} assigneeId={assigneeId} canEdit={canEdit} />
    </QueryClientProvider>,
  );
}

describe("MyTasksWidget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestTaskPage.mockResolvedValue({ ok: true, data: page });
    mocks.updateTask.mockResolvedValue({ ok: true, data: { task: late, spawned: null } });
  });

  it("renders nothing at all when no workspace is selected", () => {
    const { container } = view({ workspace: null });
    expect(container).toBeEmptyDOMElement();
    expect(mocks.requestTaskPage).not.toHaveBeenCalled();
  });

  it("shows a loading state and then the viewer's own open tasks, soonest due first", async () => {
    let settle!: (value: unknown) => void;
    mocks.requestTaskPage.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    view();

    expect(screen.getByText("Loading your tasks…")).toBeVisible();

    settle({ ok: true, data: page });
    expect(await screen.findByRole("link", { name: "Ship the release" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Write the changelog" })).toBeVisible();
    // Only open tasks, assigned to this viewer, soonest due first.
    expect(mocks.requestTaskPage).toHaveBeenCalledWith(workspaceId, {
      page: 1,
      limit: 20,
      assigneeId,
      isCompleted: false,
      grouping: "none",
      sortBy: "dueDate",
      sortDirection: "asc",
    });
  });

  it("says an overdue task is overdue in words, not by colour alone", async () => {
    view();
    const rows = await screen.findAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Overdue");
    expect(rows[1]).not.toHaveTextContent("Overdue");
  });

  it("states an empty assignment list rather than implying a failure", async () => {
    mocks.requestTaskPage.mockResolvedValue({ ok: true, data: empty });
    view();
    expect(await screen.findByText("Nothing is assigned to you right now.")).toBeVisible();
    expect(screen.queryByRole("list", { name: "My open tasks" })).not.toBeInTheDocument();
  });

  it("offers a retry that recovers from an unreachable API, and hints at being offline", async () => {
    const user = userEvent.setup();
    mocks.requestTaskPage.mockResolvedValue({ ok: false, kind: "unavailable" });
    view();

    expect(await screen.findByRole("alert")).toHaveTextContent(/may be offline/iu);

    mocks.requestTaskPage.mockResolvedValue({ ok: true, data: page });
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link", { name: "Ship the release" })).toBeVisible();
  });

  it("explains a denied read without offering a retry that can only fail again", async () => {
    mocks.requestTaskPage.mockResolvedValue({ ok: false, kind: "forbidden-or-not-found" });
    view();
    expect(await screen.findByRole("alert")).toHaveTextContent(/do not have permission/iu);
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("offers no completion control without permission to change tasks", async () => {
    view({ canEdit: false });
    expect(await screen.findByRole("note")).toHaveTextContent(/cannot change them/iu);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  /**
   * The single prefix invalidation is the whole cross-view consistency
   * contract: the list, board and calendar views hang off the same
   * `taskQueryKeys.all` root, so losing it is how two surfaces start disagreeing
   * about whether a task is done.
   */
  it("completes a task and invalidates the whole workspace task root", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    view({}, client);

    await user.click(await screen.findByRole("checkbox", { name: "Complete Ship the release" }));

    expect(mocks.updateTask).toHaveBeenCalledWith(workspaceId, late.id, { status: "done" });
    expect(await screen.findByText("“Ship the release” is complete.")).toBeVisible();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tasks", workspaceId] });
  });

  it("reports a failed completion instead of claiming the task changed", async () => {
    const user = userEvent.setup();
    mocks.updateTask.mockResolvedValue({ ok: false, kind: "forbidden-or-not-found" });
    view();

    await user.click(await screen.findByRole("checkbox", { name: "Complete Ship the release" }));

    expect(
      await screen.findByText(/was denied or the task is no longer available/iu),
    ).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Complete Ship the release" })).not.toBeChecked();
  });
});
