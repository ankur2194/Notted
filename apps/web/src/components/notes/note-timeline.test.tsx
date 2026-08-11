import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NoteTimeline } from "./NoteTimeline";

import type { NoteSummary, TaskPage, TaskSummary } from "@notted/shared-types";

const mocks = vi.hoisted(() => ({ requestTaskPage: vi.fn() }));

vi.mock("@/lib/tasks/requests", () => ({ requestTaskPage: mocks.requestTaskPage }));

const workspaceId = "50000000-0000-4000-8000-000000000001";
const projectId = "50000000-0000-4000-8000-000000000002";
const creatorId = "50000000-0000-4000-8000-0000000000c1";

function note(id: string, title: string, createdAt: string, updatedAt: string): NoteSummary {
  return {
    id,
    workspaceId,
    location: "project",
    projectId,
    folderId: null,
    parentId: null,
    boardColumnId: null,
    title,
    type: "document",
    pageSize: "a4",
    sortOrder: 1,
    isTemplate: false,
    isPinned: false,
    isArchived: false,
    isDeleted: false,
    tagIds: [],
    progress: { checklist: { done: 0, total: 0 }, tasks: { done: 0, total: 0 } },
    version: 1,
    deletedAt: null,
    createdAt,
    updatedAt,
  };
}

function task(id: string, title: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id,
    workspaceId,
    projectId,
    noteId: null,
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
    createdAt: "2026-03-05T00:00:00.000Z",
    updatedAt: "2026-03-05T00:00:00.000Z",
    ...overrides,
  };
}

const designDoc = note(
  "50000000-0000-4000-8000-00000000000a",
  "Design doc",
  "2026-03-03T00:00:00.000Z",
  "2026-03-12T00:00:00.000Z",
);
/** No parseable creation instant at all: belongs in "Not scheduled", not dropped. */
const broken = note("50000000-0000-4000-8000-00000000000b", "Broken", "whenever", "whenever");
/** No completion and no due date: an end would have to be invented, so it is a marker. */
const kickoff = task("50000000-0000-4000-8000-00000000000c", "Kickoff");

const onePage: TaskPage = { items: [kickoff], page: 1, limit: 100, hasMore: false };

function view(overrides: Partial<Parameters<typeof NoteTimeline>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NoteTimeline
        workspaceId={workspaceId}
        projectId={projectId}
        projectName="Apollo"
        projectCreatedAt="2026-03-01T00:00:00.000Z"
        projectDueAt="2026-06-30T00:00:00.000Z"
        notes={[designDoc]}
        notesHasMore={false}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

describe("NoteTimeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestTaskPage.mockResolvedValue({ ok: true, data: onePage });
  });

  it("states the project frame and each bar's dates in words", async () => {
    view();

    expect(screen.getByText("Project: Apollo — Mar 1, 2026 to Jun 30, 2026")).toBeVisible();
    expect(screen.getByText("Note: Design doc — Mar 3, 2026 to Mar 12, 2026")).toBeVisible();
    // The chart is only reached once the task page resolves.
    expect(await screen.findByText("Task: Kickoff — Mar 5, 2026")).toBeVisible();
  });

  it("draws a record with no distinct end as a marker rather than inventing one", async () => {
    view();

    const marker = await screen.findByText("Task: Kickoff — Mar 5, 2026");
    // A marker states one instant; a bar would have said "to".
    expect(marker.textContent).not.toMatch(/ to /u);
  });

  it("names a record with no usable date instead of dropping it", async () => {
    view({ notes: [designDoc, broken] });

    const unscheduled = await screen.findByRole("list", { name: "Not scheduled (1)" });
    expect(within(unscheduled).getByText(/Broken/u)).toBeVisible();
    // The dated note stayed on the chart.
    expect(screen.getByText("Note: Design doc — Mar 3, 2026 to Mar 12, 2026")).toBeVisible();
  });

  it("advances a 100-row window when Load next page is pressed", async () => {
    const user = userEvent.setup();
    mocks.requestTaskPage.mockResolvedValue({ ok: true, data: { ...onePage, hasMore: true } });
    view();

    expect(await screen.findByText("Showing tasks 1–1 of more.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Load next page" }));

    await waitFor(() => {
      expect(mocks.requestTaskPage).toHaveBeenLastCalledWith(
        workspaceId,
        expect.objectContaining({ page: 2, limit: 100, projectId }),
      );
    });
  });

  /*
   * Mounting is the gate: `NoteBrowser` renders this component only while the
   * timeline view is showing, so the task query must fire once on mount and not
   * carry a second `enabled` flag that production always sets to true.
   */
  it("fetches the project's tasks exactly once on mount", async () => {
    view();

    expect(await screen.findByText("Task: Kickoff — Mar 5, 2026")).toBeVisible();
    expect(mocks.requestTaskPage).toHaveBeenCalledTimes(1);
    expect(mocks.requestTaskPage).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({ page: 1, limit: 100, projectId }),
    );
  });
});
