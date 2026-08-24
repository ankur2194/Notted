"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { GrammarSuggestionView } from "./useGrammarCheck";
import type { Editor } from "@tiptap/core";

import { GRAMMAR_SUGGESTION_ID_ATTRIBUTE } from "@/components/editor/extensions/grammar-decorations";
import {
  SUGGESTION_POPUP_WIDTH,
  suggestionPopupGeometry,
  type SuggestionRect,
} from "@/components/editor/suggestion-popup";
import { Button } from "@/components/ui/button";

/**
 * Part 70 — the review surface for one grammar suggestion.
 *
 * ## THE INVARIANT
 *
 * Nothing here writes to the document. `accept` and `dismiss` belong to
 * `useGrammarCheck`, which re-derives the range from its Part 60 anchor before
 * touching anything; this component only decides *which* suggestion the author
 * is looking at.
 *
 * ## One listener, not one per decoration
 *
 * The underlines are ProseMirror decorations, rebuilt on every state update, so
 * a listener attached to a decorated span would be discarded seconds later. The
 * listener lives on `editor.view.dom` and hit-tests with `closest()` — the same
 * container-delegation shape `AttachmentDialogs` uses for the attachment card
 * events.
 *
 * ## Geometry
 *
 * The decorated span IS a DOM element, so its own `getBoundingClientRect()` is
 * both simpler and more accurate than `posToDOMRect`. The flip/clamp rules are
 * `suggestionPopupGeometry` — the slash menu's and the mention list's — reused
 * rather than a second set invented here.
 *
 * ## Keyboard
 *
 * Enter and Space are deliberately NOT claimed on the editing surface: they are
 * how a writer types, and hijacking them to open a popup would break the note.
 * The keyboard route is `Alt+ArrowDown` — the conventional "open the popup for
 * the thing at the cursor" chord, unclaimed by StarterKit and absent from the
 * Part 34 shortcut table — which opens the suggestion the caret currently sits
 * inside. Once open the popover takes focus, so Tab, Escape, and Enter behave
 * as they do in any dialog.
 */

export interface GrammarPopoverProps {
  readonly editor: Editor | null;
  readonly getSuggestion: (id: string) => GrammarSuggestionView | null;
  readonly accept: (id: string) => void;
  readonly dismiss: (id: string) => void;
}

/** Only used when the module is evaluated without a DOM (server render). */
const FALLBACK_VIEWPORT = { width: 1024, height: 768 } as const;

const CATEGORY_LABELS = Object.freeze({
  grammar: "Grammar suggestion",
  style: "Style suggestion",
  spelling: "Spelling suggestion",
});

interface OpenTarget {
  readonly id: string;
  readonly rect: SuggestionRect;
}

/** The decorated span under `node`, or `null` when there is none. */
function decoratedAncestor(node: Node | null): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  return element?.closest<HTMLElement>(`[${GRAMMAR_SUGGESTION_ID_ATTRIBUTE}]`) ?? null;
}

function targetFor(element: HTMLElement): OpenTarget | null {
  const id = element.getAttribute(GRAMMAR_SUGGESTION_ID_ATTRIBUTE);
  if (id === null || id === "") return null;
  const rect = element.getBoundingClientRect();
  return { id, rect: { top: rect.top, bottom: rect.bottom, left: rect.left } };
}

