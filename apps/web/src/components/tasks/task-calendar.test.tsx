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
  requestTaskStatuses: vi.fn(),
  createTaskStatus: vi.fn(),
  updateTaskStatus: vi.fn(),
  deleteTaskStatus: vi.fn(),
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
  requestTaskStatuses: mocks.requestTaskStatuses,
  createTaskStatus: mocks.createTaskStatus,
  updateTaskStatus: mocks.updateTaskStatus,
  deleteTaskStatus: mocks.deleteTaskStatus,
}));
vi.mock("@/lib/tags/requests", () => ({ requestTagPage: mocks.requestTagPage }));
vi.mock("@/lib/notes/member-directory", () => ({
  fetchWorkspaceMemberDirectory: mocks.fetchWorkspaceMemberDirectory,
}));

const workspaceId = "40000000-0000-4000-8000-000000000001";
const noteId = "40000000-0000-4000-8000-000000000002";
const creatorId = "40000000-0000-4000-8000-0000000000c1";

/*
 * Every fixture date is anchored on the day the test runs, because the calendar
 * opens on the viewer's current month. Today's cell is the one cell guaranteed
 * to be in a 42-day grid whatever the date is.
 */
const today = new Date();
const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
const monthName = (offset: number): string =>
  new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
    new Date(today.getFullYear(), today.getMonth() + offset, 1),
  );

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
    createdById: creatorId,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Local midnight today: already past by the time the component reads the clock. */
const overdue = task("40000000-0000-4000-8000-00000000000a", "Alpha", {
  dueDate: startOfToday.toISOString(),
});
/*
 * Same day, but closed — a completed task is never overdue however its due date
 * compares to the clock, which keeps the "Overdue" count independent of the
 * hour the suite happens to run at.
 */
const done = task("40000000-0000-4000-8000-00000000000b", "Beta", {
  dueDate: startOfToday.toISOString(),
  status: "done",
  completedAt: startOfToday.toISOString(),
});
const undated = task("40000000-0000-4000-8000-00000000000c", "Gamma");

const page: TaskPage = { items: [overdue, done, undated], page: 1, limit: 100, hasMore: false };

function view(initial: TaskPage = page) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TaskListView
        workspaceId={workspaceId}
        noteId={noteId}
        projectId={null}
        initialTasks={initial}
        canEdit
        viewer={{ userId: creatorId, role: "owner" }}
      />
    </QueryClientProvider>,
  );
}

async function openCalendar(initial: TaskPage = page) {
  const user = userEvent.setup();
  view(initial);
  await user.click(screen.getByRole("button", { name: "Calendar" }));
  return user;
}

describe("TaskCalendar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
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

  it("lays out six weeks of day cells and puts each task on its own day", async () => {
    await openCalendar();

    const todayCell = screen.getByText("(Today)").closest("li")!;
    const grid = todayCell.closest("ul")!;
    expect(grid.children).toHaveLength(42);
    expect(within(todayCell).getByText("Alpha")).toBeVisible();
    expect(within(todayCell).getByText("Beta")).toBeVisible();
    expect(within(todayCell).queryByText("Gamma")).not.toBeInTheDocument();
  });

  it("says the word Overdue rather than relying on colour", async () => {
    await openCalendar();

    const overdueLabels = screen.getAllByText("Overdue");
    expect(overdueLabels).toHaveLength(1);
    expect(overdueLabels[0]).toBeVisible();
  });

  it("lists undated tasks in their own labelled section instead of dropping them", async () => {
    await openCalendar();

    const section = screen.getByRole("list", { name: "No due date (1)" });
    expect(within(section).getByText("Gamma")).toBeVisible();
  });

  it("navigates months without issuing a request while the page is complete", async () => {
    const user = await openCalendar();
    expect(screen.getByRole("heading", { level: 3, name: monthName(0) })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByRole("heading", { level: 3, name: monthName(1) })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByRole("heading", { level: 3, name: monthName(-1) })).toBeVisible();

    // The whole point of sharing the list view's cache entry: navigating a
    // complete page is pure arithmetic.
    expect(mocks.requestTaskPage).not.toHaveBeenCalled();
  });

  it("windows the visible month only when the shared page is truncated", async () => {
    const truncated: TaskPage = { ...page, hasMore: true };
    mocks.requestTaskPage.mockResolvedValue({ ok: true, data: truncated });
    await openCalendar(truncated);

    expect(mocks.requestTaskPage).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({
        noteId,
        // Both bounds are composed from local day keys, never by appending "Z".
        dueFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        dueTo: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      }),
    );
    expect(await screen.findByText(/this month is loaded on its own/iu)).toBeVisible();
  });
});
