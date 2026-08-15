"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { NoteDocument } from "@notted/shared-validators";

/**
 * How the editor reaches the autosave machine.
 *
 * `PageContainer` owns the machine, and the editor arrives inside it as opaque
 * `children` rendered by a Server Component — exactly the situation Part 38
 * solved for focus mode with a module store. Here both halves genuinely do sit
 * under one client parent, so a plain React context is enough and keeps the
 * handle per-note instead of per-tab.
 *
 * Without a provider every method is a safe no-op: an editor rendered outside a
 * `PageContainer` (a preview, a test harness) must not throw, and must not
 * quietly pretend it is saving either. Nothing here performs I/O.
 */
export interface NoteSaveHandle {
  readonly onDocumentChange: (document: NoteDocument) => void;
  /** The editor's serialization of the document it opened with. */
  readonly onDocumentBaseline: (document: NoteDocument) => void;
  /** The editor produced JSON the note contract rejects. */
  readonly onDocumentRejected: (rejected: boolean) => void;
  /**
   * A version the server stored for this note without this machine saving it —
   * Part 58's collaborative projection. Ignored unless nothing local is
   * outstanding.
   */
  readonly applyExternalVersion: (version: number) => void;
  readonly status:
    "idle" | "dirty" | "saving" | "saved" | "retrying" | "error" | "conflict" | "offline";
  readonly hasUnsavedWork: boolean;
}

const NO_SAVE_HANDLE: NoteSaveHandle = {
  onDocumentChange: () => undefined,
  onDocumentBaseline: () => undefined,
  onDocumentRejected: () => undefined,
  applyExternalVersion: () => undefined,
  status: "idle",
  hasUnsavedWork: false,
};

const NoteSaveContext = createContext<NoteSaveHandle | null>(null);

export function NoteSaveProvider({
  value,
  children,
}: {
  readonly value: NoteSaveHandle;
  readonly children: ReactNode;
}) {
  // Identity is stabilized so a re-render of the page container does not
  // re-run the editor's subscription effects.
  const handle = useMemo<NoteSaveHandle>(
    () => ({
      onDocumentChange: value.onDocumentChange,
      onDocumentBaseline: value.onDocumentBaseline,
      onDocumentRejected: value.onDocumentRejected,
      applyExternalVersion: value.applyExternalVersion,
      status: value.status,
      hasUnsavedWork: value.hasUnsavedWork,
    }),
    [
      value.onDocumentChange,
      value.onDocumentBaseline,
      value.onDocumentRejected,
      value.applyExternalVersion,
      value.status,
      value.hasUnsavedWork,
    ],
  );
  return <NoteSaveContext.Provider value={handle}>{children}</NoteSaveContext.Provider>;
}

export function useNoteSave(): NoteSaveHandle {
  return useContext(NoteSaveContext) ?? NO_SAVE_HANDLE;
}

/**
 * Whether a host is actually displaying save state.
 *
 * `useNoteSave` deliberately returns a no-op handle without a provider, so the
 * presence of a callback proves nothing — and the editor suppresses its own
 * contract-rejection alert whenever `onDocumentRejected` is supplied. Without
 * this distinction a rejection would be announced nowhere at all in the two
 * configurations that have no save UI: an editor rendered outside a
 * `PageContainer`, and a read-only note. The provider is mounted exactly when
 * `SaveStatusIndicator` is rendered, so this is the reliable signal.
 */
export function useHasNoteSaveHost(): boolean {
  return useContext(NoteSaveContext) !== null;
}
