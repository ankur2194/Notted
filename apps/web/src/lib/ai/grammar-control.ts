"use client";

import { useSyncExternalStore } from "react";

/**
 * Part 70 — the one-slot channel between the grammar CHECKER and the control
 * that turns it on.
 *
 * The checking lives in `useGrammarCheck`, mounted by `NoteEditorSurface`
 * because that is the only place holding the editor instance. The toggle, the
 * privacy disclosure, and the polite region live in `AiPanel`. Neither is an
 * ancestor of the other — the editor reaches `PageContainer` as opaque
 * `children` rendered by a Server Component — so no prop can be threaded
 * between them. This is exactly the problem `lib/ai/continue-request.ts` and
 * `lib/notes/focus-mode.ts` already solved, and this store is deliberately the
 * same shape: module-scoped, no dependency, `useSyncExternalStore`.
 *
 * ONE SLOT, NOT A SUBSCRIBER LIST. A page has one note open and therefore one
 * checker and one panel; a second registration replacing the first is the
 * honest model of that.
 *
 * THE SNAPSHOT IS REPLACED, NEVER MUTATED. `useSyncExternalStore` compares
 * snapshots by identity, so a mutated object would notify and then hand back
 * something React considers unchanged. The hook builds each snapshot with
 * `useMemo`, which is also why the comparison below is identity and not deep.
 *
 * Nothing here holds note content or a suggestion. The checker owns those; this
 * carries only what a control has to render — and `announcement`, which the
 * checker has already throttled.
 */
export interface GrammarControl {
  readonly enabled: boolean;
  /** Whether this user has ever been shown the privacy disclosure. */
  readonly acknowledged: boolean;
  readonly checking: boolean;
  readonly count: number;
  /** Polite-region text; already throttled by the hook. */
  readonly announcement: string;
  readonly setEnabled: (next: boolean) => void;
}

let control: GrammarControl | null = null;
const listeners = new Set<() => void>();

/**
 * Register (or, with `null`, withdraw) the control.
 *
 * The checker registers whenever it can describe the feature at all — including
 * when AI is off for the workspace, where it registers a control whose
 * `setEnabled` refuses with a reason. A missing control means the feature does
 * not apply to this reader at all (a signed-out or preview session), and that is
 * the one case where the toggle should not render.
 */
export function setGrammarControl(next: GrammarControl | null): void {
  if (control === next) return;
  control = next;
  // Copied before iterating so a listener that unsubscribes during the
  // notification cannot make the iteration skip the next one.
  for (const listener of [...listeners]) listener();
}

export function getGrammarControl(): GrammarControl | null {
  return control;
}

export function subscribeToGrammarControl(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The server render has no editor mounted, so there is never a control. */
function serverSnapshot(): null {
  return null;
}

export function useGrammarControl(): GrammarControl | null {
  return useSyncExternalStore(subscribeToGrammarControl, getGrammarControl, serverSnapshot);
}
