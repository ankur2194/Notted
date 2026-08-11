import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const creatorId = "40000000-0000-4000-8000-0000000000c1";
const noteId = "40000000-0000-4000-8000-000000000002";

function task(id: string, title: string, sortOrder: number): TaskSummary {
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
    sortOrder,
    recurrence: "none",
    recurrenceCron: null,
    tagIds: [],
    createdById: creatorId,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

const alpha = task("40000000-0000-4000-8000-00000000000a", "Alpha", 1);
const beta = task("40000000-0000-4000-8000-00000000000b", "Beta", 2);
const gamma = task("40000000-0000-4000-8000-00000000000c", "Gamma", 3);
const page: TaskPage = { items: [alpha, beta, gamma], page: 1, limit: 100, hasMore: false };

// jsdom measures every element as a zero-size, zero-offset rect, which defeats
// dnd-kit's keyboard DnD: the sortable coordinate getter only targets items
// strictly beyond the dragged one, and `KeyboardSensor`'s start handler calls
// the jsdom-unimplemented `scrollIntoView` for a zero-height node, aborting the
// drag. Reporting one row per task restores browser-like behaviour.
function rect(top: number, height: number, width: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: width,
    bottom: top + height,
    width,
    height,
  } as unknown as DOMRect;
}

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ): DOMRect {
    const rows = Array.from(document.querySelectorAll("ul[aria-labelledby] > li"));
    const index = rows.indexOf(this);
    return index === -1 ? rect(0, 400, 400) : rect(index * 100, 100, 400);
  });
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
  mocks.reorderTask.mockResolvedValue({ ok: true, data: { task: alpha } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

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
      />
    </QueryClientProvider>,
  );
}

function order(): readonly string[] {
  return screen
    .getAllByLabelText(/^Title for /u)
    .map((element) => (element as HTMLInputElement).value);
}

describe("task reordering", () => {
  it("anchors a keyboard drag against the row it lands before", async () => {
    const user = userEvent.setup();
    view();
    const handle = screen.getByRole("button", { name: "Reorder Alpha" });
    handle.focus();
    // user-event's keyMap stores Space as { key: " ", code: "Space" }; the
    // "{Space}" descriptor resolves to code "Unknown", which dnd-kit's
    // code-driven KeyboardSensor ignores. A literal space is a real Space press.
    await user.keyboard(" {ArrowDown} ");

    await waitFor(() =>
      expect(mocks.reorderTask).toHaveBeenCalledWith(workspaceId, alpha.id, {
        beforeTaskId: gamma.id,
      }),
    );
  });

  it("sends the identical payload for the Move down alternative", async () => {
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole("button", { name: "Move down Alpha" }));

    expect(mocks.reorderTask).toHaveBeenCalledWith(workspaceId, alpha.id, {
      beforeTaskId: gamma.id,
    });
  });

  it("anchors Move up to the displaced sibling and announces the destination", async () => {
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole("button", { name: "Move up Gamma" }));

    expect(mocks.reorderTask).toHaveBeenCalledWith(workspaceId, gamma.id, {
      beforeTaskId: beta.id,
    });
    expect(await screen.findByText("Moved Gamma to position 2 of 3.")).toBeVisible();
  });

  it("reaches any slot through the position selector", async () => {
    const user = userEvent.setup();
    view();
    await user.selectOptions(screen.getByLabelText("Position for Alpha"), "3");
    await user.click(screen.getByRole("button", { name: "Move to position Alpha" }));

    expect(mocks.reorderTask).toHaveBeenCalledWith(workspaceId, alpha.id, {
      beforeTaskId: null,
    });
  });

  it("restores the original order and announces a concurrent reorder conflict", async () => {
    const user = userEvent.setup();
    let settle!: (value: unknown) => void;
    mocks.reorderTask.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    view();
    await user.click(screen.getByRole("button", { name: "Move down Alpha" }));
    expect(order()).toEqual(["Beta", "Alpha", "Gamma"]);

    settle({ ok: false, kind: "conflict" });
    expect(await screen.findByText(/conflicted with a recent change/iu)).toBeVisible();
    expect(order()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("disables reordering while grouped and explains why", async () => {
    const user = userEvent.setup();
    view();
    await user.selectOptions(screen.getByLabelText("Group tasks by"), "status");

    expect(screen.getByRole("note")).toHaveTextContent(
      /Reordering is unavailable while tasks are grouped/iu,
    );
    expect(screen.getByRole("button", { name: "Reorder Alpha" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move down Alpha" })).toBeDisabled();
    expect(screen.getByLabelText("Position for Alpha")).toBeDisabled();
  });

  it("disables reordering when the page is not the complete first page", () => {
    view({ ...page, hasMore: true });
    expect(screen.getByRole("note")).toHaveTextContent(
      /only in the complete first page of tasks/iu,
    );
    expect(screen.getByRole("button", { name: "Reorder Alpha" })).toBeDisabled();
  });
});
