"use client";

import { GRAMMAR_SEGMENT_MAX, GRAMMAR_SEGMENT_TEXT_MAX_CHARS } from "@notted/shared-types";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GrammarSuggestionTarget } from "@/components/editor/extensions/grammar-decorations";
import type { GrammarControl } from "@/lib/ai/grammar-control";
import type { GrammarCategory, GrammarSuggestion } from "@notted/shared-types";
import type { Editor, JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import {
  createCommentAnchor,
  resolveCommentAnchorInState,
} from "@/components/editor/comment-anchors";
import { refreshGrammarDecorations } from "@/components/editor/extensions/grammar-decorations";
import { setGrammarControl } from "@/lib/ai/grammar-control";
import { aiQueryKeys } from "@/lib/ai/query-keys";
import { fetchAiStatus, requestGrammarCheck } from "@/lib/ai/requests";
import { browserStorage } from "@/lib/notes/page-preferences";

/**
 * Part 70 — the grammar checker: what gets sent, when, and what an answer is
 * allowed to do to the document.
 *
 * ## OFF BY DEFAULT, PER USER, AND THERE IS NO REQUEST PATH WHILE IT IS OFF
 *
 * This is the only AI feature that would send note text WITHOUT the author
 * pressing anything, so the gate is structural rather than a condition checked
 * somewhere on the way back: {@link useGrammarCheck} refuses at the top of the
 * scheduler, before a timer is even armed. Turning it off aborts what is in
 * flight and clears what has been checked, so nothing can arrive afterwards
 * either. The preference is stored per user (never per browser) because two
 * people sharing a machine have made different decisions about sending their
 * prose to a third party, and the disclosure is keyed off whether the key exists
 * at all rather than off its value.
 *
 * ## SEGMENTS ARE HASHED, AND THE HASH IS THE ID
 *
 * A note is checked block by block. Each block's text is hashed, and only blocks
 * whose hash has not been checked before are sent — so an idle document costs
 * nothing, a one-word edit re-checks one paragraph, and the id the server echoes
 * back is the only thing that can be used to find the block again. The server
 * never learns a document position; it cannot, because it is never sent one.
 *
 * ## AN ANSWER IS RE-PROVEN AGAINST THE LIVE DOCUMENT, TWICE
 *
 * Once when the response lands (the block may have been edited while the request
 * was in flight, in this browser or a collaborator's), and again at Accept —
 * because a suggestion sits on screen for as long as the author leaves it there.
 * Between the two, positions are held as Part 60 anchors rather than numbers, so
 * a suggestion survives an unrelated edit above it instead of drifting onto
 * whatever text now occupies those offsets.
 */

export interface UseGrammarCheckOptions {
  readonly workspaceId: string;
  readonly editor: Editor | null;
  readonly editable: boolean;
  /** Absent (a signed-out or preview session) keeps the whole feature inert. */
  readonly userId?: string;
}

/** What the popover renders. The anchor stays inside this module. */
export interface GrammarSuggestionView {
  readonly id: string;
  readonly message: string;
  readonly replacement: string;
  readonly originalText: string;
  readonly category: GrammarCategory;
}

export interface UseGrammarCheckResult {
  /** Stable identity for the whole mount — captured once by the extension. */
  readonly resolveSuggestions: () => readonly GrammarSuggestionTarget[];
  readonly getSuggestion: (id: string) => GrammarSuggestionView | null;
  readonly accept: (id: string) => void;
  readonly dismiss: (id: string) => void;
  readonly enabled: boolean;
}

/**
 * Long enough that a sentence is finished before it is checked, short enough
 * that the underline arrives while the author is still looking at the sentence.
 */
export const GRAMMAR_DEBOUNCE_MS = 1_500;

/**
 * Floor between two COUNT announcements.
 *
 * Counts are incidental — the writer did not ask for them — so a screen reader
 * must not narrate one after every pause in typing. Action outcomes (accepted,
 * dismissed, refused) are never throttled: those answer a keypress.
 */
export const GRAMMAR_ANNOUNCE_THROTTLE_MS = 5_000;

/** Per user, never per browser: two people share a machine, not a decision. */
export function grammarEnabledStorageKey(userId: string): string {
  return `notted.grammar-enabled.${userId}`;
}

const READ_ONLY_MESSAGE = "This note is read-only, so grammar suggestions are not available.";
const NO_EDITOR_MESSAGE = "The note is still loading. Try again in a moment.";
const AI_UNAVAILABLE_MESSAGE =
  "AI is not enabled for this workspace, so grammar suggestions are unavailable.";
const ENABLED_MESSAGE =
  "Grammar suggestions are on. Changed paragraphs are sent to the workspace's AI provider to be checked.";
const DISABLED_MESSAGE = "Grammar suggestions are off. Nothing further will be sent.";
const CHECK_FAILED_MESSAGE = "The grammar check could not be completed. Nothing was changed.";
const STALE_MESSAGE =
  "That text has changed since the suggestion was made, so nothing was replaced.";
const ACCEPTED_MESSAGE = "Suggestion applied.";
const DISMISSED_MESSAGE = "Suggestion dismissed.";

const EMPTY_TARGETS: readonly GrammarSuggestionTarget[] = Object.freeze([]);

/** A suggestion plus the two fields only the popover and Accept need. */
interface GrammarSuggestionRecord extends GrammarSuggestionTarget {
  readonly message: string;
  readonly replacement: string;
}

/** One top-level block, as both a segment to send and a place to draw. */
interface GrammarBlock {
  readonly hash: string;
  readonly text: string;
  /** Position of the block's FIRST TEXT CHARACTER, so `start` is an offset from it. */
  readonly start: number;
}

/**
 * FNV-1a, with the length appended.
 *
 * Six lines instead of a dependency: this is a change detector and a request
 * key, never a security primitive. A collision would mean "this block is
 * unchanged" about a block that changed — which is why nothing downstream trusts
 * it alone: every suggestion is re-proven against the live text before it is
 * drawn and again before it is applied.
 */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}.${text.length.toString(36)}`;
}

/** Survives a re-check of the same block, because it names the CORRECTION. */
function dismissKey(originalText: string, replacement: string): string {
  return hashText(`${originalText} ${replacement}`);
}

/**
 * The document's top-level blocks, as segments.
 *
 * ponytail: a block longer than `GRAMMAR_SEGMENT_TEXT_MAX_CHARS` is skipped
 * WHOLE rather than split. Ceiling: a 2 000+ character paragraph is never
 * checked at all. Upgrade path: split it on sentence boundaries and carry a
 * per-piece offset so the answer's `start`/`end` can be shifted back into the
 * block — the bookkeeping is the entire cost, and a paragraph that long is rare
 * enough that nobody has asked for it yet.
 *
 * ponytail: `start` is `offset + 1`, which is the first text position of a
 * TEXTBLOCK. For a top-level wrapper (a list, a blockquote, a table)
 * `node.textContent` concatenates its descendants' text across node boundaries
 * that positions do count, so the two disagree. That is not guessed at: every
 * suggestion is checked with `doc.textBetween(from, to)` against the exact
 * substring it claims to correct before it is drawn, so a wrapper's suggestions
 * simply drop instead of underlining the wrong words. Ceiling: prose inside
 * lists and quotes is sent for checking and then usually discarded. Upgrade
 * path: walk `doc.descendants` and emit one segment per `node.isTextblock`,
 * which fixes both the positions and the wasted tokens.
 */
function collectBlocks(doc: ProseMirrorNode): GrammarBlock[] {
  const blocks: GrammarBlock[] = [];
  doc.forEach((node, offset) => {
    const text = node.textContent;
    if (text.trim().length === 0) return;
    if (text.length > GRAMMAR_SEGMENT_TEXT_MAX_CHARS) return;
    blocks.push({ hash: hashText(text), text, start: offset + 1 });
  });
  return blocks;
}

/**
 * `textBetween` WITHOUT separator arguments, deliberately: the decoration layer
 * and the Accept guard compare against this exact call, and a separator would
 * make the same range read back differently in the two places. Out-of-range
 * positions throw rather than clamp — a deleted paragraph is exactly how — and
 * `null` is the honest answer for a range this document can no longer address.
 */
function rangeText(editor: Editor, from: number, to: number): string | null {
  if (from < 0 || from >= to || to > editor.state.doc.content.size) return null;
  try {
    return editor.state.doc.textBetween(from, to);
  } catch {
    return null;
  }
}

function countMessage(count: number): string {
  if (count === 0) return "No suggestions.";
  return `${count} suggestion${count === 1 ? "" : "s"}.`;
}

export function useGrammarCheck(options: UseGrammarCheckOptions): UseGrammarCheckResult {
  const { workspaceId, editor, editable, userId } = options;

  const [enabled, setEnabledState] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [checking, setChecking] = useState(false);
  const [count, setCount] = useState(0);
  const [announcement, setAnnouncement] = useState("");

  /*
   * The suggestions themselves live in a ref, not in state: the decoration
   * plugin reads this getter on EVERY editor state update, so its identity — and
   * the identity of the map it reads — must never change. `count`, `checking`
   * and `enabled` are the only derived values a React tree renders, and those
   * are mirrored into state above.
   */
  const suggestionsRef = useRef<Map<string, GrammarSuggestionRecord>>(new Map());
  /** Hashes already checked. An unchanged block is never sent twice. */
  const checkedRef = useRef<Set<string>>(new Set());
  /** Dismissal keys, so a dismissal survives a later re-check of the block. */
  const dismissedRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const announcedAtRef = useRef(0);
  const editorRef = useRef<Editor | null>(editor);
  const workspaceRef = useRef(workspaceId);
  /** Read by the stable callbacks, which cannot close over render values. */
  const activeRef = useRef(false);

  /*
   * The same query key `AiPanel` and `TagSuggestions` use. Sharing it means a
   * note page that already asked for the status pays nothing for this one, and
   * a workspace whose AI is off is known here without a single extra request.
   */
  const status = useQuery({
    queryKey: aiQueryKeys.status(workspaceId),
    queryFn: async () => {
      const outcome = await fetchAiStatus(workspaceId);
      // A failed read must not collapse to "AI is off": that is a different
      // situation, with a different remedy, and it must not silently disable a
      // feature the author turned on.
      if (!outcome.ok) throw new Error(`ai status unavailable: ${outcome.kind}`);
      return outcome.data;
    },
    enabled: editable && userId !== undefined,
    staleTime: 5 * 60_000,
  });

  const aiReady = status.data?.enabled === true && status.data.provider !== "disabled";
  const ready = aiReady && editable && editor !== null;
  /** Everything holds AND the author asked for it. Nothing runs without this. */
  const active = ready && enabled;

  useEffect(() => {
    editorRef.current = editor;
    workspaceRef.current = workspaceId;
    activeRef.current = active;
  }, [active, editor, workspaceId]);

  /**
   * Polite-region text. `throttled` is for counts nobody asked for; an outcome
   * that answers a keypress is always announced.
   *
   * A throttled announcement that is skipped leaves the previous text standing,
   * which is correct: the region describes the last thing worth saying, not the
   * last thing that happened.
   */
  const announce = useCallback((text: string, throttled: boolean): void => {
    if (throttled) {
      const now = Date.now();
      if (now - announcedAtRef.current < GRAMMAR_ANNOUNCE_THROTTLE_MS) return;
      announcedAtRef.current = now;
    }
    setAnnouncement(text);
  }, []);

  const redraw = useCallback((): void => {
    setCount(suggestionsRef.current.size);
    const current = editorRef.current;
    if (current !== null) refreshGrammarDecorations(current);
  }, []);

  /** Turn a batch of answers into anchored suggestions against the LIVE doc. */
  const applySuggestions = useCallback(
    (suggestions: readonly GrammarSuggestion[]): void => {
      const current = editorRef.current;
      if (current === null) return;

      // Prune first: a suggestion whose text no longer reads back is advice
      // about words that are gone, and leaving it underlined would promise an
      // Accept that the guard is going to refuse.
      for (const [id, record] of suggestionsRef.current) {
        const range = resolveCommentAnchorInState(current.state, record.anchor);
        const live = range === null ? null : rangeText(current, range.from, range.to);
        if (live !== record.originalText) suggestionsRef.current.delete(id);
      }

      /*
       * Rebuilt from the CURRENT document, never from the snapshot the request
       * was built on. A block whose hash is no longer here was edited while the
       * request was in flight, and its suggestions describe text that no longer
       * exists — they are dropped by simply not being found.
       */
      const byHash = new Map<string, GrammarBlock[]>();
      for (const block of collectBlocks(current.state.doc)) {
        const existing = byHash.get(block.hash);
        if (existing === undefined) byHash.set(block.hash, [block]);
        else existing.push(block);
      }

      for (const suggestion of suggestions) {
        const blocks = byHash.get(suggestion.segmentId);
        if (blocks === undefined) continue;
        // Two identical paragraphs hash alike and were sent once; the answer
        // applies to both, since they are the same text with the same fault.
        for (const block of blocks) {
          const expected = block.text.slice(suggestion.start, suggestion.end);
          // A collapsed range is a pure insertion, which has no text to anchor
          // to. `createCommentAnchor` would refuse it anyway.
          if (expected.length === 0) continue;
          if (dismissedRef.current.has(dismissKey(expected, suggestion.replacement))) continue;

          const from = block.start + suggestion.start;
          const to = block.start + suggestion.end;
          const originalText = rangeText(current, from, to);
          // THE POSITION PROOF. If the derived range does not read back as the
          // exact substring the answer claims to correct, the mapping is wrong
          // for this block and the suggestion is discarded rather than drawn
          // over whatever happens to live there.
          if (originalText === null || originalText !== expected) continue;

          const anchor = createCommentAnchor(current, from, to);
          if (anchor === null) continue;
          const id = `${suggestion.segmentId}:${from}:${to}`;
          suggestionsRef.current.set(id, {
            id,
            anchor,
            originalText,
            category: suggestion.category,
            message: suggestion.message,
            replacement: suggestion.replacement,
          });
        }
      }

      redraw();
      announce(countMessage(suggestionsRef.current.size), true);
    },
    [announce, redraw],
  );

  const runCheck = useCallback(async (): Promise<void> => {
    const current = editorRef.current;
    if (!activeRef.current || current === null) return;

    // Deduped by hash, capped by the shared contract's batch size, and only
    // ever the blocks that have actually changed.
    const pending = new Map<string, string>();
    for (const block of collectBlocks(current.state.doc)) {
      if (checkedRef.current.has(block.hash) || pending.has(block.hash)) continue;
      pending.set(block.hash, block.text);
      if (pending.size >= GRAMMAR_SEGMENT_MAX) break;
    }
    if (pending.size === 0) return;

    // A newer check supersedes an older one: the document has moved on, and two
    // billed requests for overlapping text answer the same question twice.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setChecking(true);

    const segments = [...pending].map(([id, text]) => ({ id, text }));
    const outcome = await requestGrammarCheck(
      workspaceRef.current,
      { segments },
      { signal: controller.signal },
    );
    // A superseded, disabled, or unmounted check must not write anything,
    // whether the transport reported the abort or resolved just after it.
    if (controller.signal.aborted) return;
    abortRef.current = null;
    setChecking(false);
    if (!activeRef.current) return;

    if (!outcome.ok) {
      // Deliberately NOT marked checked: a failed batch is retried the next time
      // the author touches one of those blocks.
      announce(CHECK_FAILED_MESSAGE, true);
      return;
    }
    for (const hash of pending.keys()) checkedRef.current.add(hash);
    applySuggestions(outcome.data.suggestions);
  }, [announce, applySuggestions]);

  /**
   * THE GATE. Every path to a request runs through here, and it refuses before
   * arming a timer — so "disabled" is not a condition checked on the way back
   * from a request that was already sent, it is the absence of the request.
   */
  const schedule = useCallback((): void => {
    if (!activeRef.current) return;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void runCheck();
    }, GRAMMAR_DEBOUNCE_MS);
  }, [runCheck]);

  /** Abort, forget, and stop expecting anything. Not an announcement. */
  const stop = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    abortRef.current?.abort();
    abortRef.current = null;
    suggestionsRef.current.clear();
    checkedRef.current.clear();
    setChecking(false);
  }, []);

  /* --------------------------------------------------------------------- *
   * The preference: read once per user, written on every change.
   * --------------------------------------------------------------------- */

  useEffect(() => {
    if (userId === undefined) return;
    const storage = browserStorage();
    if (storage === null) return;
    let raw: string | null = null;
    try {
      raw = storage.getItem(grammarEnabledStorageKey(userId));
    } catch {
      // Private mode, disabled storage, a hostile extension: the feature simply
      // stays at its default rather than failing to mount.
      return;
    }
    // The KEY EXISTING is the acknowledgement — the disclosure is shown before
    // anything is ever stored, so any stored value means it has been seen.
    setAcknowledged(raw !== null);
    setEnabledState(raw === "true");
  }, [userId]);

  const setEnabled = useCallback(
    (next: boolean): void => {
      if (userId === undefined) return;
      if (!editable) {
        setAnnouncement(READ_ONLY_MESSAGE);
        return;
      }
      if (editorRef.current === null) {
        setAnnouncement(NO_EDITOR_MESSAGE);
        return;
      }
      if (!aiReady) {
        // The toggle stays mounted and explains itself; a control that vanishes
        // is indistinguishable from a bug.
        setAnnouncement(AI_UNAVAILABLE_MESSAGE);
        return;
      }
      const storage = browserStorage();
      try {
        storage?.setItem(grammarEnabledStorageKey(userId), next ? "true" : "false");
      } catch {
        // Storage can be full or unavailable. The choice still applies to this
        // session; only its survival across a reload is lost.
      }
      // Acknowledged even when the write failed: the disclosure WAS shown, and
      // re-showing it inside the same session would be noise.
      setAcknowledged(true);
      setEnabledState(next);
      if (next) {
        setAnnouncement(ENABLED_MESSAGE);
        return;
      }
      stop();
      redraw();
      setAnnouncement(DISABLED_MESSAGE);
    },
    [aiReady, editable, redraw, stop, userId],
  );

  /* --------------------------------------------------------------------- *
   * Segmentation: one listener, and it fires for remote Yjs changes too —
   * which is wanted, since a collaborator's paragraph is prose in this note.
   * --------------------------------------------------------------------- */

  useEffect(() => {
    if (editor === null || !active) return;
    const onUpdate = (): void => {
      schedule();
    };
    editor.on("update", onUpdate);
    // Turning the feature on is itself a reason to check: the note already has
    // content, and waiting for a keystroke would make the toggle look inert.
    schedule();
    return () => {
      editor.off("update", onUpdate);
    };
  }, [active, editor, schedule]);

  /* --------------------------------------------------------------------- *
   * Accept and dismiss. The only code here that touches the document.
   * --------------------------------------------------------------------- */

  const accept = useCallback(
    (id: string): void => {
      const current = editorRef.current;
      const record = suggestionsRef.current.get(id);
      if (current === null || record === undefined) return;

      /*
       * THE GUARD, re-run at the moment of the write rather than trusted from
       * the moment the underline was drawn. The suggestion may have sat on
       * screen for a minute, and in a collaborative session a remote
       * transaction can land in far less. Replacing a range we can no longer
       * prove is the one the suggestion described would destroy someone's text.
       */
      const range = resolveCommentAnchorInState(current.state, record.anchor);
      const live = range === null ? null : rangeText(current, range.from, range.to);
      if (range === null || live !== record.originalText) {
        suggestionsRef.current.delete(id);
        redraw();
        announce(STALE_MESSAGE, false);
        return;
      }

      /*
       * PLAIN TEXT AS A JSON NODE, never a string — the same rule as every
       * Part 68 accept path (`insertAsParagraphs` / `replaceSelection` build
       * nodes for exactly this reason). A string goes through
       * `DOMParser.parseSlice`, so a replacement containing `<b>` or `&` would
       * be parsed into live markup. An EMPTY replacement is a legitimate
       * deletion and gets `deleteRange`, because ProseMirror has no empty text
       * node to insert.
       */
      const chain = current.chain().focus();
      const nodes: JSONContent[] = [{ type: "text", text: record.replacement }];
      const applied =
        record.replacement.length === 0
          ? chain.deleteRange(range)
          : chain.insertContentAt(range, nodes);
      applied.run();

      suggestionsRef.current.delete(id);
      redraw();
      announce(ACCEPTED_MESSAGE, false);
    },
    [announce, redraw],
  );

  const dismiss = useCallback(
    (id: string): void => {
      const record = suggestionsRef.current.get(id);
      if (record === undefined) return;
      // Keyed by the CORRECTION, not by the suggestion id: the id is derived
      // from a position, and the point of a dismissal is that re-checking the
      // same block later must not bring the same advice back.
      dismissedRef.current.add(dismissKey(record.originalText, record.replacement));
      suggestionsRef.current.delete(id);
      redraw();
      announce(DISMISSED_MESSAGE, false);
    },
    [announce, redraw],
  );

  const resolveSuggestions = useCallback((): readonly GrammarSuggestionTarget[] => {
    // Read at draw time, so switching the feature off empties the underlines on
    // the next state update even before anything else has run.
    if (!activeRef.current) return EMPTY_TARGETS;
    return [...suggestionsRef.current.values()];
  }, []);

  const getSuggestion = useCallback((id: string): GrammarSuggestionView | null => {
    return suggestionsRef.current.get(id) ?? null;
  }, []);

  /* --------------------------------------------------------------------- *
   * The control the panel renders. Replaced, never mutated.
   * --------------------------------------------------------------------- */

  const control = useMemo<GrammarControl | null>(() => {
    // No user means no per-user preference and no consent to record, so the
    // feature does not exist for this session at all.
    if (userId === undefined) return null;
    return { enabled: active, acknowledged, checking, count, announcement, setEnabled };
  }, [acknowledged, active, announcement, checking, count, setEnabled, userId]);

  useEffect(() => {
    setGrammarControl(control);
  }, [control]);

  useEffect(() => {
    return () => {
      // Teardown writes no state: this runs after the component is gone.
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      abortRef.current?.abort();
      abortRef.current = null;
      setGrammarControl(null);
    };
  }, []);

  return useMemo(
    () => ({ resolveSuggestions, getSuggestion, accept, dismiss, enabled: active }),
    [accept, active, dismiss, getSuggestion, resolveSuggestions],
  );
}
