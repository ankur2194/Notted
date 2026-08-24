"use client";

import { AI_API_PATHS, AI_SUMMARY_LENGTHS, AI_TONES } from "@notted/shared-types";
import {
  AI_CONTINUE_MAX_CHARS,
  AI_REWRITE_MAX_CHARS,
  AI_SUMMARIZE_MAX_CHARS,
} from "@notted/shared-validators";
import { useQuery } from "@tanstack/react-query";
import { ClipboardCopy, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { GrammarToggle } from "./GrammarToggle";

import type { AiSummaryLength, AiTone } from "@notted/shared-types";
import type { Editor, JSONContent } from "@tiptap/core";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { setAiContinueHandler } from "@/lib/ai/continue-request";
import {
  openMeetingExtraction,
  useMeetingExtractionAvailable,
} from "@/lib/ai/meeting-extraction-request";
import { aiQueryKeys } from "@/lib/ai/query-keys";
import { fetchAiStatus } from "@/lib/ai/requests";
import { AI_FAILURE_MESSAGES } from "@/lib/ai/stream";
import { useAiStream } from "@/lib/ai/use-ai-stream";

/**
 * Part 68 — summarize, continue writing, and tone rewrite.
 *
 * ## THE INVARIANT
 *
 * **Nothing generated here reaches the note until the author accepts it.** No
 * preview text is written into the document, no draft is autosaved, and this
 * component never calls `updateNote`: Part 58 gives the server's Yjs projection
 * ownership of `notes.content` while a collaborative session is live, so a note
 * write issued from here would race the projection and lose. Accepted text goes
 * in through an ordinary `editor.chain()` transaction and nothing else — Yjs
 * picks it up when the session is collaborative, Part 39 autosave when it is
 * solo. Both already handle a normal transaction; neither needs to know an AI
 * produced it.
 *
 * ## Shape
 *
 * The `NoteComments` inline disclosure, for the same reasons: one persistent
 * toggle that owns `aria-expanded`/`aria-controls` so focus never lands on
 * `<body>` on a transition, and one polite live region mounted for the whole
 * panel — a live region created together with its text is frequently not
 * announced at all.
 *
 * ## What the live region says, and what it deliberately does not
 *
 * Phase transitions only. Putting the streaming text in the live region would
 * re-announce a growing string several times a second, which is a screen-reader
 * flood, not a feature. The draft itself is ordinary `pre-wrap` text a reader
 * navigates when they choose to.
 *
 * ## One stream, three features
 *
 * A single {@link useAiStream} run at a time, because the panel has a single
 * preview slot and `start` already aborts whatever is in flight. `feature`
 * records which button produced the text currently on screen, since that is what
 * decides what "accept" means.
 */

export interface AiPanelProps {
  readonly workspaceId: string;
  readonly noteId: string;
  readonly editor: Editor | null;
  /** False for a viewer or a trashed note: the panel renders nothing at all. */
  readonly editable: boolean;
}

type AiFeature = "summarize" | "continue" | "rewrite";

/** What a rewrite was asked to rewrite, frozen at request time. */
interface RewriteCapture {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

const PANEL_ID = "note-ai-panel";
const HEADING_ID = "note-ai-heading";

const STATUS_UNAVAILABLE_MESSAGE = "AI is unavailable right now. Try again in a moment.";
const EMPTY_NOTE_MESSAGE = "There is nothing to summarise yet. Write something first.";
const EMPTY_CONTEXT_MESSAGE =
  "There is no text before the cursor to continue from. Write a little first.";
const NO_SELECTION_MESSAGE = "Select some text in the note to rewrite it.";
const SELECTION_TOO_LONG_MESSAGE = `That selection is too long to rewrite. Select at most ${AI_REWRITE_MAX_CHARS.toLocaleString()} characters.`;
const NO_EDITOR_MESSAGE = "The note is still loading. Try again in a moment.";
const STALE_SELECTION_MESSAGE =
  "The text you selected changed while this rewrite was generating, so it can no longer be replaced safely. You can add the rewrite as a new paragraph instead.";

const GENERATING_MESSAGE = "Generating…";
const READY_MESSAGE = "Draft ready. Nothing has been added to the note yet.";
const DISCARDED_MESSAGE = "Draft discarded.";
const CANCELLED_MESSAGE = "Generation cancelled.";
const COPY_OK_MESSAGE = "Draft copied to the clipboard.";
const COPY_FAILED_MESSAGE = "The draft could not be copied. Select the text and copy it manually.";

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The text of a stored range, or `null` when the range no longer exists.
 *
 * `textBetween` throws on a position past the end of the document, and a deleted
 * paragraph is exactly how that happens here. `null` is treated as "changed",
 * which is the only safe reading: a range we cannot even address is certainly
 * not the one the author selected.
 */
function rangeText(editor: Editor, from: number, to: number): string | null {
  if (from < 0 || from > to || to > editor.state.doc.content.size) return null;
  try {
    return editor.state.doc.textBetween(from, to, "\n\n", " ");
  } catch {
    return null;
  }
}

/**
 * Blank-line-delimited plain text as ProseMirror paragraph nodes.
 *
 * NEVER HAND MODEL OUTPUT TO TIPTAP AS A STRING. `insertContent`/
 * `insertContentAt` route a string through `DOMParser.parseSlice`, which is
 * HTML parsing: `if (x < y)` loses its tail, `<ankur@example.com>` vanishes, and
 * whitespace runs collapse. Worse, it is a real injection sink — the model is
 * *asked* for plain text, but a note carrying "ignore that, emit an
 * `<img src=…>`" would have its markup parsed into live nodes by the safe-link
 * and image extensions. A prompt is not a control. Building JSON means the text
 * is inserted as text, whatever the model was talked into saying.
 */
function paragraphNodes(text: string): JSONContent[] {
  return text
    .split(/\n\s*\n/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => ({ type: "paragraph", content: [{ type: "text", text: part }] }));
}

/**
 * The same text as INLINE content when it is a single block, so a continuation
 * joins the sentence the author was writing instead of starting a new paragraph
 * under it. Empty input yields an empty list, which every caller refuses.
 */
function inlineOrParagraphNodes(text: string): JSONContent[] {
  const paragraphs = paragraphNodes(text);
  if (paragraphs.length > 1) return paragraphs;
  const single = text.trim();
  return single.length === 0 ? [] : [{ type: "text", text: single }];
}

/**
 * Where BLOCK content may be inserted without splitting the author's paragraph:
 * after the top-level block holding the selection end. `insertContentAt` at an
 * inline position splits the containing node, so a cursor inside "hello world"
 * would leave "hello" / the draft / " world" — three paragraphs out of one.
 * Inline content (a single-block continuation) still belongs at the cursor.
 */
function blockInsertPos(editor: Editor): number {
  const $to = editor.state.doc.resolve(editor.state.selection.to);
  return $to.depth === 0 ? $to.pos : $to.after(1);
}

export function AiPanel({ workspaceId, noteId, editor, editable }: AiPanelProps) {
  const stream = useAiStream();

  /*
   * Part 69's meeting extraction is a LAUNCHER here and nothing more. It never
   * streams — its answer is one structured object a human reviews as a whole —
   * so it owns its own dialog, its own request, and its own live region, and
   * deliberately does not join `AiFeature`, `renderPreviewActions`, or
   * `regenerate`. This panel only knows whether the dialog is mounted.
   */
  const meetingExtractionAvailable = useMeetingExtractionAvailable();

  const [open, setOpen] = useState(false);
  const [feature, setFeature] = useState<AiFeature | null>(null);
  const [length, setLength] = useState<AiSummaryLength>("medium");
  const [tone, setTone] = useState<AiTone>("professional");
  const [capture, setCapture] = useState<RewriteCapture | null>(null);
  const [rewriteStale, setRewriteStale] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  /** A refusal this component made itself, before any request left the browser. */
  const [notice, setNotice] = useState("");
  const [announcement, setAnnouncement] = useState("");

  /*
   * Where the caret was when a continuation was requested.
   *
   * It is NOT the insertion point. Accept inserts at the CURRENT caret, because
   * that is where the author is looking and — in a collaborative session — a
   * position captured tens of seconds ago may now sit in the middle of someone
   * else's sentence. The captured value is kept only to tell the author when the
   * two differ, so an insert somewhere other than where they pressed the button
   * is announced rather than surprising.
   */
  const continueFromRef = useRef<number | null>(null);

  const status = useQuery({
    queryKey: aiQueryKeys.status(workspaceId),
    queryFn: async () => {
      const result = await fetchAiStatus(workspaceId);
      // A failed status read must not resolve to "AI is off": that is
      // indistinguishable from an admin having disabled it, and the copy for the
      // two is different. Throwing keeps it an error state with a retry.
      if (!result.ok) throw new Error(`ai status unavailable: ${result.kind}`);
      return result.data;
    },
    // A note the reader cannot edit offers no AI action, so it asks nothing.
    enabled: editable,
    staleTime: 5 * 60_000,
  });

  const enabled = status.data?.enabled === true;
  const configured = status.data !== undefined && status.data.provider !== "disabled";
  const ready = enabled && configured && editor !== null;

  /**
   * Why the toggle is inert, or `null` when it is not.
   *
   * A missing button is indistinguishable from a bug, so the control is always
   * mounted and explains itself. The copy for the governance cases is the same
   * copy the server would have sent back, so a client-side refusal and a
   * server-side one read identically.
   */
  const unavailableReason: string | null = status.isPending
    ? null
    : status.isError
      ? STATUS_UNAVAILABLE_MESSAGE
      : !enabled
        ? AI_FAILURE_MESSAGES.AI_DISABLED
        : !configured
          ? AI_FAILURE_MESSAGES.AI_NOT_CONFIGURED
          : null;

  /* --------------------------------------------------------------------- *
   * Editor-derived state. One subscription, because `transaction` fires for
   * both of the things watched here: the selection moving, and the document
   * changing under a rewrite that has not been accepted yet.
   * --------------------------------------------------------------------- */
  useEffect(() => {
    if (editor === null || !open) return;
    const sync = (): void => {
      const { from, to } = editor.state.selection;
      setHasSelection(from !== to);
      setRewriteStale(
        capture !== null && rangeText(editor, capture.from, capture.to) !== capture.text,
      );
    };
    sync();
    editor.on("transaction", sync);
    return () => {
      editor.off("transaction", sync);
    };
  }, [capture, editor, open]);

  /* --------------------------------------------------------------------- *
   * The live region. Transitions only — never the text itself.
   * --------------------------------------------------------------------- */
  const previousPhase = useRef(stream.phase);
  useEffect(() => {
    if (previousPhase.current === stream.phase) return;
    previousPhase.current = stream.phase;
    if (stream.phase === "streaming") setAnnouncement(GENERATING_MESSAGE);
    else if (stream.phase === "preview") setAnnouncement(READY_MESSAGE);
    else if (stream.phase === "error") setAnnouncement(stream.error ?? STATUS_UNAVAILABLE_MESSAGE);
  }, [stream.error, stream.phase]);

  /** A refusal we made ourselves: shown to a sighted reader and announced once. */
  const refuse = useCallback((message: string): void => {
    setNotice(message);
    setAnnouncement(message);
  }, []);

  /* --------------------------------------------------------------------- *
   * Requests. Each one clears the previous preview implicitly: `start` aborts
   * whatever is in flight, so a second feature cannot stack onto the first.
   * --------------------------------------------------------------------- */

  const startSummarize = useCallback((): void => {
    if (editor === null) return refuse(NO_EDITOR_MESSAGE);
    /*
     * `textBetween(…, "\n\n", " ")`, not `doc.textContent`: the latter is
     * `textBetween(0, size, "")`, which joins blocks with NOTHING — a
     * three-paragraph note reaches the model as "para oneparee twopara three"
     * and every paragraph boundary the summary should respect is gone.
     */
    const text = editor.state.doc
      .textBetween(0, editor.state.doc.content.size, "\n\n", " ")
      .slice(0, AI_SUMMARIZE_MAX_CHARS);
    // The shared schema trims and requires at least one character, so a blank
    // note would spend a provider call to be told what is knowable here.
    if (text.trim().length === 0) return refuse(EMPTY_NOTE_MESSAGE);
    setNotice("");
    setCapture(null);
    setFeature("summarize");
    stream.start(AI_API_PATHS.summarize(workspaceId), { noteId, text, length });
  }, [editor, length, noteId, refuse, stream, workspaceId]);

  const startContinue = useCallback((): boolean => {
    if (editor === null) {
      refuse(NO_EDITOR_MESSAGE);
      return true;
    }
    // Only what precedes the caret, tail-truncated: the model continues from the
    // end of the context, so the characters nearest the caret are the ones that
    // must survive the ceiling.
    const context = editor.state.doc
      .textBetween(0, editor.state.selection.from, "\n\n", " ")
      .slice(-AI_CONTINUE_MAX_CHARS);
    if (context.trim().length === 0) {
      // Still "handled": the author asked for a continuation and gets an
      // explanation. Falling through to HardBreak here would insert a line break
      // and leave them wondering why nothing generated.
      refuse(EMPTY_CONTEXT_MESSAGE);
      return true;
    }
    setNotice("");
    setCapture(null);
    setFeature("continue");
    continueFromRef.current = editor.state.selection.from;
    // The wire field is `context`, not `text` — see `aiContinueRequestSchema`.
    stream.start(AI_API_PATHS.continue(workspaceId), { noteId, context });
    return true;
  }, [editor, noteId, refuse, stream, workspaceId]);

  const startRewrite = useCallback(
    (nextTone: AiTone): void => {
      if (editor === null) return refuse(NO_EDITOR_MESSAGE);
      const { from, to } = editor.state.selection;
      if (from === to) return refuse(NO_SELECTION_MESSAGE);
      const text = editor.state.doc.textBetween(from, to, "\n\n", " ");
      if (text.trim().length === 0) return refuse(NO_SELECTION_MESSAGE);
      /*
       * Refused rather than truncated. Truncating would rewrite the first 4,000
       * characters and then offer to replace the WHOLE selection with the
       * result, silently deleting everything past the ceiling.
       */
      if (text.length > AI_REWRITE_MAX_CHARS) return refuse(SELECTION_TOO_LONG_MESSAGE);
      setNotice("");
      setFeature("rewrite");
      setCapture({ from, to, text });
      setRewriteStale(false);
      stream.start(AI_API_PATHS.rewrite(workspaceId), { noteId, text, tone: nextTone });
    },
    [editor, noteId, refuse, stream, workspaceId],
  );

  /*
   * The toolbar button and the `Mod-Enter` keymap reach "continue writing"
   * through this one slot. Registered only while the panel can actually serve
   * the command, so `isAiContinueAvailable()` is also the honest answer to
   * "should the toolbar offer it" — and `Mod-Enter` falls through to HardBreak
   * when it is not registered, instead of being swallowed.
   *
   * The cleanup is not optional: a handler that outlives its panel fires into a
   * dead component and would start a billed generation nothing can display.
   */
  /*
   * Registered through a ref, NOT as a dependency. `useAiStream` returns a fresh
   * object every render, so `startContinue` has a new identity every render too;
   * depending on it directly would withdraw and re-register the handler on each
   * one, and `setAiContinueHandler` notifies its subscribers — the toolbar
   * re-renders, which re-renders this, which re-registers. A stable wrapper over
   * a ref registers exactly once per availability change.
   */
  const continueRef = useRef(startContinue);
  useEffect(() => {
    continueRef.current = startContinue;
  }, [startContinue]);

  useEffect(() => {
    if (!editable || !ready) return;
    const handler = (): boolean => {
      setOpen(true);
      return continueRef.current();
    };
    setAiContinueHandler(handler);
    return () => {
      setAiContinueHandler(null);
    };
  }, [editable, ready]);

  /* --------------------------------------------------------------------- *
   * Accepting. The ONLY code in this file that touches the document.
   * --------------------------------------------------------------------- */

  const insertAsParagraphs = useCallback(
    (text: string, message: string): void => {
      if (editor === null) return refuse(NO_EDITOR_MESSAGE);
      const nodes = paragraphNodes(text);
      if (nodes.length === 0) return refuse("The draft was empty, so nothing was added.");
      /*
       * `insertContentAt(selection.to)`, NEVER `insertContent`. The latter is
       * `insertContentAt({from: tr.selection.from, to: tr.selection.to})` — it
       * REPLACES the live selection. An author who selected a paragraph while
       * reading the draft would have it silently deleted by a button labelled
       * "Insert at cursor", and in the rewrite flow the stale-range fallback
       * would destroy the very text the guard just refused to touch.
       * Collapsing to `to` inserts after the selection and deletes nothing, and
       * `blockInsertPos` keeps these paragraphs from splitting the one the
       * selection ends inside.
       */
      editor.chain().focus().insertContentAt(blockInsertPos(editor), nodes).run();
      setFeature(null);
      setCapture(null);
      stream.dismiss();
      setAnnouncement(message);
    },
    [editor, refuse, stream],
  );

  const acceptContinuation = useCallback((): void => {
    if (editor === null) return refuse(NO_EDITOR_MESSAGE);
    const moved =
      continueFromRef.current !== null && continueFromRef.current !== editor.state.selection.from;
    const nodes = inlineOrParagraphNodes(stream.text);
    if (nodes.length === 0) return refuse("The draft was empty, so nothing was added.");
    // Same two rules as `insertAsParagraphs`: insert at a COLLAPSED position so
    // a live selection survives, and as JSON so the text arrives as text. A
    // single-block continuation is inline content and joins the sentence at the
    // cursor; a multi-paragraph one is blocks, so it goes after the block.
    const at = nodes[0]?.type === "paragraph" ? blockInsertPos(editor) : editor.state.selection.to;
    editor.chain().focus().insertContentAt(at, nodes).run();
    setFeature(null);
    stream.dismiss();
    setAnnouncement(
      moved
        ? "Continuation inserted at the cursor, which has moved since the draft was requested."
        : "Continuation inserted.",
    );
  }, [editor, refuse, stream]);

  const replaceSelection = useCallback((): void => {
    if (editor === null || capture === null) return refuse(NO_EDITOR_MESSAGE);
    /*
     * THE GUARD, re-checked at the moment of the write rather than trusted from
     * the render that drew the button. Between the two there is at least one
     * event loop turn, and in a collaborative session a remote transaction can
     * land inside it. Replacing a range we can no longer prove is the one the
     * author selected would silently destroy someone else's text.
     */
    if (rangeText(editor, capture.from, capture.to) !== capture.text) {
      setRewriteStale(true);
      return refuse(STALE_SELECTION_MESSAGE);
    }
    const nodes = inlineOrParagraphNodes(stream.text);
    if (nodes.length === 0) return refuse("The rewrite was empty, so nothing was replaced.");
    // The range here IS the intended target — it was just re-proven — so unlike
    // the two insert paths this one deliberately spans `from`..`to`. The content
    // is still JSON, so model output can never be parsed as markup.
    editor.chain().focus().insertContentAt({ from: capture.from, to: capture.to }, nodes).run();
    setFeature(null);
    setCapture(null);
    stream.dismiss();
    setAnnouncement("Selection replaced with the rewrite.");
  }, [capture, editor, refuse, stream]);

  const regenerate = useCallback((): void => {
    if (feature === "summarize") return startSummarize();
    if (feature === "continue") {
      startContinue();
      return;
    }
    if (feature === "rewrite" && capture !== null) {
      /*
       * The ORIGINAL captured text, not the current selection. Re-reading the
       * selection would quietly re-aim the rewrite at whatever is selected now,
       * and the Replace action would then be offered over a range the preview
       * was never about.
       */
      setNotice("");
      stream.start(AI_API_PATHS.rewrite(workspaceId), {
        noteId,
        text: capture.text,
        tone,
      });
    }
  }, [capture, feature, noteId, startContinue, startSummarize, stream, tone, workspaceId]);

  const dismiss = useCallback((): void => {
    stream.dismiss();
    setFeature(null);
    setCapture(null);
    setNotice("");
    setAnnouncement(DISCARDED_MESSAGE);
  }, [stream]);

  const cancel = useCallback((): void => {
    stream.cancel();
    setFeature(null);
    setCapture(null);
    setAnnouncement(CANCELLED_MESSAGE);
  }, [stream]);

  const copyDraft = useCallback((): void => {
    void (async () => {
      try {
        // Rejects without a secure context or clipboard permission, and
        // `navigator.clipboard` is simply absent in some embeddings — both land
        // in the same catch because the property read is inside the `try`.
        await navigator.clipboard.writeText(stream.text);
        setAnnouncement(COPY_OK_MESSAGE);
      } catch {
        setAnnouncement(COPY_FAILED_MESSAGE);
      }
    })();
  }, [stream.text]);

  // Hooks above run unconditionally; the render decision comes after them.
  if (!editable) return null;

  const streaming = stream.phase === "streaming";
  const preview = stream.phase === "preview";

  const renderPreviewActions = (): ReactNode => {
    const common = (
      <>
        <Button size="sm" variant="ghost" onClick={regenerate} data-testid="ai-regenerate">
          <RefreshCw aria-hidden="true" /> Regenerate
        </Button>
        <Button size="sm" variant="ghost" onClick={dismiss} data-testid="ai-dismiss">
          Dismiss
        </Button>
      </>
    );
    if (feature === "summarize") {
      return (
        <>
          <Button
            size="sm"
            data-testid="ai-insert-summary"
            onClick={() => insertAsParagraphs(stream.text, "Summary inserted at the cursor.")}
          >
            Insert at cursor
          </Button>
          <Button size="sm" variant="outline" onClick={copyDraft} data-testid="ai-copy">
            <ClipboardCopy aria-hidden="true" /> Copy
          </Button>
          {common}
        </>
      );
    }
    if (feature === "continue") {
      return (
        <>
          <Button size="sm" data-testid="ai-accept-continuation" onClick={acceptContinuation}>
            Accept
          </Button>
          {common}
        </>
      );
    }
    return (
      <>
        {/*
         * Exactly one accept action, and which one depends on whether the
         * captured range still holds the text the rewrite was made from. When it
         * does not, "Replace selection" is ABSENT — not disabled — because a
         * disabled control still advertises an action that must never happen.
         */}
        {rewriteStale ? (
          <Button
            size="sm"
            data-testid="ai-insert-rewrite"
            onClick={() =>
              insertAsParagraphs(stream.text, "Rewrite added as a new paragraph at the cursor.")
            }
          >
            Insert as new paragraph
          </Button>
        ) : (
          <Button size="sm" data-testid="ai-replace-selection" onClick={replaceSelection}>
            Replace selection
          </Button>
        )}
        {common}
      </>
    );
  };

  return (
    <div className="space-y-4" data-notted-print-hide>
      <Button
        variant={open ? "ghost" : "outline"}
        size="sm"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        aria-disabled={unavailableReason !== null ? true : undefined}
        aria-describedby={unavailableReason !== null ? "note-ai-unavailable" : undefined}
        data-testid="note-ai-toggle"
        onClick={() => {
          // `aria-disabled` never makes a control inert on its own; the handler
          // is what refuses, and the control keeps its place in the tab order.
          if (unavailableReason !== null) return;
          setOpen((current) => !current);
        }}
      >
        <Sparkles aria-hidden="true" /> {open ? "Hide AI assistance" : "AI assistance"}
      </Button>

      {unavailableReason !== null ? (
        <p
          id="note-ai-unavailable"
          className="text-sm text-muted-foreground"
          data-testid="note-ai-unavailable"
        >
          {unavailableReason}
          {status.isError ? (
            <Button
              className="ml-2"
              size="sm"
              variant="outline"
              onClick={() => void status.refetch()}
            >
              Retry
            </Button>
          ) : null}
        </p>
      ) : null}

      {open ? (
        <section
          id={PANEL_ID}
          aria-labelledby={HEADING_ID}
          className="space-y-4 rounded-xl border bg-card p-4"
          data-testid="note-ai-panel"
        >
          <h2 id={HEADING_ID} className="text-lg font-semibold">
            AI assistance
          </h2>
          <p className="text-xs text-muted-foreground">
            Drafts appear here for you to review. Nothing is added to the note until you accept it.
          </p>

          {/*
           * The panel's ONE polite region. Phase transitions and the outcome of
           * an action — never the streaming text, which would re-announce a
           * growing string many times a second.
           */}
          <p
            className="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="note-ai-announcement"
          >
            {announcement}
          </p>

          {notice !== "" ? (
            <p className="rounded-md border bg-muted/40 p-3 text-sm" data-testid="note-ai-notice">
              {notice}
            </p>
          ) : null}

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Summarize</h3>
            <div role="group" aria-label="Summary length" className="flex flex-wrap gap-1">
              {AI_SUMMARY_LENGTHS.map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={value === length ? "secondary" : "ghost"}
                  aria-pressed={value === length}
                  onClick={() => setLength(value)}
                >
                  {titleCase(value)}
                </Button>
              ))}
            </div>
            <Button size="sm" variant="outline" data-testid="ai-summarize" onClick={startSummarize}>
              Summarize note
            </Button>
          </div>

          <div className="space-y-2 border-t pt-3">
            <h3 className="text-sm font-semibold">Continue writing</h3>
            <p className="text-xs text-muted-foreground" id="note-ai-continue-hint">
              Drafts a continuation from the text before your cursor.
            </p>
            <Button
              size="sm"
              variant="outline"
              data-testid="ai-continue"
              aria-describedby="note-ai-continue-hint"
              onClick={() => {
                startContinue();
              }}
            >
              Continue writing
            </Button>
          </div>

          <div className="space-y-2 border-t pt-3">
            <h3 className="text-sm font-semibold">Change tone</h3>
            <p className="text-xs text-muted-foreground" id="note-ai-rewrite-hint">
              {hasSelection
                ? "Rewrites the text you have selected in the note."
                : NO_SELECTION_MESSAGE}
            </p>
            <div role="group" aria-label="Tone" className="flex flex-wrap gap-1">
              {AI_TONES.map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={value === tone ? "secondary" : "ghost"}
                  aria-pressed={value === tone}
                  onClick={() => setTone(value)}
                >
                  {titleCase(value)}
                </Button>
              ))}
            </div>
            <Button
              size="sm"
              variant="outline"
              data-testid="ai-rewrite"
              // Never natively disabled: the browser drops a `disabled` element
              // out of the tab order the instant it becomes disabled, and the
              // hint above is what explains why it is unavailable.
              aria-disabled={hasSelection ? undefined : true}
              aria-describedby="note-ai-rewrite-hint"
              onClick={() => {
                if (!hasSelection) return refuse(NO_SELECTION_MESSAGE);
                startRewrite(tone);
              }}
            >
              Rewrite selection
            </Button>
          </div>

          <div className="space-y-2 border-t pt-3">
            <h3 className="text-sm font-semibold">Meeting notes</h3>
            <p className="text-xs text-muted-foreground" id="note-ai-meeting-hint">
              {meetingExtractionAvailable
                ? "Paste a transcript and review the attendees, decisions, and action items before anything is added."
                : "Meeting extraction is not ready on this note yet. Try again in a moment."}
            </p>
            <Button
              size="sm"
              variant="outline"
              data-testid="ai-meeting-extraction"
              // Same posture as "Rewrite selection": never natively disabled, so
              // the control keeps its place in the tab order and the hint above
              // is what explains why it is unavailable.
              aria-disabled={meetingExtractionAvailable ? undefined : true}
              aria-describedby="note-ai-meeting-hint"
              onClick={() => {
                // `openMeetingExtraction` returns false when no dialog is
                // registered; the hint has already said so, so there is nothing
                // further to announce.
                openMeetingExtraction();
              }}
            >
              Extract meeting notes
            </Button>
          </div>

          {/*
           * Part 70. The toggle is handed NOTHING: it reads the control off a
           * module store, exactly as "Continue writing" reaches this panel
           * through `lib/ai/continue-request.ts`. The checking hook lives in
           * `NoteEditorSurface` so a note keeps being checked whether or not
           * this panel is open, and neither component is an ancestor of the
           * other — there is no prop to thread. It renders its own section
           * wrapper, or nothing at all when no control is registered.
           */}
          <GrammarToggle />

          {streaming ? (
            <div className="flex items-center gap-2 border-t pt-3" data-testid="note-ai-streaming">
              <LoaderCircle
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              <span className="text-sm text-muted-foreground">{GENERATING_MESSAGE}</span>
              <Button size="sm" variant="ghost" onClick={cancel} data-testid="ai-cancel">
                Cancel
              </Button>
            </div>
          ) : null}

          {stream.phase === "error" ? (
            <div className="space-y-2 border-t pt-3">
              {/* Announced by the region above; this is the sighted reader's copy. */}
              <p className="text-sm" data-testid="note-ai-error">
                {stream.error}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={regenerate}>
                  <RefreshCw aria-hidden="true" /> Try again
                </Button>
                <Button size="sm" variant="ghost" onClick={dismiss}>
                  Dismiss
                </Button>
              </div>
            </div>
          ) : null}

          {preview ? (
            <div className="space-y-2 border-t pt-3" data-testid="note-ai-preview">
              <h3 className="text-sm font-semibold" id="note-ai-preview-heading">
                Draft
              </h3>
              {feature === "rewrite" && rewriteStale ? (
                <p className="rounded-md border p-3 text-sm" data-testid="note-ai-stale-selection">
                  {STALE_SELECTION_MESSAGE}
                </p>
              ) : null}
              <p
                aria-labelledby="note-ai-preview-heading"
                className="whitespace-pre-wrap rounded-md border bg-background p-3 text-sm"
                data-testid="note-ai-preview-text"
                tabIndex={-1}
              >
                {stream.text}
              </p>
              <div className="flex flex-wrap gap-2">{renderPreviewActions()}</div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
