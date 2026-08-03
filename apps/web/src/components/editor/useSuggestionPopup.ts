"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import {
  emptySuggestionPopupState,
  readSuggestionRect,
  wrapActiveIndex,
  type SuggestionLifecycleProps,
  type SuggestionPopupState,
  type SuggestionSettleProps,
  type SuggestionSink,
} from "./suggestion-popup";

export interface SuggestionPopupController<TItem> {
  readonly state: SuggestionPopupState<TItem>;
  /** Stable across renders, so passing it to the editor never rebuilds it. */
  readonly sink: SuggestionSink<TItem>;
  readonly setActiveIndex: (index: number) => void;
  readonly select: (index: number) => void;
  readonly dismiss: () => void;
}

/**
 * React state for one suggestion popup.
 *
 * The returned `sink` is created once and mutates through refs, so the editor
 * can be configured with it at construction time and never has to be rebuilt
 * when React state changes.
 *
 * Two ordering hazards are handled here:
 *
 * - **Stale responses.** The suggestion utility awaits `items()` before calling
 *   `onStart`/`onUpdate`, so a slow lookup for an earlier query can settle
 *   after a faster lookup for a later one. `settle` therefore ignores any
 *   result whose query is not the one the popup is currently showing.
 * - **Escape.** Dismissing has to survive further keystrokes within the same
 *   trigger, because the ProseMirror plugin stays active until the caret leaves
 *   the match. The dismissal is cleared only when a new trigger begins or the
 *   plugin exits, which is also what leaves the typed text untouched.
 */
export function useSuggestionPopup<TItem>(): SuggestionPopupController<TItem> {
  const [state, setState] = useState<SuggestionPopupState<TItem>>(emptySuggestionPopupState<TItem>);
  const stateRef = useRef(state);
  stateRef.current = state;

  const commandRef = useRef<((item: TItem) => void) | null>(null);
  const dismissedRef = useRef(false);

  const apply = useCallback((next: SuggestionPopupState<TItem>): void => {
    stateRef.current = next;
    setState(next);
  }, []);

  const close = useCallback((): void => {
    if (!stateRef.current.open) return;
    apply(emptySuggestionPopupState<TItem>());
  }, [apply]);

  const select = useCallback(
    (index: number): void => {
      const current = stateRef.current;
      const item = current.items[index];
      if (!current.open || item === undefined) return;
      const command = commandRef.current;
      // Close first: the command moves the selection, which makes the plugin
      // exit anyway, and a closed popup can never act on a stale command.
      dismissedRef.current = false;
      apply(emptySuggestionPopupState<TItem>());
      command?.(item);
    },
    [apply],
  );

  const setActiveIndex = useCallback(
    (index: number): void => {
      const current = stateRef.current;
      if (!current.open || index < 0 || index >= current.items.length) return;
      apply({ ...current, activeIndex: index });
    },
    [apply],
  );

  const dismiss = useCallback((): void => {
    dismissedRef.current = true;
    close();
  }, [close]);

  const sink = useMemo<SuggestionSink<TItem>>(() => {
    const start = (props: SuggestionLifecycleProps<TItem>, fresh: boolean): void => {
      commandRef.current = props.command;
      if (fresh) dismissedRef.current = false;
      if (dismissedRef.current) return;
      const current = stateRef.current;
      apply({
        open: true,
        query: props.query,
        items: fresh ? [] : current.items,
        activeIndex: fresh ? -1 : current.activeIndex,
        status: "loading",
        rect: readSuggestionRect(props.clientRect) ?? (fresh ? null : current.rect),
      });
    };

    return {
      begin: (props) => start(props, true),
      update: (props) => start(props, false),
      settle: (props: SuggestionSettleProps<TItem>) => {
        const current = stateRef.current;
        if (!current.open || current.query !== props.query) return;
        const items = props.failed ? [] : props.items;
        apply({
          ...current,
          items,
          activeIndex: items.length === 0 ? -1 : 0,
          status: props.failed ? "error" : "ready",
        });
      },
      exit: () => {
        dismissedRef.current = false;
        commandRef.current = null;
        close();
      },
      keyDown: (event: KeyboardEvent): boolean => {
        const current = stateRef.current;
        if (!current.open) return false;
        const move = (delta: number): boolean => {
          const next = wrapActiveIndex(current.activeIndex, current.items.length, delta);
          if (next < 0) return false;
          event.preventDefault();
          apply({ ...current, activeIndex: next });
          return true;
        };

        if (event.key === "Escape") {
          event.preventDefault();
          dismiss();
          return true;
        }
        if (event.key === "ArrowDown" || (event.ctrlKey && event.key.toLowerCase() === "n")) {
          return move(1);
        }
        if (event.key === "ArrowUp" || (event.ctrlKey && event.key.toLowerCase() === "p")) {
          return move(-1);
        }
        if (event.key === "Enter" || event.key === "Tab") {
          // With no results the editor keeps its normal Enter and Tab
          // behaviour rather than silently swallowing the key.
          if (current.items[current.activeIndex] === undefined) return false;
          event.preventDefault();
          select(current.activeIndex);
          return true;
        }
        return false;
      },
    };
  }, [apply, close, dismiss, select]);

  return { state, sink, setActiveIndex, select, dismiss };
}
