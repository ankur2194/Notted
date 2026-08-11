import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TaskListView } from "./TaskListView";

import type { CustomTaskStatus, TaskPage, TaskSummary } from "@notted/shared-types";

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
const ownerId = "40000000-0000-4000-8000-0000000000c1";
const reviewStatusId = "40000000-0000-4000-8000-0000000000f1";

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
    createdById: ownerId,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

const review: CustomTaskStatus = {
  id: reviewStatusId,
  workspaceId,
  projectId: null,
  name: "In review",
  color: "#6b7280",
  sortOrder: 1,
  isBuiltIn: false,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const alpha = task("40000000-0000-4000-8000-00000000000a", "Alpha", { sortOrder: 1 });
// Sits between two "To do" cards in the flat page, so a column-relative anchor
// and a page-relative one cannot accidentally agree.
const gamma = task("40000000-0000-4000-8000-00000000000c", "Gamma", {
  status: "done",
  completedAt: "2026-08-02T00:00:00.000Z",
  sortOrder: 2,
});
const beta = task("40000000-0000-4000-8000-00000000000b", "Beta", { sortOrder: 3 });
const delta = task("40000000-0000-4000-8000-00000000000d", "Delta", { sortOrder: 4 });
const epsilon = task("40000000-0000-4000-8000-00000000000e", "Epsilon", {
  customStatusId: reviewStatusId,
  statusLabel: "In review",
  sortOrder: 5,
});

const page: TaskPage = {
  items: [alpha, gamma, beta, delta, epsilon],
  page: 1,
  limit: 100,
  hasMore: false,
};

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
        viewer={{ userId: ownerId, role: "owner" }}
      />
    </QueryClientProvider>,
  );
}

async function openBoard(initial: TaskPage = page) {
  const user = userEvent.setup();
  view(initial);
  await user.click(screen.getByRole("button", { name: "Board" }));
  return user;
}

describe("TaskBoard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.requestTaskPage.mockResolvedValue({ ok: true, data: page });
    mocks.requestTaskStatuses.mockResolvedValue({ ok: true, data: { items: [review] } });
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

  it("lists the four built-in columns in enum order followed by the custom ones", async () => {
    await openBoard();

    expect(await screen.findByRole("heading", { level: 3, name: "In review (1)" })).toBeVisible();
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual([
      "To do (3)",
      "In progress (0)",
      "Done (1)",
      "Canceled (0)",
      "In review (1)",
    ]);
    // A card sits in `customStatusId ?? status`, so the custom column claims it
    // even though its built-in status is still "todo".
    expect(
      within(screen.getByRole("list", { name: "In review (1)" })).getByDisplayValue("Epsilon"),
    ).toBeVisible();
  });

  it("moves a card to a built-in column with one update that clears the custom column", async () => {
    mocks.updateTask.mockReturnValue(new Promise(() => undefined));
    const user = await openBoard();
    await screen.findByRole("heading", { level: 3, name: "In review (1)" });

    const selector = screen.getByLabelText("Column for Epsilon");
    const done = within(selector).getByRole("option", { name: "Done" });
    await user.selectOptions(selector, done);
    await user.click(screen.getByRole("button", { name: "Move to column for Epsilon" }));

    expect(mocks.updateTask).toHaveBeenCalledTimes(1);
    expect(mocks.updateTask).toHaveBeenCalledWith(workspaceId, epsilon.id, {
      status: "done",
      customStatusId: null,
    });
    expect(mocks.reorderTask).not.toHaveBeenCalled();
  });

  it("moves a card to a custom column without touching its built-in status", async () => {
    mocks.updateTask.mockReturnValue(new Promise(() => undefined));
    const user = await openBoard();
    await screen.findByRole("heading", { level: 3, name: "In review (1)" });

    const selector = screen.getByLabelText("Column for Alpha");
    const inReview = within(selector).getByRole("option", { name: "In review" });
    await user.selectOptions(selector, inReview);
    await user.click(screen.getByRole("button", { name: "Move to column for Alpha" }));

    // No `status`: the built-in column alone drives `completed_at`, so a custom
    // column must not disturb it.
    expect(mocks.updateTask).toHaveBeenCalledWith(workspaceId, alpha.id, {
      customStatusId: reviewStatusId,
    });
  });

  it("anchors a keyboard reorder against the column, not the whole page", async () => {
    mocks.reorderTask.mockResolvedValue({ ok: true, data: { task: alpha } });
    const user = await openBoard();
    await screen.findByRole("heading", { level: 3, name: "In review (1)" });

    // "To do" holds Alpha, Beta, Delta. Position 2 within that column anchors on
    // Delta; the flat page would have anchored on Gamma, which is in "Done".
    await user.click(screen.getByRole("button", { name: "Move down Alpha" }));

    expect(mocks.reorderTask).toHaveBeenCalledWith(workspaceId, alpha.id, {
      beforeTaskId: delta.id,
    });
    expect(await screen.findByText(/position 2 of 3/iu)).toBeVisible();
  });

  it("explains a truncated board and offers no reordering on it", async () => {
    const truncated: TaskPage = { ...page, hasMore: true };
    mocks.requestTaskPage.mockResolvedValue({ ok: true, data: truncated });
    const user = await openBoard(truncated);
    await screen.findByRole("heading", { level: 3, name: "In review (1)" });

    const notes = screen.getAllByRole("note").map((note) => note.textContent ?? "");
    expect(notes.some((text) => /truncated/iu.test(text))).toBe(true);
    expect(notes.some((text) => /Reordering is available only/iu.test(text))).toBe(true);
    expect(screen.getByRole("button", { name: "Move down Alpha" })).toBeDisabled();

    // Columns still work while truncated: the move is an update, not a reorder.
    mocks.updateTask.mockReturnValue(new Promise(() => undefined));
    const selector = screen.getByLabelText("Column for Alpha");
    const done = within(selector).getByRole("option", { name: "Done" });
    await user.selectOptions(selector, done);
    await user.click(screen.getByRole("button", { name: "Move to column for Alpha" }));
    expect(mocks.updateTask).toHaveBeenCalledTimes(1);
  });

  it("keeps every card on the board when the custom columns cannot be loaded", async () => {
    mocks.requestTaskStatuses.mockResolvedValue({ ok: false, kind: "unavailable" });
    await openBoard();

    expect(await screen.findByText(/only the four built-in columns are shown/iu)).toBeVisible();
    // Epsilon's custom column is unknown, so it falls back to its built-in one
    // rather than disappearing.
    expect(
      within(screen.getByRole("list", { name: "To do (4)" })).getByDisplayValue("Epsilon"),
    ).toBeVisible();
  });

  it("offers column management to an owner", async () => {
    await openBoard();
    expect(await screen.findByRole("button", { name: "Manage board columns" })).toBeVisible();
  });
});
