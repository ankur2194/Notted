"use client";

import { useSyncExternalStore } from "react";

/**
 * Part 69 — the one-slot channel between "extract meeting notes" TRIGGERS and
 * the dialog that owns the request.
 *
 * Two unrelated places offer the command — the AI panel's own button and the
 * `/meeting` slash entry — and neither is an ancestor or a descendant of
 * `MeetingExtractionDialog`. The slash menu is rendered from a data table whose
 * `run(editor, range)` receives an editor and nothing else, so there is no prop
 * to thread. This is the same situation `lib/ai/continue-request.ts` solved for
 * "continue writing", and this store is deliberately the same shape:
 * module-scoped, no dependency, `useSyncExternalStore` for the subscribers.
 *
 * ONE SLOT, NOT A SUBSCRIBER LIST. A page has one note open and therefore one
 * extraction dialog; a second registration replacing the first is the honest
 * model of that, and opening two dialogs from one keystroke would give the
 * author two review screens over the same transcript.
 *
 * Nothing here holds a transcript. The dialog collects it itself, from the
 * author, after it opens.
 */

type MeetingExtractionHandler = () => boolean;

let handler: MeetingExtractionHandler | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  // Copied before iterating so a listener that unsubscribes during the
  // notification cannot make the iteration skip the next one.
  for (const listener of [...listeners]) listener();
}

/**
 * Register (or, with `null`, withdraw) the handler.
 *
 * The dialog registers only while it can actually serve the command — AI
 * enabled and configured for the workspace, the note editable, an editor
 * mounted — so "is a handler registered" is also the honest answer to "should
 * the slash menu offer it", and no caller has to duplicate that condition.
 */
export function setMeetingExtractionHandler(next: MeetingExtractionHandler | null): void {
  if (handler === next) return;
  handler = next;
  notify();
}

export function isMeetingExtractionAvailable(): boolean {
  return handler !== null;
}

/**
 * Ask the dialog to open. `false` means nothing was registered — the slash
 * command reports that as "not handled" rather than deleting the typed text and
 * leaving the author staring at nothing.
 *
 * Named `openMeetingExtraction`, not `requestMeetingExtraction`: the latter is
 * the HTTP call in `lib/ai/requests.ts`, and a file importing both would have
 * to rename one of them at every call site.
 */
export function openMeetingExtraction(): boolean {
  return handler === null ? false : handler();
}

export function subscribeToMeetingExtraction(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The server render has no dialog mounted, so the command is never offered. */
function serverSnapshot(): boolean {
  return false;
}

export function useMeetingExtractionAvailable(): boolean {
  return useSyncExternalStore(
    subscribeToMeetingExtraction,
    isMeetingExtractionAvailable,
    serverSnapshot,
  );
}
