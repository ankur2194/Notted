import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TaskRow, type TaskMovement } from "./TaskRow";

import type { TagSummary, TaskSummary, WorkspaceMemberSummary } from "@notted/shared-types";

const workspaceId = "40000000-0000-4000-8000-000000000001";
const creatorId = "40000000-0000-4000-8000-0000000000c1";
const taskId = "40000000-0000-4000-8000-000000000002";
const adaId = "40000000-0000-4000-8000-0000000000aa";
const tagId = "40000000-0000-4000-8000-0000000000bb";

const task: TaskSummary = {
  id: taskId,
  workspaceId,
  projectId: null,
  noteId: "40000000-0000-4000-8000-000000000003",
  parentId: null,
  title: "Write docs",
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
};

const members: readonly WorkspaceMemberSummary[] = [
  {
    id: "40000000-0000-4000-8000-0000000000a1",
    workspaceId,
    userId: adaId,
    name: "Ada Lovelace",
    email: "ada@example.test",
    role: "editor",
    joinedAt: "2026-01-01T00:00:00.000Z",
  },
];

const tags: readonly TagSummary[] = [
  {
    id: tagId,
    workspaceId,
    name: "Design",
    color: "#336699",
    noteCount: 0,
    taskCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

function movement(overrides: Partial<TaskMovement> = {}): TaskMovement {
  return {
    index: 0,
    total: 1,
    dragDisabled: false,
    setActivatorNodeRef: () => undefined,
    attributes: {
      role: "button",
      tabIndex: 0,
      "aria-disabled": false,
      "aria-pressed": undefined,
      "aria-roledescription": "sortable",
      "aria-describedby": "dnd-description",
    },
    listeners: undefined,
    onMove: vi.fn(),
    ...overrides,
  };
}

function view(overrides: Partial<TaskSummary> = {}) {
  const onUpdate = vi.fn();
  render(
    <TaskRow
      task={{ ...task, ...overrides }}
      members={members}
      tags={tags}
      now={new Date(2026, 7, 9, 12, 0, 0, 0)}
      pending={false}
      disabled={false}
      selected={false}
      onSelectedChange={vi.fn()}
      onUpdate={onUpdate}
      onDelete={vi.fn()}
      movement={movement()}
    />,
  );
  return { onUpdate };
}

describe("TaskRow", () => {
  it("offers only workspace members plus an explicit unassigned option", async () => {
    const { onUpdate } = view();
    const select = screen.getByLabelText("Assignee for Write docs");
    expect(
      Array.from(select.querySelectorAll("option")).map((option) => option.textContent),
    ).toEqual(["Unassigned", "Ada Lovelace"]);
    await userEvent.selectOptions(select, adaId);
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: taskId }), {
      assigneeId: adaId,
    });
  });

  it("sends midnight in the viewer's own zone for a date with no time", () => {
    const { onUpdate } = view();
    fireEvent.change(screen.getByLabelText("Due date for Write docs"), {
      target: { value: "2026-08-20" },
    });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: taskId }), {
      dueDate: new Date(2026, 7, 20, 0, 0, 0, 0).toISOString(),
    });
  });

  it("combines the local date and time into one instant", () => {
    const { onUpdate } = view({ dueDate: new Date(2026, 7, 20, 0, 0, 0, 0).toISOString() });
    fireEvent.change(screen.getByLabelText("Due time for Write docs"), {
      target: { value: "09:30" },
    });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: taskId }), {
      dueDate: new Date(2026, 7, 20, 9, 30, 0, 0).toISOString(),
    });
  });

  it("reveals a UTC-labelled cron field for custom recurrence and blocks saving it empty", async () => {
    const user = userEvent.setup();
    const { onUpdate } = view();
    expect(screen.queryByLabelText("Recurrence cron for Write docs")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Recurrence for Write docs"), "custom");
    const cron = screen.getByLabelText("Recurrence cron for Write docs");
    const save = screen.getByRole("button", { name: "Save recurrence Write docs" });
    expect(save).toBeDisabled();
    // Choosing `custom` must not save on its own: the contract rejects a custom
    // recurrence without an expression.
    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByText(/interpreted in UTC/iu)).toBeVisible();

    await user.type(cron, "0 9 * * 1");
    expect(save).toBeEnabled();
    await user.click(save);
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: taskId }), {
      recurrence: "custom",
      recurrenceCron: "0 9 * * 1",
    });
  });

  it("clears a stale cron when recurrence leaves custom", async () => {
    const { onUpdate } = view({ recurrence: "custom", recurrenceCron: "0 9 * * 1" });
    await userEvent.selectOptions(screen.getByLabelText("Recurrence for Write docs"), "weekly");
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: taskId }), {
      recurrence: "weekly",
      recurrenceCron: null,
    });
  });

  it("sends the new priority and the whole next tag selection", async () => {
    const user = userEvent.setup();
    const { onUpdate } = view();
    await user.selectOptions(screen.getByLabelText("Priority for Write docs"), "high");
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: taskId }), {
      priority: "high",
    });

    await user.click(screen.getByText("Tags (0)"));
    await user.click(screen.getByRole("checkbox", { name: "Design" }));
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: taskId }), {
      tagIds: [tagId],
    });
  });

  it("states overdue and priority in words rather than colour alone", () => {
    view({ dueDate: new Date(2026, 7, 1, 9, 0, 0, 0).toISOString() });
    expect(screen.getByText("Overdue")).toBeVisible();
    expect(screen.getByText("Priority: Medium")).toBeVisible();
    expect(screen.getByText("Status: To do")).toBeVisible();
  });

  it("does not repeat the word Overdue for a completed past task", () => {
    view({
      dueDate: new Date(2026, 7, 1, 9, 0, 0, 0).toISOString(),
      status: "done",
      completedAt: new Date(2026, 7, 2, 9, 0, 0, 0).toISOString(),
    });
    expect(screen.queryByText("Overdue")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Complete Write docs" })).toBeChecked();
  });
});
