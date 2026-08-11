import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TaskStatusManager } from "./TaskStatusManager";

import type { CustomTaskStatus } from "@notted/shared-types";

const mocks = vi.hoisted(() => ({
  createTaskStatus: vi.fn(),
  updateTaskStatus: vi.fn(),
  deleteTaskStatus: vi.fn(),
}));

vi.mock("@/lib/tasks/requests", () => ({
  createTaskStatus: mocks.createTaskStatus,
  updateTaskStatus: mocks.updateTaskStatus,
  deleteTaskStatus: mocks.deleteTaskStatus,
}));

const workspaceId = "40000000-0000-4000-8000-000000000001";
const statusId = "40000000-0000-4000-8000-0000000000f1";

const blocked: CustomTaskStatus = {
  id: statusId,
  workspaceId,
  projectId: null,
  name: "Blocked",
  color: "#ff0000",
  sortOrder: 3,
  isBuiltIn: false,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

async function openDeleteConfirmation(): Promise<HTMLElement> {
  const user = userEvent.setup();
  render(
    <TaskStatusManager
      workspaceId={workspaceId}
      projectId={null}
      statuses={[blocked]}
      isLoading={false}
      isError={false}
      cardCounts={new Map([[statusId, 2]])}
      onRetry={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Manage board columns" }));
  await user.click(screen.getByRole("button", { name: "Delete Blocked" }));
  return screen.getByRole("alert");
}

describe("TaskStatusManager column deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * A task keeps the built-in `status` it never lost, so its fallback is real.
   * A note placed in the column has none: `notes.board_column_id` is
   * `ON DELETE SET NULL` and nothing records where it sat. The dialog must say
   * so in words before the irreversible click, not with colour or a task count
   * that quietly omits notes entirely.
   */
  it("warns that notes lose their board column before the delete runs", async () => {
    const alert = await openDeleteConfirmation();
    expect(alert).toHaveTextContent("2 cards move back to their built-in status");
    expect(alert).toHaveTextContent(/notes placed in this column lose their board column/i);
    expect(mocks.deleteTaskStatus).not.toHaveBeenCalled();
  });

  it("reports both server counts separately after the delete", async () => {
    mocks.deleteTaskStatus.mockResolvedValue({
      ok: true,
      data: { id: statusId, deleted: true, affected: 4, affectedNotes: 3 },
    });
    const alert = await openDeleteConfirmation();
    await userEvent.click(within(alert).getByRole("button", { name: "Delete column Blocked" }));

    expect(mocks.deleteTaskStatus).toHaveBeenCalledWith(workspaceId, statusId);
    const live = screen.getByRole("status");
    expect(live).toHaveTextContent("4 tasks moved back to their built-in status");
    expect(live).toHaveTextContent("3 notes lost their board column");
  });

  it("keeps both counts singular-correct", async () => {
    mocks.deleteTaskStatus.mockResolvedValue({
      ok: true,
      data: { id: statusId, deleted: true, affected: 1, affectedNotes: 1 },
    });
    const alert = await openDeleteConfirmation();
    await userEvent.click(within(alert).getByRole("button", { name: "Delete column Blocked" }));

    expect(screen.getByRole("status")).toHaveTextContent(
      "1 task moved back to their built-in status; 1 note lost its board column.",
    );
  });
});
