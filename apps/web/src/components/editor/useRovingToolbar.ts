"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

const NAVIGATION_KEYS: ReadonlySet<string> = new Set(["ArrowRight", "ArrowLeft", "Home", "End"]);

export interface RovingToolbar {
  readonly toolbarRef: RefObject<HTMLDivElement | null>;
  readonly tabIndexFor: (id: string) => 0 | -1;
  readonly onItemFocus: (id: string) => void;
  /** Bind to the `role="toolbar"` element's `onKeyDown`. */
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

/**
 * APG toolbar keyboard behaviour: the whole toolbar is a single tab stop and
 * Left/Right/Home/End move focus between controls.
 *
 * `preventDefault` is deliberate on Left/Right: it also suppresses the native
 * value change a closed `<select>` would otherwise perform, so the arrow keys
 * mean the same thing on every control in the toolbar. Up/Down are left alone
 * so selects keep their native value-changing behaviour.
 *
 * Controls opt in by rendering `data-toolbar-item="<id>"`; `itemIds` must be
 * referentially stable (memoize it in the caller).
 *
 * `onKeyDown` is returned for the caller to bind on the `role="toolbar"`
 * element rather than attached natively from an effect. React's synthetic
 * handler already sees keydown bubbling from the controls, and binding in an
 * effect silently did nothing for a toolbar that mounts hidden: the first pass
 * saw a null ref, and the handler's dependency never changed, so the effect
 * never re-ran once the element appeared. `ImageToolbar` returns `null` until
 * an image is selected and had no arrow-key navigation at all because of it.
 */
export function useRovingToolbar(itemIds: readonly string[]): RovingToolbar {
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [activeId, setActiveId] = useState<string>(() => itemIds[0] ?? "");

  useEffect(() => {
    setActiveId((current) => (itemIds.includes(current) ? current : (itemIds[0] ?? "")));
  }, [itemIds]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!NAVIGATION_KEYS.has(event.key)) return;
    const root = toolbarRef.current;
    if (root === null) return;
    const elements = Array.from(root.querySelectorAll<HTMLElement>("[data-toolbar-item]"));
    if (elements.length === 0) return;

    const active = document.activeElement;
    const currentIndex = elements.findIndex(
      (element) => element === active || (active !== null && element.contains(active)),
    );

    let nextIndex: number;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = elements.length - 1;
    else if (event.key === "ArrowRight") {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % elements.length;
    } else {
      nextIndex =
        currentIndex < 0
          ? elements.length - 1
          : (currentIndex - 1 + elements.length) % elements.length;
    }

    const next = elements[nextIndex];
    if (next === undefined) return;
    event.preventDefault();
    const nextId = next.dataset.toolbarItem;
    if (nextId !== undefined) setActiveId(nextId);
    next.focus();
  }, []);

  const tabIndexFor = useCallback(
    (id: string): 0 | -1 => {
      if (activeId === "") return itemIds[0] === id ? 0 : -1;
      return activeId === id ? 0 : -1;
    },
    [activeId, itemIds],
  );

  const onItemFocus = useCallback((id: string): void => setActiveId(id), []);

  return { toolbarRef, tabIndexFor, onItemFocus, onKeyDown };
}
