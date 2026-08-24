"use client";

import { useSyncExternalStore } from "react";

/**
 * Part 68 — the one-slot channel between "continue writing" TRIGGERS and the
 * panel that owns the request.
 *
 * Three unrelated places offer the command — the AI panel's own button, the
 * editor toolbar, and the `Mod-Enter` keymap — and none of them is an ancestor
 * of `AiPanel`. The editor reaches `PageContainer` as opaque `children` from a
 * Server Component, so a prop cannot be threaded between them, and the toolbar
 * is rendered from a data table whose `run(editor)` receives an editor and
 * nothing else. This is exactly the situation `lib/notes/focus-mode.ts` already
 * solved for `Mod-Shift-f`, and this store is deliberately the same shape:
 * module-scoped, no dependency, `useSyncExternalStore` for the subscribers.
 *
 * ONE SLOT, NOT A SUBSCRIBER LIST. A page has one note open and therefore one
 * AI panel; a second registration replacing the first is the honest model of
 * that, and broadcasting a "continue writing" to two panels would start two
 * billed generations from one keystroke.
 *
 * Nothing here holds note content. The handler reads the caret's surroundings
 * itself, at press time, from the live editor.
 */

type AiContinueHandler = () => boolean;

let handler: AiContinueHandler | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  // Copied before iterating so a listener that unsubscribes during the
  // notification cannot make the iteration skip the next one.
  for (const listener of [...listeners]) listener();
}

/**
 * Register (or, with `null`, withdraw) the handler.
 *
 * The panel registers only while it can actually serve the command — AI enabled
 * for the workspace, the note editable, an editor mounted — so "is a handler
 * registered" is also the honest answer to "should the toolbar button be
 * offered", and no caller has to duplicate that condition.
 */
export function setAiContinueHandler(next: AiContinueHandler | null): void {
  if (handler === next) return;
  handler = next;
  notify();
}

export function isAiContinueAvailable(): boolean {
  return handler !== null;
}

/**
 * Ask the panel to start a continuation. `false` means nothing was registered
 * — which is what the keymap reports as "not handled", so `Mod-Enter` falls
 * through to whatever else claims it rather than silently swallowing the key.
 */
export function requestAiContinue(): boolean {
  return handler === null ? false : handler();
}

export function subscribeToAiContinue(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The server render has no panel mounted, so the command is never offered. */
function serverSnapshot(): boolean {
  return false;
}

export function useAiContinueAvailable(): boolean {
  return useSyncExternalStore(subscribeToAiContinue, isAiContinueAvailable, serverSnapshot);
}
