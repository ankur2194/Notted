"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

export interface DialogFocusRestore {
  readonly contentRef: RefObject<HTMLDivElement | null>;
  readonly onCloseAutoFocus: (event: Event) => void;
}

/**
 * Restore focus to whatever was focused before a dialog opened.
 *
 * Radix's modal dialog restores focus to its `DialogTrigger`. These editor
 * dialogs are opened programmatically (toolbar buttons that must stay inside
 * the toolbar's roving tab index, plus keyboard shortcuts), so there is no
 * trigger for Radix to return to and focus would otherwise fall back to
 * `document.body`. Tracking the last focus outside the dialog keeps the
 * keyboard path continuous.
 */
export function useDialogFocusRestore(): DialogFocusRestore {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const handleFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (contentRef.current !== null && contentRef.current.contains(target)) return;
      restoreRef.current = target;
    };
    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
  }, []);

  const onCloseAutoFocus = useCallback((event: Event): void => {
    const target = restoreRef.current;
    if (target === null || !target.isConnected) return;
    event.preventDefault();
    target.focus();
  }, []);

  return { contentRef, onCloseAutoFocus };
}
