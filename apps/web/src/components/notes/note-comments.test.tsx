import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requests = vi.hoisted(() => ({
  requestNoteComments: vi.fn(),
  createNoteComment: vi.fn(),
  updateNoteComment: vi.fn(),
  deleteNoteComment: vi.fn(),
  setNoteCommentResolution: vi.fn(),
}));
vi.mock("@/lib/notes/requests", () => requests);

/**
 * Anchor resolution is mocked at the module boundary: `comment-anchors.ts` has
 * its own tests against a real ProseMirror state, and what this file proves is
 * what the LIST does with a `null` resolution, not how Yjs maps a position.
 */
const anchors = vi.hoisted(() => ({
  createCommentAnchor: vi.fn(),
  resolveCommentAnchor: vi.fn(),
}));
vi.mock("@/components/editor/comment-anchors", () => anchors);

/**
 * A fake for the single app-wide socket. Building the real one here would leave
 * a module-level Socket.io client alive after the test, exactly as
 * `note-editor-surface.test.tsx` notes for presence.
 */
const socket = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    handlers,
    getRealtimeSocket: vi.fn(() => ({
      on(event: string, handler: (payload: unknown) => void) {
        const set = handlers.get(event) ?? new Set();
        set.add(handler);
        handlers.set(event, set);
      },
      off(event: string, handler: (payload: unknown) => void) {
        handlers.get(event)?.delete(handler);
      },
    })),
  };
});
vi.mock("@/lib/collaboration/realtime-socket", () => ({
  getRealtimeSocket: socket.getRealtimeSocket,
}));

import { NoteComments } from "./NoteComments";

import type { CommentAnchorTarget } from "@/components/editor/extensions/comment-decorations";
import type { CommentAnchor, CommentSummary, CommentThread } from "@notted/shared-types";
import type { Editor } from "@tiptap/core";

const WORKSPACE_ID = "30000000-0000-4000-8000-000000000001";
const NOTE_ID = "30000000-0000-4000-8000-000000000002";
const OTHER_NOTE_ID = "30000000-0000-4000-8000-0000000000ff";
const ADA_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";
const BOB_ID = "44444444-4444-4444-8444-444444444444";

const COMMENT_CHANGED = "realtime:comment:changed";

function emit(event: string, payload: unknown): void {
  for (const handler of socket.handlers.get(event) ?? []) handler(payload);
}

function anchor(quote: string): CommentAnchor {
  return { scheme: "pmabs:1", from: 1, to: 5, quote, schemaVersion: 1 };
}

function comment(overrides: Partial<CommentSummary> & { readonly id: string }): CommentSummary {
  return {
    noteId: NOTE_ID,
    parentId: null,
    content: "Looks good",
    createdBy: { id: ADA_ID, name: "Ada Lovelace" },
    isResolved: false,
    resolvedAt: null,
    resolvedBy: null,
    anchor: null,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    ...overrides,
  };
}

function thread(
  overrides: Partial<CommentThread> & { readonly id: string },
  replies: readonly CommentSummary[] = [],
): CommentThread {
  return { ...comment(overrides), replies, repliesTruncated: false };
}

function page(items: readonly CommentThread[], openCount = items.length) {
  return { ok: true, data: { items, page: 1, limit: 50, hasMore: false, openCount } };
}

function fakeEditor(): Editor {
  return {
    on: vi.fn(),
    off: vi.fn(),
    state: { selection: { from: 3, to: 9 } },
  } as unknown as Editor;
}

function view(
  options: {
    readonly canResolve?: boolean;
    readonly onAnchorsChange?: (targets: readonly CommentAnchorTarget[]) => void;
  } = {},
) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NoteComments
        workspaceId={WORKSPACE_ID}
        noteId={NOTE_ID}
        canResolve={options.canResolve ?? true}
        currentUserId={ADA_ID}
        editor={fakeEditor()}
        onAnchorsChange={options.onAnchorsChange}
      />
    </QueryClientProvider>,
  );
}

/** The panel is a disclosure: nothing is fetched until it is opened. */
async function openPanel(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "Comments" }));
  await screen.findByRole("heading", { name: /Comments/u });
}

/**
 * `navigator.onLine` is a getter on `Navigator.prototype` in jsdom, so the value
 * is redefined on the instance and the event the hook listens for is fired —
 * exactly what a browser does when the connection drops.
 */
function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { value, configurable: true });
  window.dispatchEvent(new Event(value ? "online" : "offline"));
}

afterEach(() => {
  setOnline(true);
});

beforeEach(() => {
  vi.clearAllMocks();
  socket.handlers.clear();
  anchors.resolveCommentAnchor.mockReturnValue({ from: 3, to: 9 });
  anchors.createCommentAnchor.mockReturnValue(anchor("selected text"));
  requests.requestNoteComments.mockResolvedValue(page([]));
  requests.createNoteComment.mockResolvedValue({
    ok: true,
    data: { comment: comment({ id: "created" }) },
  });
  requests.setNoteCommentResolution.mockResolvedValue({
    ok: true,
    data: { comment: comment({ id: "resolved" }) },
  });
});

