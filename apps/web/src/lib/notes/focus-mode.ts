"use client";

import { useSyncExternalStore } from "react";

/**
 * Focus mode (Notted.md: "Toggle to hide sidebar and top bar, showing only the
 * page and a floating minimal toolbar", Plan Part 38).
 *
 * Focus mode is a single page-wide viewing mode with two observers that are not
 * in a parent/child relationship: `PageContainer` owns the toggle button and the
 * announcement, while `TiptapEditor` owns the `Mod-Shift-f` binding and the
 * floating toolbar. Threading a prop between them is impossible — the editor
 * reaches `PageContainer` as opaque `children` rendered by a Server Component —
 * so the mode lives in one tiny client-only store instead.
 *
 * The store is deliberately minimal (no dependency is added; ADR 0008 pins the
 * package matrix) and holds exactly one boolean. It stores nothing in browser
 * storage: focus mode is not persisted, so a reload always returns to the full
 * layout and a hidden-chrome state can never outlive the session that chose it.
 *
 * `data-notted-focus` on `document.documentElement` is the styling hook, written
 * here so the attribute can never disagree with the state. It is *only* ever set
 * to `"true"` or removed; a stuck attribute would hide the sidebar on every
 * other page in the application, so `PageContainer` also clears the mode when it
 * unmounts.
 */

export const FOCUS_MODE_ATTRIBUTE = "data-notted-focus";

/** Set on any chrome that focus mode hides; see `styles/globals.css`. */
export const FOCUS_HIDDEN_ATTRIBUTE = "data-notted-focus-hide";

type FocusModeListener = () => void;

let enabled = false;
const listeners = new Set<FocusModeListener>();

function documentRoot(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.documentElement;
}

function paintDocument(next: boolean): void {
  const root = documentRoot();
  if (root === null) return;
  if (next) root.setAttribute(FOCUS_MODE_ATTRIBUTE, "true");
  else root.removeAttribute(FOCUS_MODE_ATTRIBUTE);
}

export function isFocusModeEnabled(): boolean {
  return enabled;
}

/**
 * Apply a focus-mode state. Returns `true` when the state changed, which is
 * also what the `Mod-Shift-f` keymap reports as "handled".
 */
export function setFocusMode(next: boolean): boolean {
  if (enabled === next) {
    // Re-assert the attribute anyway: an unmount cleanup or an external script
    // may have removed it while the store still believed it was applied.
    paintDocument(next);
    return false;
  }
  enabled = next;
  paintDocument(next);
  // Copied before iterating so a listener that unsubscribes during the
  // notification cannot skip the next one.
  for (const listener of [...listeners]) listener();
  return true;
}

export function toggleFocusMode(): boolean {
  return setFocusMode(!enabled);
}

export function subscribeToFocusMode(listener: FocusModeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The server render never has chrome to hide, so it always reports `false`. */
function serverSnapshot(): boolean {
  return false;
}

/** Subscribe a client component to the current focus-mode state. */
export function useFocusMode(): boolean {
  return useSyncExternalStore(subscribeToFocusMode, isFocusModeEnabled, serverSnapshot);
}
