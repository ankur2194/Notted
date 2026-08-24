import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aiRequests = vi.hoisted(() => ({ fetchAiStatus: vi.fn() }));
vi.mock("@/lib/ai/requests", () => aiRequests);

/**
 * The stream hook is mocked at the module boundary: `use-ai-stream.test.tsx`
 * already proves the state machine and the abort bookkeeping over a real
 * `streamAi`. What THIS file proves is what the panel does with each phase — and
 * above all, what it does not do to the document.
 *
 * The object is mutable and read fresh on every render, so a test moves the
 * phase and calls `refresh()` to re-render with it.
 */
const streamState = vi.hoisted(() => ({
  phase: "idle" as "idle" | "streaming" | "preview" | "error",
  text: "",
  error: null as string | null,
  promptVersion: null as string | null,
  start: vi.fn(),
  cancel: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("@/lib/ai/use-ai-stream", () => ({ useAiStream: () => streamState }));

import { AiPanel } from "./AiPanel";

import type { Editor } from "@tiptap/core";

import { isAiContinueAvailable, setAiContinueHandler } from "@/lib/ai/continue-request";
import { paragraphDocument, renderEditor } from "@/test/editor-harness";

const WORKSPACE_ID = "30000000-0000-4000-8000-000000000001";
const NOTE_ID = "30000000-0000-4000-8000-000000000002";

const REWRITE_PATH = `/api/v1/workspaces/${WORKSPACE_ID}/ai/rewrite`;
const SUMMARIZE_PATH = `/api/v1/workspaces/${WORKSPACE_ID}/ai/summarize`;

function statusResult(enabled: boolean) {
  return {
    ok: true,
    data: {
      enabled,
      provider: enabled ? "openai" : "disabled",
      model: enabled ? "gpt-4o-mini" : null,
    },
  };
}

/** Enough of an editor for the cases that never touch a real document. */
function fakeEditor(): Editor {
  return {
    on: vi.fn(),
    off: vi.fn(),
    state: {
      selection: { from: 1, to: 1 },
      doc: {
        content: { size: 12 },
        textContent: "hello world",
        textBetween: () => "hello world",
      },
    },
  } as unknown as Editor;
}

interface PanelOptions {
  readonly editor?: Editor | null;
  readonly editable?: boolean;
}

function renderPanel(options: PanelOptions = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const editor = options.editor === undefined ? fakeEditor() : options.editor;
  // A FRESH element every time: re-rendering the identical element reference
  // lets React bail out, and the mutated phase would never reach the panel.
  const build = () => (
    <QueryClientProvider client={client}>
      <AiPanel
        workspaceId={WORKSPACE_ID}
        noteId={NOTE_ID}
        editor={editor}
        editable={options.editable ?? true}
      />
    </QueryClientProvider>
  );
  const utils = render(build());
  return { ...utils, refresh: () => utils.rerender(build()) };
}

/** Wait for the status query, then open the disclosure. */
async function openPanel(): Promise<void> {
  const toggle = screen.getByTestId("note-ai-toggle");
  await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled"));
  await userEvent.click(toggle);
  await screen.findByRole("heading", { name: "AI assistance" });
}

beforeEach(() => {
  aiRequests.fetchAiStatus.mockResolvedValue(statusResult(true));
  streamState.phase = "idle";
  streamState.text = "";
  streamState.error = null;
  streamState.promptVersion = null;
});

afterEach(() => {
  // Module state outlives a test file's renders; a handler left registered would
  // make the next test's `isAiContinueAvailable()` assertion meaningless.
  setAiContinueHandler(null);
  vi.clearAllMocks();
});

describe("AiPanel", () => {
  it("renders nothing at all when the note is not editable", () => {
    const { container } = renderPanel({ editable: false });
    expect(container).toBeEmptyDOMElement();
    expect(aiRequests.fetchAiStatus).not.toHaveBeenCalled();
  });

  it("explains itself instead of disappearing when AI is disabled", async () => {
    aiRequests.fetchAiStatus.mockResolvedValue(statusResult(false));
    renderPanel();

    const message = await screen.findByTestId("note-ai-unavailable");
    expect(message).toHaveTextContent(/turned off for this workspace/u);
    // The control stays mounted and focusable — a missing button is
    // indistinguishable from a bug — but refuses to open.
    expect(screen.getByTestId("note-ai-toggle")).toHaveAttribute("aria-disabled", "true");

    await userEvent.click(screen.getByTestId("note-ai-toggle"));
    expect(screen.queryByTestId("note-ai-panel")).toBeNull();
    expect(screen.queryByTestId("ai-summarize")).toBeNull();
    expect(screen.queryByTestId("ai-continue")).toBeNull();
    expect(screen.queryByTestId("ai-rewrite")).toBeNull();
  });

  it("registers the continue-writing handler on mount and withdraws it on unmount", async () => {
    expect(isAiContinueAvailable()).toBe(false);

    const panel = renderPanel();
    await waitFor(() => expect(isAiContinueAvailable()).toBe(true));

    panel.unmount();
    expect(isAiContinueAvailable()).toBe(false);
  });

  it("never touches the document before the author accepts a draft", async () => {
    const harness = await renderEditor({ initialDocument: paragraphDocument("hello world") });
    const panel = renderPanel({ editor: harness.editor });
    await openPanel();

    const before = JSON.stringify(harness.editor.getJSON());

    await userEvent.click(screen.getByTestId("ai-summarize"));
    expect(streamState.start).toHaveBeenCalledWith(SUMMARIZE_PATH, {
      noteId: NOTE_ID,
      text: "hello world",
      length: "medium",
    });

    // Mid-stream: deltas are on screen, and the document is untouched.
    streamState.phase = "streaming";
    streamState.text = "A summary";
    panel.refresh();
    expect(JSON.stringify(harness.editor.getJSON())).toBe(before);

    // Finished, previewed, still not accepted: still untouched.
    streamState.phase = "preview";
    streamState.text = "A summary.\n\nAnd a second paragraph.";
    panel.refresh();
    expect(screen.getByTestId("note-ai-preview-text")).toHaveTextContent("A summary.");
    expect(JSON.stringify(harness.editor.getJSON())).toBe(before);

    // Only the explicit accept writes, and it writes an ordinary transaction.
    await userEvent.click(screen.getByTestId("ai-insert-summary"));
    const after = JSON.stringify(harness.editor.getJSON());
    expect(after).not.toBe(before);
    expect(after).toContain("A summary.");
    expect(after).toContain("And a second paragraph.");
    expect(streamState.dismiss).toHaveBeenCalled();
  });

  /*
   * The regression both of these pin was live until integration review.
   *
   * TipTap's `insertContent` is `insertContentAt({from: selection.from, to:
   * selection.to})` — it REPLACES the live selection — and a raw string
   * argument is parsed as HTML, not inserted as text. Together that meant
   * "Insert at cursor" could delete a paragraph the author had selected while
   * reading the draft, and a model talked into emitting markup could put real
   * link and image nodes into someone else's note. The fix is `insertContentAt`
   * at a collapsed position, with JSON content.
   */
  it("adds to the note without consuming a selection the author made while reading", async () => {
    const harness = await renderEditor({ initialDocument: paragraphDocument("hello world") });
    const panel = renderPanel({ editor: harness.editor });
    await openPanel();

    await userEvent.click(screen.getByTestId("ai-summarize"));
    streamState.phase = "preview";
    streamState.text = "A summary.";
    panel.refresh();

    // The author selects "hello" while the draft is on screen.
    act(() => {
      harness.editor.commands.setTextSelection({ from: 1, to: 6 });
    });

    await userEvent.click(screen.getByTestId("ai-insert-summary"));

    const text = harness.editor.state.doc.textBetween(
      0,
      harness.editor.state.doc.content.size,
      "\n",
    );
    expect(text).toContain("hello world");
    expect(text).toContain("A summary.");
  });

  /*
   * The other half of the same regression: `insertContentAt` given BLOCK nodes
   * at an inline position splits the node it lands in, so a caret mid-sentence
   * turned one paragraph into three. Block content goes after the block; a
   * single-block continuation is inline content and still joins at the caret.
   */
  it("adds a multi-paragraph continuation after the block instead of splitting it", async () => {
    const harness = await renderEditor({ initialDocument: paragraphDocument("hello world") });
    const panel = renderPanel({ editor: harness.editor });
    await openPanel();

    act(() => {
      harness.editor.commands.setTextSelection({ from: 6, to: 6 });
    });
    await userEvent.click(screen.getByTestId("ai-continue"));

    streamState.phase = "preview";
    streamState.text = "One.\n\nTwo.";
    panel.refresh();

    await userEvent.click(screen.getByTestId("ai-accept-continuation"));

    const text = harness.editor.state.doc.textBetween(
      0,
      harness.editor.state.doc.content.size,
      "\n",
    );
    expect(text).toContain("hello world");
    expect(text).toContain("One.");
    expect(text).toContain("Two.");
  });

  it("inserts model output as literal text even when it looks like markup", async () => {
    const harness = await renderEditor({ initialDocument: paragraphDocument("hello world") });
    const panel = renderPanel({ editor: harness.editor });
    await openPanel();

    await userEvent.click(screen.getByTestId("ai-summarize"));
    streamState.phase = "preview";
    streamState.text = 'if (a < b) <img src="https://attacker.example/px"> done';
    panel.refresh();

    await userEvent.click(screen.getByTestId("ai-insert-summary"));

    const json = JSON.stringify(harness.editor.getJSON());
    // The angle brackets survive as characters...
    expect(
      harness.editor.state.doc.textBetween(0, harness.editor.state.doc.content.size, "\n"),
    ).toContain('if (a < b) <img src="https://attacker.example/px"> done');
    // ...and no node was conjured out of them.
    expect(json).not.toContain('"type":"image"');
  });

  it("withdraws Replace selection when the captured range changed under the preview", async () => {
    const harness = await renderEditor({ initialDocument: paragraphDocument("hello world") });
    const panel = renderPanel({ editor: harness.editor });
    await openPanel();

    act(() => {
      harness.select(1, 6);
    });
    await waitFor(() =>
      expect(screen.getByTestId("ai-rewrite")).not.toHaveAttribute("aria-disabled"),
    );

    await userEvent.click(screen.getByTestId("ai-rewrite"));
    expect(streamState.start).toHaveBeenCalledWith(REWRITE_PATH, {
      noteId: NOTE_ID,
      text: "hello",
      tone: "professional",
    });

    streamState.phase = "preview";
    streamState.text = "Greetings";
    panel.refresh();
    // While the range still holds what was sent, replacing it is safe.
    expect(screen.getByTestId("ai-replace-selection")).toBeInTheDocument();
    expect(screen.queryByTestId("note-ai-stale-selection")).toBeNull();

    // The document moves under the preview — a remote edit, or the author's own.
    act(() => {
      harness.editor.commands.insertContentAt(1, "X");
    });

    await waitFor(() => expect(screen.queryByTestId("ai-replace-selection")).toBeNull());
    expect(screen.getByTestId("note-ai-stale-selection")).toHaveTextContent(
      /changed while this rewrite was generating/u,
    );
    // The only accept left is the one that cannot destroy anything.
    expect(screen.getByTestId("ai-insert-rewrite")).toBeInTheDocument();
  });

  it("re-issues the request on regenerate instead of stacking a second preview", async () => {
    const panel = renderPanel();
    await openPanel();

    await userEvent.click(screen.getByTestId("ai-summarize"));
    expect(streamState.start).toHaveBeenCalledTimes(1);

    streamState.phase = "preview";
    streamState.text = "First draft";
    panel.refresh();

    await userEvent.click(screen.getByTestId("ai-regenerate"));
    // `start` aborts whatever is in flight before it begins, so re-invoking it is
    // the whole of "regenerate": there is never a second concurrent preview.
    expect(streamState.start).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId("note-ai-preview")).toHaveLength(1);
  });
});
