"use client";

import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";

import {
  SUGGESTION_POPUP_WIDTH,
  suggestionPopupGeometry,
  type SuggestionPopupState,
} from "./suggestion-popup";

import type { Editor } from "@tiptap/core";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface SuggestionPopoverProps<TItem> {
  readonly editor: Editor | null;
  readonly state: SuggestionPopupState<TItem>;
  /** Stable id shared by `aria-controls` and the listbox element. */
  readonly listboxId: string;
  /** Accessible name of the listbox, e.g. "Block commands". */
  readonly label: string;
  /** Polite announcement; rendered from a live region that is always mounted. */
  readonly announcement: string;
  readonly loadingMessage: string;
  readonly emptyMessage: string;
  readonly errorMessage: string;
  readonly itemKey: (item: TItem) => string;
  readonly renderItem: (item: TItem, active: boolean) => ReactNode;
  readonly onSelect: (index: number) => void;
  readonly onActivate: (index: number) => void;
  readonly onDismiss: () => void;
}

/** Only used when the module is evaluated without a DOM (server render). */
const FALLBACK_VIEWPORT = { width: 1024, height: 768 } as const;

function optionElementId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
}

/**
 * Shared popup surface for the slash menu and the mention list.
 *
 * Focus never leaves the editor: the caret stays where the user is typing and
 * the popup is wired as its controlled listbox. The editing surface therefore
 * carries `aria-controls`, `aria-autocomplete`, `aria-haspopup`, and
 * `aria-activedescendant`, while the list itself is a `listbox` of `option`s
 * with `aria-selected`. Result counts are announced from a polite live region
 * that is mounted whether or not the popup is open, so the first result set is
 * announced too.
 *
 * The surface keeps `role="textbox"` rather than swapping to `role="combobox"`
 * while open: a role that changes underneath assistive technology is worse than
 * a textbox that gains the combobox-supporting attributes, and the note editor
 * is a multi-line textbox in every other respect.
 *
 * `aria-expanded` is deliberately *not* set. ARIA 1.2 lists it as unsupported
 * on `role="textbox"` (which supports `aria-activedescendant`,
 * `aria-autocomplete`, and `aria-haspopup`, with `aria-controls` global), so
 * setting it would fail `aria-allowed-attr`. Nothing is lost: the always-mounted
 * live region below announces both that the popup opened and how many results it
 * holds.
 */
export function SuggestionPopover<TItem>({
  editor,
  state,
  listboxId,
  label,
  announcement,
  loadingMessage,
  emptyMessage,
  errorMessage,
  itemKey,
  renderItem,
  onSelect,
  onActivate,
  onDismiss,
}: SuggestionPopoverProps<TItem>) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  const surface = editor === null || editor.isDestroyed ? null : editor.view.dom;
  const open = state.open && state.rect !== null;
  const activeOptionId =
    state.activeIndex >= 0 && state.activeIndex < state.items.length
      ? optionElementId(listboxId, state.activeIndex)
      : null;

  // Combobox-supporting attributes live on the editing surface itself, which is
  // owned by ProseMirror rather than React, and are removed again on close so a
  // closed popup never leaves a dangling `aria-controls`.
  useEffect(() => {
    if (!(surface instanceof HTMLElement) || !open) return undefined;
    surface.setAttribute("aria-controls", listboxId);
    surface.setAttribute("aria-autocomplete", "list");
    surface.setAttribute("aria-haspopup", "listbox");
    return () => {
      surface.removeAttribute("aria-controls");
      surface.removeAttribute("aria-autocomplete");
      surface.removeAttribute("aria-haspopup");
    };
  }, [surface, open, listboxId]);

  useEffect(() => {
    if (!(surface instanceof HTMLElement) || !open || activeOptionId === null) return undefined;
    surface.setAttribute("aria-activedescendant", activeOptionId);
    return () => surface.removeAttribute("aria-activedescendant");
  }, [surface, open, activeOptionId]);

  // Click-away. The listener exists only while the popup is open and is always
  // removed, so no listener outlives the popup.
  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && popoverRef.current?.contains(target) === true) return;
      if (target instanceof Node && surface instanceof HTMLElement && surface.contains(target)) {
        return;
      }
      dismissRef.current();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("mousedown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("mousedown", handlePointerDown, true);
    };
  }, [open, surface]);

  const geometry = useMemo(() => {
    if (state.rect === null) return null;
    // The popup only ever renders on the client; the fallbacks exist so this
    // module stays importable during the server render.
    const hasWindow = typeof window !== "undefined";
    return suggestionPopupGeometry(state.rect, {
      width: hasWindow ? window.innerWidth : FALLBACK_VIEWPORT.width,
      height: hasWindow ? window.innerHeight : FALLBACK_VIEWPORT.height,
    });
  }, [state.rect]);

  const list =
    open && geometry !== null ? (
      <div
        ref={popoverRef}
        data-testid={listboxId}
        data-placement={geometry.placement}
        style={{
          position: "fixed",
          top: `${geometry.top}px`,
          left: `${geometry.left}px`,
          width: `${SUGGESTION_POPUP_WIDTH}px`,
          maxHeight: `${geometry.maxHeight}px`,
        }}
        className="z-50 overflow-y-auto overscroll-contain rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
      >
        {state.status === "loading" ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">{loadingMessage}</p>
        ) : null}
        {state.status === "error" ? (
          <p className="px-3 py-2 text-sm text-destructive">{errorMessage}</p>
        ) : null}
        {state.status === "ready" && state.items.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">{emptyMessage}</p>
        ) : null}
        <ul id={listboxId} role="listbox" aria-label={label} className="m-0 list-none p-0">
          {state.items.map((item, index) => {
            const active = index === state.activeIndex;
            return (
              // In the `aria-activedescendant` pattern an option is never focusable and
              // never receives key events: the editing surface keeps focus and routes
              // every key through the suggestion plugin, where Arrow/Enter/Tab/Escape are
              // handled (`useSuggestionPopup`). A key listener here would be unreachable.
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- see above
              <li
                key={itemKey(item)}
                id={optionElementId(listboxId, index)}
                role="option"
                aria-selected={active}
                // Keeping the caret in the editor is what makes
                // `aria-activedescendant` correct, so the press that would
                // move focus is cancelled before it reaches the surface.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onActivate(index)}
                onClick={() => onSelect(index)}
                className={cn(
                  "flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-sm",
                  active ? "bg-accent text-accent-foreground" : "text-foreground",
                )}
              >
                {renderItem(item, active)}
              </li>
            );
          })}
        </ul>
      </div>
    ) : null;

  return (
    <>
      {/*
        Always mounted so the first result set is announced too. Deliberately
        no `role="status"`: the note surface already uses that role for its
        migration notice, and a bare `aria-live` region announces identically
        without adding a second status landmark to the page.
      */}
      <p
        data-testid={`${listboxId}-announcement`}
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </p>
      {list === null || typeof document === "undefined" ? null : createPortal(list, document.body)}
    </>
  );
}
