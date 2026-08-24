import { GRAMMAR_SEGMENT_MAX, GRAMMAR_SEGMENT_TEXT_MAX_CHARS } from "@notted/shared-types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Part 70 — what the grammar checker sends, when it refuses to send anything,
 * and what an answer is allowed to do to the document.
 *
 * The transport is mocked at its module boundary (`@/lib/ai/requests` has its
 * own suite); the EDITOR is real, because every interesting claim here is about
 * document positions — a suggestion landing on the right span, a stale one
 * landing on nothing — and a fake editor could only ever confirm the arithmetic
 * this file already assumes.
 */
const aiRequests = vi.hoisted(() => ({
  fetchAiStatus: vi.fn(),
  requestGrammarCheck: vi.fn(),
}));
vi.mock("@/lib/ai/requests", () => aiRequests);

import { GRAMMAR_DEBOUNCE_MS, grammarEnabledStorageKey, useGrammarCheck } from "./useGrammarCheck";

import type { GrammarCategory, GrammarSuggestion } from "@notted/shared-types";
import type { NoteDocument } from "@notted/shared-validators";
import type { Editor } from "@tiptap/core";
import type { ReactNode } from "react";

import { getGrammarControl } from "@/lib/ai/grammar-control";
import { renderEditor } from "@/test/editor-harness";

const WORKSPACE_ID = "50000000-0000-4000-8000-000000000001";
const USER_ID = "50000000-0000-4000-8000-000000000002";

/** Nothing to check, so mounting alone never spends a request. */
const EMPTY_DOCUMENT: NoteDocument = { type: "doc", content: [{ type: "paragraph" }] };

const FAULTY = "Their is a error.";

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

function suggestion(
  segmentId: string,
  start: number,
  end: number,
  replacement: string,
  category: GrammarCategory = "grammar",
): GrammarSuggestion {
  return { segmentId, start, end, replacement, message: "Subject and verb disagree.", category };
}

function grammarResult(...suggestions: readonly GrammarSuggestion[]) {
  return { ok: true, data: { suggestions } };
}

interface GrammarRequestBody {
  readonly segments: readonly { readonly id: string; readonly text: string }[];
}

/** The nth request, as the two things every assertion here cares about. */
function requestAt(index: number): {
  readonly segments: readonly { readonly id: string; readonly text: string }[];
  readonly signal: AbortSignal;
} {
  const call: unknown = aiRequests.requestGrammarCheck.mock.calls[index];
  if (call === undefined) throw new Error(`no grammar request at index ${index}`);
  const [, body, options] = call as [string, GrammarRequestBody, { readonly signal: AbortSignal }];
  return { segments: body.segments, signal: options.signal };
}

function segmentIdFor(text: string, index = 0): string {
  const segment = requestAt(index).segments.find((candidate) => candidate.text === text);
  if (segment === undefined) throw new Error(`segment for ${JSON.stringify(text)} was not sent`);
  return segment.id;
}

