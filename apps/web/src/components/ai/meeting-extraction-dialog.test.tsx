import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aiRequests = vi.hoisted(() => ({
  fetchAiStatus: vi.fn(),
  requestMeetingExtraction: vi.fn(),
  requestTagSuggestions: vi.fn(),
}));
vi.mock("@/lib/ai/requests", () => aiRequests);

const taskRequests = vi.hoisted(() => ({ requestTaskPage: vi.fn(), createTask: vi.fn() }));
vi.mock("@/lib/tasks/requests", () => taskRequests);

import { MeetingExtractionDialog } from "./MeetingExtractionDialog";

import type { MeetingExtraction } from "@notted/shared-types";
import type { Editor, JSONContent } from "@tiptap/core";

import {
  isMeetingExtractionAvailable,
  openMeetingExtraction,
  setMeetingExtractionHandler,
} from "@/lib/ai/meeting-extraction-request";

const WORKSPACE_ID = "40000000-0000-4000-8000-000000000001";
const NOTE_ID = "40000000-0000-4000-8000-000000000002";

const EXTRACTION: MeetingExtraction = {
  attendees: ["Sam", "Ada"],
  agenda: ["Roadmap"],
  discussionPoints: ["The timeline is tight"],
  decisions: ["Ship on Friday"],
  actionItems: [
    { text: "Ship the draft", assignee: "Sam", dueDate: "2026-09-01" },
    { text: "Book the room" },
  ],
};

/**
 * Records what was handed to `insertContentAt` without a real ProseMirror
 * document: this file is about WHAT is written and WHEN, and the shape of the
 * argument is exactly the thing that must never regress to an HTML string.
 */
function stubEditor() {
  const calls: Array<{ position: number; content: JSONContent[] }> = [];
  const chain = {
    focus: () => chain,
    insertContentAt: (position: number, content: JSONContent[]) => {
      calls.push({ position, content });
      return chain;
    },
    run: () => true,
  };
  const editor = {
    chain: () => chain,
    state: { selection: { from: 7, to: 7 } },
  } as unknown as Editor;
  return { editor, calls };
}

function taskPage(titles: readonly string[]) {
  return {
    ok: true as const,
    data: {
      items: titles.map((title, index) => ({ id: String(index), title })),
      page: 1,
      limit: 100,
      hasMore: false,
    },
  };
}

function renderDialog(editor: Editor, editable = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MeetingExtractionDialog
        workspaceId={WORKSPACE_ID}
        noteId={NOTE_ID}
        editor={editor}
        editable={editable}
      />
    </QueryClientProvider>,
  );
}

/** Open the dialog through the store, paste a transcript, and extract. */
async function reachReviewStep(): Promise<void> {
  await waitFor(() => expect(isMeetingExtractionAvailable()).toBe(true));
  act(() => {
    openMeetingExtraction();
  });
  const transcript = await screen.findByLabelText("Meeting transcript");
  await userEvent.type(transcript, "Sam: hello");
  await userEvent.click(screen.getByTestId("meeting-extract"));
  await screen.findByRole("heading", { name: "Action items" });
}

beforeEach(() => {
  aiRequests.fetchAiStatus.mockResolvedValue({
    ok: true,
    data: { enabled: true, provider: "openai", model: "gpt-4o-mini" },
  });
  aiRequests.requestMeetingExtraction.mockResolvedValue({
    ok: true,
    data: { extraction: EXTRACTION },
  });
  taskRequests.requestTaskPage.mockResolvedValue(taskPage([]));
  taskRequests.createTask.mockResolvedValue({ ok: true, data: { task: { id: "t1" } } });
});

afterEach(() => {
  // Module state outlives a test file's renders; a handler left registered would
  // make the next test's availability assertion meaningless.
  setMeetingExtractionHandler(null);
  vi.clearAllMocks();
});