export function GrammarPopover({ editor, getSuggestion, accept, dismiss }: GrammarPopoverProps) {
  const [target, setTarget] = useState<OpenTarget | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const surface = editor === null || editor.isDestroyed ? null : editor.view.dom;

  /**
   * Close, returning focus to the editor only when the popover currently holds
   * it. A suggestion that vanished while the author was typing somewhere else
   * must not yank the caret back.
   */
  const close = useCallback((): void => {
    const held =
      popoverRef.current !== null && popoverRef.current.contains(document.activeElement ?? null);
    setTarget(null);
    if (held && surface instanceof HTMLElement) surface.focus();
  }, [surface]);

  // One delegated click listener for every underline in the document.
  useEffect(() => {
    if (!(surface instanceof HTMLElement)) return undefined;
    const handleClick = (event: MouseEvent): void => {
      const element = decoratedAncestor(event.target instanceof Node ? event.target : null);
      // A click anywhere else in the note closes whatever was open: the author
      // has moved on, and a popover pointing at text they are no longer near is
      // worse than no popover.
      if (element === null) {
        setTarget(null);
        return;
      }
      setTarget(targetFor(element));
    };
    /*
     * `Alt+ArrowDown` on the caret's own decorated span. Nothing else is
     * claimed here — see the note above about Enter and Space.
     */
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "ArrowDown" || !event.altKey || event.ctrlKey || event.metaKey) return;
      const instance = editor;
      if (instance === null || instance.isDestroyed) return;
      const at = instance.view.domAtPos(instance.state.selection.from);
      const element = decoratedAncestor(at.node);
      if (element === null) return;
      event.preventDefault();
      setTarget(targetFor(element));
    };
    surface.addEventListener("click", handleClick);
    surface.addEventListener("keydown", handleKeyDown);
    return () => {
      surface.removeEventListener("click", handleClick);
      surface.removeEventListener("keydown", handleKeyDown);
    };
  }, [editor, surface]);

  // Click-away. Mounted only while something is open, and always removed.
  useEffect(() => {
    if (target === null) return undefined;
    const handlePointerDown = (event: Event): void => {
      const node = event.target;
      if (node instanceof Node && popoverRef.current?.contains(node) === true) return;
      setTarget(null);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("mousedown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("mousedown", handlePointerDown, true);
    };
  }, [target]);

  /*
   * Escape, listened for on the document rather than as an `onKeyDown` on the
   * popover: the handler is the same either way, and a keyboard interaction
   * declared on a `role="dialog"` element is exactly what
   * `jsx-a11y/no-noninteractive-element-interactions` objects to. The guard
   * keeps it scoped — an Escape pressed while focus is somewhere else belongs
   * to whatever owns focus, not to this popover.
   */
  useEffect(() => {
    if (target === null) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (popoverRef.current?.contains(document.activeElement ?? null) !== true) return;
      event.stopPropagation();
      close();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [close, target]);

  /*
   * Read at render time rather than captured on open: `null` means the
   * suggestion has since been accepted, dismissed, or invalidated by an edit,
   * and the popover simply is not there any more.
   */
  const suggestion = target === null ? null : getSuggestion(target.id);

  /*
   * Focus moves in as the popover appears, and `close` puts it back.
   *
   * Keyed on `target`, NOT on `suggestion`: the view object is re-read on every
   * render, so a `suggestion` dependency would re-focus the container each time
   * and steal focus back from a button the author had tabbed to. The ref is
   * only populated while the popover is actually rendered, so a stale target
   * whose suggestion has vanished focuses nothing.
   */
  useEffect(() => {
    popoverRef.current?.focus();
  }, [target]);

  const geometry = useMemo(() => {
    if (target === null) return null;
    const hasWindow = typeof window !== "undefined";
    return suggestionPopupGeometry(target.rect, {
      width: hasWindow ? window.innerWidth : FALLBACK_VIEWPORT.width,
      height: hasWindow ? window.innerHeight : FALLBACK_VIEWPORT.height,
    });
  }, [target]);

  if (target === null || suggestion === null || geometry === null) return null;
  if (typeof document === "undefined") return null;

  const removes = suggestion.replacement === "";

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={CATEGORY_LABELS[suggestion.category]}
      tabIndex={-1}
      data-testid="grammar-popover"
      data-placement={geometry.placement}
      data-notted-print-hide
      style={{
        position: "fixed",
        top: `${geometry.top}px`,
        left: `${geometry.left}px`,
        width: `${SUGGESTION_POPUP_WIDTH}px`,
        maxHeight: `${geometry.maxHeight}px`,
      }}
      className="z-50 space-y-2 overflow-y-auto overscroll-contain rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg focus-visible:outline-none"
    >
      <p className="text-sm" data-testid="grammar-popover-message">
        {suggestion.message}
      </p>
      <p className="text-xs text-muted-foreground" data-testid="grammar-popover-change">
        <span className="line-through">{suggestion.originalText}</span>{" "}
        {removes ? (
          // An empty replacement is a deletion. A blank box would read as "no
          // suggestion", which is the opposite of what it means.
          <span className="font-medium text-foreground">— Remove this text</span>
        ) : (
          <>
            → <span className="font-medium text-foreground">{suggestion.replacement}</span>
          </>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          data-testid="grammar-accept"
          onClick={() => {
            accept(target.id);
            close();
          }}
        >
          {removes ? "Remove" : "Accept"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="grammar-dismiss"
          onClick={() => {
            dismiss(target.id);
            close();
          }}
        >
          Dismiss
        </Button>
      </div>
    </div>,
    document.body,
  );
}