function deferred<T>() {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

/**
 * Replace the whole document with these paragraphs, in ONE dispatched
 * transaction, so the editor emits exactly one `update` per call.
 */
function writeParagraphs(editor: Editor, texts: readonly string[]): void {
  const { schema } = editor.state;
  const paragraph = schema.nodes.paragraph;
  const doc = schema.nodes.doc;
  if (paragraph === undefined || doc === undefined) throw new Error("editor schema is incomplete");
  const nodes = texts.map((text) =>
    paragraph.create(null, text.length === 0 ? null : schema.text(text)),
  );
  const replacement = doc.create(null, nodes);
  act(() => {
    editor.view.dispatch(
      editor.state.tr.replaceWith(0, editor.state.doc.content.size, replacement.content),
    );
  });
}

async function advance(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Past the debounce and through whatever the response handler awaits. */
async function settleCheck(): Promise<void> {
  await advance(GRAMMAR_DEBOUNCE_MS);
  await advance(0);
}

interface MountOptions {
  readonly stored?: string;
  readonly aiEnabled?: boolean;
  readonly editable?: boolean;
  readonly signedOut?: boolean;
}

async function mount(options: MountOptions = {}) {
  if (options.stored !== undefined) {
    window.localStorage.setItem(grammarEnabledStorageKey(USER_ID), options.stored);
  }
  aiRequests.fetchAiStatus.mockResolvedValue(statusResult(options.aiEnabled ?? true));

  // The editor is rendered on REAL timers: its readiness is awaited through
  // testing-library, and faking the clock around that only makes it flaky.
  const harness = await renderEditor({ initialDocument: EMPTY_DOCUMENT });
  vi.useFakeTimers();

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () =>
      useGrammarCheck({
        workspaceId: WORKSPACE_ID,
        editor: harness.editor,
        editable: options.editable ?? true,
        userId: options.signedOut === true ? undefined : USER_ID,
      }),
    { wrapper },
  );
  // Let the AI status query resolve, so the feature reaches its real state.
  await advance(0);
  return { editor: harness.editor, hook };
}

/** The store is the only route to the toggle, exactly as the panel uses it. */
function setEnabled(next: boolean): void {
  const control = getGrammarControl();
  if (control === null) throw new Error("no grammar control was registered");
  act(() => {
    control.setEnabled(next);
  });
}

beforeEach(() => {
  aiRequests.requestGrammarCheck.mockResolvedValue(grammarResult());
});

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("useGrammarCheck", () => {
  describe("the preference", () => {
    it("defaults OFF, sends nothing, and reports no acknowledgement", async () => {
      const { editor } = await mount();

      expect(getGrammarControl()?.enabled).toBe(false);
      expect(getGrammarControl()?.acknowledged).toBe(false);

      writeParagraphs(editor, [FAULTY]);
      await settleCheck();

      expect(aiRequests.requestGrammarCheck).not.toHaveBeenCalled();
    });

    it("round-trips through localStorage and acknowledges on the first write", async () => {
      const { editor } = await mount();

      setEnabled(true);

      expect(window.localStorage.getItem(grammarEnabledStorageKey(USER_ID))).toBe("true");
      expect(getGrammarControl()?.enabled).toBe(true);
      expect(getGrammarControl()?.acknowledged).toBe(true);

      writeParagraphs(editor, [FAULTY]);
      await settleCheck();
      expect(aiRequests.requestGrammarCheck).toHaveBeenCalledTimes(1);
    });

    it("treats a stored 'false' as acknowledged but off", async () => {
      await mount({ stored: "false" });

      expect(getGrammarControl()?.enabled).toBe(false);
      expect(getGrammarControl()?.acknowledged).toBe(true);
    });

    it("survives a localStorage that throws on every access", async () => {
      const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("storage is disabled");
      });
      const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("storage is disabled");
      });

      const { editor } = await mount();
      expect(getGrammarControl()?.enabled).toBe(false);

      // The choice still applies to this session; only its survival is lost.
      setEnabled(true);
      expect(getGrammarControl()?.enabled).toBe(true);

      writeParagraphs(editor, [FAULTY]);
      await settleCheck();
      expect(aiRequests.requestGrammarCheck).toHaveBeenCalledTimes(1);

      read.mockRestore();
      write.mockRestore();
    });

    it("registers no control at all without a user", async () => {
      await mount({ signedOut: true, stored: "true" });

      expect(getGrammarControl()).toBeNull();
      expect(aiRequests.requestGrammarCheck).not.toHaveBeenCalled();
    });
  });

  describe("segmentation", () => {
    it("batches rapid edits into ONE request for the final document", async () => {
      const { editor } = await mount({ stored: "true" });

      writeParagraphs(editor, ["first draft"]);
      await advance(GRAMMAR_DEBOUNCE_MS / 3);
      writeParagraphs(editor, ["second draft"]);
      await advance(GRAMMAR_DEBOUNCE_MS / 3);
      writeParagraphs(editor, ["third draft"]);
      expect(aiRequests.requestGrammarCheck).not.toHaveBeenCalled();

      await settleCheck();

      expect(aiRequests.requestGrammarCheck).toHaveBeenCalledTimes(1);
      expect(requestAt(0).segments.map((segment) => segment.text)).toEqual(["third draft"]);
    });

    it("sends only the block that changed on a later edit", async () => {
      const { editor } = await mount({ stored: "true" });

      writeParagraphs(editor, ["one unchanged block", "one that will change"]);
      await settleCheck();
      expect(requestAt(0).segments).toHaveLength(2);

      writeParagraphs(editor, ["one unchanged block", "one that has now changed"]);
      await settleCheck();

      expect(aiRequests.requestGrammarCheck).toHaveBeenCalledTimes(2);
      expect(requestAt(1).segments.map((segment) => segment.text)).toEqual([
        "one that has now changed",
      ]);
    });

    it("skips an over-long block whole rather than splitting it", async () => {
      const { editor } = await mount({ stored: "true" });
      const huge = "x".repeat(GRAMMAR_SEGMENT_TEXT_MAX_CHARS + 1);

      writeParagraphs(editor, [huge, "a short block"]);
      await settleCheck();

      expect(requestAt(0).segments.map((segment) => segment.text)).toEqual(["a short block"]);
    });

    it("caps one request at the shared batch size", async () => {
      const { editor } = await mount({ stored: "true" });
      const paragraphs = Array.from(
        { length: GRAMMAR_SEGMENT_MAX + 5 },
        (_unused, index) => `paragraph number ${index}`,
      );

      writeParagraphs(editor, paragraphs);
      await settleCheck();

      expect(requestAt(0).segments).toHaveLength(GRAMMAR_SEGMENT_MAX);
    });
  });

  describe("responses", () => {
    it("drops a suggestion whose block changed while the request was in flight", async () => {
      const pending = deferred<unknown>();
      aiRequests.requestGrammarCheck.mockReturnValue(pending.promise);
      const { editor, hook } = await mount({ stored: "true" });

      writeParagraphs(editor, [FAULTY]);
      await advance(GRAMMAR_DEBOUNCE_MS);
      const segmentId = segmentIdFor(FAULTY);

      // The author keeps typing: the block the answer describes is gone.
      writeParagraphs(editor, ["Something else entirely."]);
      pending.resolve(grammarResult(suggestion(segmentId, 0, 5, "There")));
      await advance(0);

      expect(hook.result.current.resolveSuggestions()).toHaveLength(0);
    });

    it("anchors a suggestion to the exact span it describes", async () => {
      const { editor, hook } = await mount({ stored: "true" });
      aiRequests.requestGrammarCheck.mockImplementation((_workspace, body: GrammarRequestBody) =>
        Promise.resolve(
          grammarResult(suggestion(body.segments[0]?.id ?? "missing", 0, 5, "There")),
        ),
      );

      writeParagraphs(editor, [FAULTY]);
      await settleCheck();

      const targets = hook.result.current.resolveSuggestions();
      expect(targets).toHaveLength(1);
      expect(targets[0]?.originalText).toBe("Their");
      expect(hook.result.current.getSuggestion(targets[0]?.id ?? "")?.replacement).toBe("There");
    });
  });

  describe("accept", () => {
    async function mountWithSuggestion(replacement: string) {
      const mounted = await mount({ stored: "true" });
      aiRequests.requestGrammarCheck.mockImplementation((_workspace, body: GrammarRequestBody) =>
        Promise.resolve(
          grammarResult(suggestion(body.segments[0]?.id ?? "missing", 0, 5, replacement)),
        ),
      );
      writeParagraphs(mounted.editor, [FAULTY]);
      await settleCheck();
      const [target] = mounted.hook.result.current.resolveSuggestions();
      if (target === undefined) throw new Error("no suggestion was anchored");
      return { ...mounted, id: target.id };
    }

    it("replaces exactly the suggested span", async () => {
      const { editor, hook, id } = await mountWithSuggestion("There");

      act(() => {
        hook.result.current.accept(id);
      });

      expect(editor.state.doc.textContent).toBe("There is a error.");
      expect(hook.result.current.resolveSuggestions()).toHaveLength(0);
    });

    it("inserts markup-looking replacements as literal text", async () => {
      const { editor, hook, id } = await mountWithSuggestion("<b>x</b>");

      act(() => {
        hook.result.current.accept(id);
      });

      expect(editor.state.doc.textContent).toBe("<b>x</b> is a error.");
      // The text arrived as text: no mark, and no element node was parsed.
      expect(editor.state.doc.firstChild?.firstChild?.marks).toHaveLength(0);
    });

    it("deletes the span when the replacement is empty", async () => {
      const { editor, hook, id } = await mountWithSuggestion("");

      act(() => {
        hook.result.current.accept(id);
      });

      expect(editor.state.doc.textContent).toBe(" is a error.");
    });

    it("is a no-op on a stale suggestion and leaves the document byte-identical", async () => {
      const { editor, hook, id } = await mountWithSuggestion("There");

      // The anchored words are overwritten by someone — this author or a peer.
      writeParagraphs(editor, ["Whose is a error."]);
      const before = JSON.stringify(editor.getJSON());

      act(() => {
        hook.result.current.accept(id);
      });

      expect(JSON.stringify(editor.getJSON())).toBe(before);
      expect(hook.result.current.resolveSuggestions()).toHaveLength(0);
      expect(getGrammarControl()?.announcement).toMatch(/changed/iu);
    });
  });

  describe("dismiss", () => {
    it("survives a later re-check of the same block", async () => {
      const { editor, hook } = await mount({ stored: "true" });
      aiRequests.requestGrammarCheck.mockImplementation((_workspace, body: GrammarRequestBody) =>
        Promise.resolve(
          grammarResult(suggestion(body.segments[0]?.id ?? "missing", 0, 5, "There")),
        ),
      );

      writeParagraphs(editor, [FAULTY]);
      await settleCheck();
      const [target] = hook.result.current.resolveSuggestions();
      if (target === undefined) throw new Error("no suggestion was anchored");

      act(() => {
        hook.result.current.dismiss(target.id);
      });
      expect(hook.result.current.resolveSuggestions()).toHaveLength(0);
      expect(editor.state.doc.textContent).toBe(FAULTY);

      // Off and on again forgets what has been CHECKED, so the same block is
      // sent a second time and the same advice comes back.
      setEnabled(false);
      setEnabled(true);
      await settleCheck();

      expect(aiRequests.requestGrammarCheck).toHaveBeenCalledTimes(2);
      expect(hook.result.current.resolveSuggestions()).toHaveLength(0);
    });
  });

  describe("disabling", () => {
    it("aborts the in-flight request and sends nothing afterwards", async () => {
      const pending = deferred<unknown>();
      aiRequests.requestGrammarCheck.mockReturnValue(pending.promise);
      const { editor, hook } = await mount({ stored: "true" });

      writeParagraphs(editor, [FAULTY]);
      await advance(GRAMMAR_DEBOUNCE_MS);
      expect(aiRequests.requestGrammarCheck).toHaveBeenCalledTimes(1);
      expect(requestAt(0).signal.aborted).toBe(false);
      const segmentId = segmentIdFor(FAULTY);

      setEnabled(false);
      expect(requestAt(0).signal.aborted).toBe(true);

      // Whatever the aborted request eventually resolves to changes nothing.
      pending.resolve(grammarResult(suggestion(segmentId, 0, 5, "There")));
      await advance(0);
      expect(hook.result.current.resolveSuggestions()).toHaveLength(0);

      writeParagraphs(editor, ["More writing, and more after that."]);
      await settleCheck();
      expect(aiRequests.requestGrammarCheck).toHaveBeenCalledTimes(1);
    });
  });

  describe("a workspace with AI switched off", () => {
    it("never sends a request and refuses the toggle with a reason", async () => {
      const { editor } = await mount({ aiEnabled: false, stored: "true" });

      writeParagraphs(editor, [FAULTY]);
      await settleCheck();
      expect(aiRequests.requestGrammarCheck).not.toHaveBeenCalled();

      // The control still exists — a toggle that vanishes explains nothing.
      expect(getGrammarControl()).not.toBeNull();
      setEnabled(true);

      expect(getGrammarControl()?.enabled).toBe(false);
      expect(getGrammarControl()?.announcement).toMatch(/not enabled for this workspace/iu);
      expect(aiRequests.requestGrammarCheck).not.toHaveBeenCalled();
    });
  });
});