describe("MeetingExtractionDialog", () => {
  it("renders every section of the extraction for review", async () => {
    const { editor } = stubEditor();
    renderDialog(editor);
    await reachReviewStep();

    for (const heading of [
      "Attendees",
      "Agenda",
      "Discussion points",
      "Decisions",
      "Action items",
    ]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(screen.getByDisplayValue("Sam")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Ship on Friday")).toBeInTheDocument();
    // Every item starts included; creating a separate task never does.
    expect(screen.getByTestId("meeting-include-decisions-0")).toBeChecked();
    expect(screen.getByTestId("meeting-create-task-0")).not.toBeChecked();
  });

  it("writes nothing to the note and creates no task before Insert is pressed", async () => {
    const { editor, calls } = stubEditor();
    renderDialog(editor);
    await reachReviewStep();

    // The whole safeguard: a review step that has already written something is
    // not a review, it is a notification.
    await userEvent.click(screen.getByTestId("meeting-create-task-0"));
    await userEvent.click(screen.getByTestId("meeting-include-attendees-1"));
    expect(calls).toHaveLength(0);
    expect(taskRequests.createTask).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("meeting-insert"));
    expect(calls).toHaveLength(1);
    await waitFor(() => expect(taskRequests.createTask).toHaveBeenCalledTimes(1));
  });

  it("inserts JSON nodes — never an HTML string — with the action items as a task list", async () => {
    const { editor, calls } = stubEditor();
    renderDialog(editor);
    await reachReviewStep();

    await userEvent.click(screen.getByTestId("meeting-insert"));

    const call = calls[0];
    expect(call).toBeDefined();
    // A collapsed position, so a selection the author made while reading the
    // review is never consumed by the insert.
    expect(call?.position).toBe(7);
    const content = call?.content ?? [];
    expect(Array.isArray(content)).toBe(true);
    expect(typeof content[0]).toBe("object");

    const taskList = content.find((node) => node.type === "taskList");
    expect(taskList).toBeDefined();
    const items = taskList?.content ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: "taskItem", attrs: { checked: false } });
    expect(JSON.stringify(items[0])).toContain("Ship the draft — Sam · due 2026-09-01");

    // The plain sections arrive as heading + bulletList, not as markup.
    expect(content.filter((node) => node.type === "heading")).toHaveLength(5);
    expect(content.some((node) => node.type === "bulletList")).toBe(true);
  });

  it("leaves an unchecked item out of the inserted content", async () => {
    const { editor, calls } = stubEditor();
    renderDialog(editor);
    await reachReviewStep();

    await userEvent.click(screen.getByTestId("meeting-include-attendees-0"));
    await userEvent.click(screen.getByTestId("meeting-include-actionItems-1"));
    await userEvent.click(screen.getByTestId("meeting-insert"));

    const serialized = JSON.stringify(calls[0]?.content ?? []);
    // The attendee is gone as its own list item; "Sam" survives only inside the
    // action item's own text, which was left checked.
    expect(serialized).not.toContain('"text":"Sam"');
    expect(serialized).toContain('"text":"Ada"');
    expect(serialized).not.toContain("Book the room");
    expect(serialized).toContain("Ship the draft");
  });

  it("flags an action item whose normalised title already exists as a task", async () => {
    // Trimmed, lowercased, whitespace-collapsed: the same task by any spelling.
    taskRequests.requestTaskPage.mockResolvedValue(taskPage(["  Ship   THE draft "]));
    const { editor } = stubEditor();
    renderDialog(editor);
    await reachReviewStep();

    const row = screen.getByTestId("meeting-duplicate-0");
    expect(row).toHaveTextContent("Already exists");
    // The badge is advice; the box was already off, and stays off.
    expect(screen.getByTestId("meeting-create-task-0")).not.toBeChecked();
    expect(screen.queryByTestId("meeting-duplicate-1")).toBeNull();
  });

  it("keeps the review usable when the existing-task read fails", async () => {
    taskRequests.requestTaskPage.mockResolvedValue({ ok: false, kind: "unavailable" });
    const { editor } = stubEditor();
    renderDialog(editor);
    await reachReviewStep();

    expect(screen.queryByTestId("meeting-duplicate-0")).toBeNull();
    expect(
      within(screen.getByTestId("meeting-section-actionItems")).getByDisplayValue("Ship the draft"),
    ).toBeInTheDocument();
  });

  it("registers the open handler only while it can serve the command", async () => {
    expect(isMeetingExtractionAvailable()).toBe(false);
    const { editor } = stubEditor();
    const view = renderDialog(editor);
    await waitFor(() => expect(isMeetingExtractionAvailable()).toBe(true));

    view.unmount();
    expect(isMeetingExtractionAvailable()).toBe(false);
  });

  it("never registers the command when AI is disabled for the workspace", async () => {
    aiRequests.fetchAiStatus.mockResolvedValue({
      ok: true,
      data: { enabled: false, provider: "disabled", model: null },
    });
    const { editor } = stubEditor();
    renderDialog(editor);

    await waitFor(() => expect(aiRequests.fetchAiStatus).toHaveBeenCalled());
    expect(isMeetingExtractionAvailable()).toBe(false);
  });
});