describe("NoteComments", () => {
  it("renders a thread with its replies", async () => {
    requests.requestNoteComments.mockResolvedValue(
      page([
        thread({ id: "t1", content: "Is this paragraph still true?" }, [
          comment({
            id: "r1",
            parentId: "t1",
            content: "Updated it",
            createdBy: { id: BOB_ID, name: "Bob Barker" },
          }),
        ]),
      ]),
    );
    view();
    await openPanel();

    const threads = await screen.findByRole("list", { name: "Comment threads" });
    expect(within(threads).getByText("Is this paragraph still true?")).toBeVisible();
    const replies = within(threads).getByRole("list", { name: "Replies" });
    expect(within(replies).getByText("Updated it")).toBeVisible();
    expect(within(replies).getByText("Bob Barker")).toBeVisible();
  });

  it("posts a reply under the thread root", async () => {
    requests.requestNoteComments.mockResolvedValue(page([thread({ id: "t1" })]));
    view();
    await openPanel();

    await userEvent.click(await screen.findByRole("button", { name: /Reply/u }));
    const field = screen.getByRole("textbox", { name: /Reply to Ada Lovelace/u });
    // Focus moves into the reply box when the thread opens it.
    expect(field).toHaveFocus();
    await userEvent.type(field, "Still true");
    await userEvent.click(screen.getByRole("button", { name: "Post reply" }));

    await waitFor(() => expect(requests.createNoteComment).toHaveBeenCalledTimes(1));
    expect(requests.createNoteComment).toHaveBeenCalledWith(
      WORKSPACE_ID,
      NOTE_ID,
      { content: "Still true", parentId: "t1", anchor: null },
      expect.any(String),
    );
  });

  it("toggles resolution and surfaces who resolved it and when", async () => {
    requests.requestNoteComments.mockResolvedValue(
      page(
        [
          thread({
            id: "t1",
            isResolved: true,
            resolvedAt: "2026-08-02T10:00:00.000Z",
            resolvedBy: { id: BOB_ID, name: "Bob Barker" },
          }),
        ],
        0,
      ),
    );
    view();
    await openPanel();

    expect(await screen.findByText(/Resolved by Bob Barker on/u)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /Reopen/u }));
    await waitFor(() => expect(requests.setNoteCommentResolution).toHaveBeenCalledTimes(1));
    expect(requests.setNoteCommentResolution).toHaveBeenCalledWith(WORKSPACE_ID, NOTE_ID, "t1", {
      isResolved: false,
    });
  });

  it("lists an orphaned comment under its quote and draws no decoration for it", async () => {
    const orphanAnchor = anchor("deleted sentence");
    requests.requestNoteComments.mockResolvedValue(
      page([
        thread({ id: "live", anchor: anchor("kept sentence") }),
        thread({ id: "orphan", anchor: orphanAnchor, content: "What happened here?" }),
      ]),
    );
    // `null` IS the orphan signal, and it is also the exact condition the
    // decoration plugin skips on, so a target that resolves to `null` is a
    // target that is never drawn.
    anchors.resolveCommentAnchor.mockImplementation(
      (_unusedEditor: Editor, value: CommentAnchor) =>
        value.quote === "deleted sentence" ? null : { from: 3, to: 9 },
    );

    const targets: CommentAnchorTarget[][] = [];
    view({ onAnchorsChange: (next) => targets.push([...next]) });
    await openPanel();

    const orphaned = await screen.findByRole("list", { name: "Orphaned" });
    expect(within(orphaned).getByText(/commented on: “deleted sentence”/u)).toBeVisible();
    expect(within(orphaned).getByText("What happened here?")).toBeVisible();

    // Never hidden and never deleted: it is still published to the editor, and
    // the editor draws nothing because the anchor no longer resolves.
    const published = targets.at(-1) ?? [];
    expect(published.map((target) => target.id)).toEqual(["live", "orphan"]);
    const drawn = published.filter(
      (target) => anchors.resolveCommentAnchor(fakeEditor(), target.anchor) !== null,
    );
    expect(drawn.map((target) => target.id)).toEqual(["live"]);

    // And it is not duplicated into the ordinary list.
    const live = screen.getByRole("list", { name: "Comment threads" });
    expect(within(live).queryByText("What happened here?")).toBeNull();
  });

  it("lets a viewer comment but never offers them the resolve control", async () => {
    requests.requestNoteComments.mockResolvedValue(page([thread({ id: "t1" })]));
    view({ canResolve: false });
    await openPanel();

    await screen.findByRole("list", { name: "Comment threads" });
    expect(screen.queryByRole("button", { name: /Resolve/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reopen/u })).toBeNull();
    // Commenting and replying stay available: the backend grants those on
    // `note.read`, and only `comment.resolve` maps to `noteCanEdit`.
    expect(screen.getByRole("button", { name: /^Reply/u })).toBeVisible();

    await userEvent.type(screen.getByRole("textbox", { name: "Add a comment" }), "A note");
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(requests.createNoteComment).toHaveBeenCalledTimes(1));
    expect(requests.createNoteComment).toHaveBeenCalledWith(
      WORKSPACE_ID,
      NOTE_ID,
      { content: "A note", parentId: null, anchor: anchor("selected text") },
      expect.any(String),
    );
  });

  /**
   * The Part 58 cross-note guard, and the most important assertion in this file.
   *
   * One app-wide socket serves the whole app and Socket.IO dispatches by EVENT
   * NAME, not by room: a socket holding two note rooms delivers both notes'
   * frames to this one handler. A frame for another note must change nothing.
   */
  it("ignores a comment frame for a different note", async () => {
    requests.requestNoteComments.mockResolvedValue(page([thread({ id: "t1" })]));
    view();
    await openPanel();
    await screen.findByRole("list", { name: "Comment threads" });
    await waitFor(() => expect(requests.requestNoteComments).toHaveBeenCalledTimes(1));

    emit(COMMENT_CHANGED, {
      noteId: OTHER_NOTE_ID,
      commentId: "x",
      threadId: "x",
      kind: "created",
    });
    // A malformed frame is dropped at the same boundary.
    emit(COMMENT_CHANGED, { noteId: NOTE_ID });
    emit(COMMENT_CHANGED, null);

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(requests.requestNoteComments).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Looks good")).toBeVisible();

    // The same handler still acts on this note's own frame, so the assertion
    // above is a guard rather than a broken subscription.
    emit(COMMENT_CHANGED, { noteId: NOTE_ID, commentId: "t1", threadId: "t1", kind: "updated" });
    await waitFor(() => expect(requests.requestNoteComments).toHaveBeenCalledTimes(2));
  });

  /**
   * The disclosure, as a disclosure.
   *
   * The panel used to be two disjoint renders — a "Comments" button OR a section
   * with its own "Hide comments" button — so the control the reader pressed
   * unmounted on both transitions and focus fell to `<body>` each time. One
   * persistent toggle carrying `aria-expanded`/`aria-controls` is what fixes it,
   * and this is the assertion that it stays one.
   */
  it("keeps focus on the comments toggle across open and close", async () => {
    requests.requestNoteComments.mockResolvedValue(page([thread({ id: "t1" })]));
    view();

    const toggle = screen.getByRole("button", { name: "Comments" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", "note-comments-panel");

    await userEvent.click(toggle);
    await screen.findByRole("heading", { name: /Comments/u });
    // The same element, still focused, now expanded and pointing at a panel
    // that exists.
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("note-comments")).toHaveAttribute("id", "note-comments-panel");

    await userEvent.click(toggle);
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("note-comments")).toBeNull();
  });

  /**
   * The Part 34 rule, on the controls that mutate: `aria-disabled` and an inert
   * handler, never the native attribute. A `disabled` control leaves the tab
   * order the instant it is disabled, and when the thing that disabled it was
   * the reader's own keypress, focus lands on `<body>` mid-task.
   */
  it("keeps offline controls focusable and inert, and announces going offline", async () => {
    requests.requestNoteComments.mockResolvedValue(page([thread({ id: "t1" })]));
    view();
    await openPanel();
    await screen.findByRole("list", { name: "Comment threads" });

    setOnline(false);

    const remove = screen.getByRole("button", { name: /Delete/u });
    await waitFor(() => expect(remove).toHaveAttribute("aria-disabled", "true"));
    expect(remove).not.toHaveAttribute("disabled");
    expect(screen.getByRole("button", { name: /Resolve/u })).not.toHaveAttribute("disabled");
    expect(screen.getByTestId("comment-submit")).not.toHaveAttribute("disabled");

    remove.focus();
    await userEvent.click(remove);
    // Focusable, focused, and still refused.
    expect(remove).toHaveFocus();
    expect(requests.deleteNoteComment).not.toHaveBeenCalled();

    // And the state that inerted them is spoken, not only drawn.
    expect(screen.getByTestId("note-comments-announcement")).toHaveTextContent(/You are offline/u);
  });

  it("hands focus to the panel heading when a deleted comment takes it away", async () => {
    requests.requestNoteComments.mockResolvedValue(page([thread({ id: "t1" })]));
    requests.deleteNoteComment.mockResolvedValue({ ok: true, data: {} });
    view();
    await openPanel();

    const remove = await screen.findByRole("button", { name: /Delete/u });
    remove.focus();
    await userEvent.click(remove);

    await waitFor(() => expect(requests.deleteNoteComment).toHaveBeenCalledTimes(1));
    // Not `<body>`: the comment that held focus is gone, so focus is handed to
    // the nearest stable landmark above the list.
    const heading = screen.getByRole("heading", { name: /Comments/u });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByTestId("note-comments-announcement")).toHaveTextContent("Comment deleted.");
  });

  it("shows an error state with a retry that refetches", async () => {
    requests.requestNoteComments.mockResolvedValue({ ok: false, kind: "unavailable" });
    view();
    await openPanel();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not be loaded/u);

    requests.requestNoteComments.mockResolvedValue(page([thread({ id: "t1" })]));
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "Comment threads" })).toBeVisible();
  });
});
