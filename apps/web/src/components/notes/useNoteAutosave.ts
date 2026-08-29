"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import type { PageSize } from "@notted/shared-types";
import type { NoteDocument } from "@notted/shared-validators";

import {
  autosaveReducer,
  canSaveNow,
  createAutosaveState,
  describeAutosave,
  effectivePageSize,
  hasUnsavedWork,
  pendingSaveInput,
  type AutosaveDescription,
  type AutosaveEffect,
  type AutosaveEvent,
  type AutosaveState,
  type AutosaveStatus,
} from "@/lib/notes/autosave-machine";
import { updateNote } from "@/lib/notes/requests";

/**
 * The React, timer, network, and browser-event adapter around
 * `lib/notes/autosave-machine`.
 *
 * Everything decision-shaped lives in the machine; this file only turns its
 * effects into `setTimeout`, `updateNote`, and DOM listeners, and turns the
 * answers back into events. That split is what lets rapid typing, slow
 * responses, out-of-order responses, network loss, and version conflicts be
 * proven without a DOM.
 */

export interface UseNoteAutosaveOptions {
  readonly workspaceId: string;
  readonly noteId: string;
  /** Server-rendered version; the machine's single version cell is seeded here. */
  readonly initialVersion: number;
  readonly initialPageSize: PageSize;
  /**
   * Backend policy stays authoritative. This only stops the client from issuing
   * writes it already knows will be refused.
   */
  readonly canUpdate: boolean;
}

export interface NoteAutosaveHandle {
  readonly status: AutosaveStatus;
  readonly description: AutosaveDescription;
  /** The size to render: the requested one until the server says otherwise. */
  readonly pageSize: PageSize;
  /** The last version the server acknowledged. */
  readonly version: number;
  /** The size the server last acknowledged, for announcements. */
  readonly savedPageSize: PageSize;
  readonly savedDocument: NoteDocument | null;
  readonly documentRejected: boolean;
  readonly hasUnsavedWork: boolean;
  /**
   * Register a source of unacknowledged work this machine cannot see — the
   * collaborative session's unsent Yjs updates. Pulled synchronously inside
   * `beforeunload`; returns its own withdrawal.
   */
  readonly registerUnsavedWorkProbe: (probe: () => boolean) => () => void;
  readonly onDocumentChange: (document: NoteDocument) => void;
  readonly onDocumentBaseline: (document: NoteDocument) => void;
  readonly onDocumentRejected: (rejected: boolean) => void;
  /**
   * A version the server assigned outside this machine (Part 58's collaborative
   * projection). Adopted only while nothing local is outstanding; see the
   * `external-version` event in `autosave-machine.ts`.
   */
  readonly applyExternalVersion: (version: number) => void;
  readonly requestPageSize: (pageSize: PageSize) => void;
  readonly retry: () => void;
  readonly reload: () => void;
}

type TimerRef = { current: ReturnType<typeof setTimeout> | null };

function clearTimer(timer: TimerRef): void {
  if (timer.current === null) return;
  clearTimeout(timer.current);
  timer.current = null;
}

export function useNoteAutosave({
  workspaceId,
  noteId,
  initialVersion,
  initialPageSize,
  canUpdate,
}: UseNoteAutosaveOptions): NoteAutosaveHandle {
  const router = useRouter();

  const [snapshot, setSnapshot] = useState<AutosaveState>(() =>
    createAutosaveState({ version: initialVersion, pageSize: initialPageSize }),
  );
  // The authoritative copy. Timers and request callbacks fire outside React's
  // render cycle and must read the newest state, not a captured one.
  const stateRef = useRef<AutosaveState>(snapshot);
  const mountedRef = useRef(true);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timers and promises need to dispatch, and dispatch schedules timers, so the
  // cycle is broken through a ref rather than by rebuilding either.
  const dispatchRef = useRef<(event: AutosaveEvent) => void>(() => undefined);
  /** Set by `registerUnsavedWorkProbe`; read only by the unload handler. */
  const unsavedWorkProbe = useRef<(() => boolean) | null>(null);

  const performSave = useCallback(
    async (effect: Extract<AutosaveEffect, { kind: "save" }>): Promise<void> => {
      const result = await updateNote(workspaceId, noteId, effect.input, {
        keepalive: effect.keepalive,
      });
      if (result.ok) {
        dispatchRef.current({
          type: "save-succeeded",
          saveId: effect.saveId,
          note: { version: result.data.note.version, pageSize: result.data.note.pageSize },
        });
        return;
      }
      dispatchRef.current({
        type: "save-failed",
        saveId: effect.saveId,
        kind: result.kind,
        retryable: result.retryable,
        retryAfterMs: result.retryAfterMs,
      });
    },
    [workspaceId, noteId],
  );

  const dispatch = useCallback(
    (event: AutosaveEvent): void => {
      // After unmount there is nothing left to render and no timer left to
      // schedule; a late response is simply dropped.
      if (!mountedRef.current) return;
      const transition = autosaveReducer(stateRef.current, event);
      stateRef.current = transition.state;
      setSnapshot(transition.state);
      for (const effect of transition.effects) {
        switch (effect.kind) {
          case "cancel-debounce":
            clearTimer(debounceTimer);
            break;
          case "schedule-debounce":
            clearTimer(debounceTimer);
            debounceTimer.current = setTimeout(() => {
              debounceTimer.current = null;
              dispatchRef.current({ type: "debounce-elapsed" });
            }, effect.delayMs);
            break;
          case "cancel-retry":
            clearTimer(retryTimer);
            break;
          case "schedule-retry":
            clearTimer(retryTimer);
            retryTimer.current = setTimeout(() => {
              retryTimer.current = null;
              dispatchRef.current({ type: "retry-elapsed" });
            }, effect.delayMs);
            break;
          case "save":
            void performSave(effect);
            break;
        }
      }
    },
    [performSave],
  );
  dispatchRef.current = dispatch;

  // Read inside the teardown below, which must not be rebuilt when they change.
  const targetRef = useRef({ workspaceId, noteId });
  targetRef.current = { workspaceId, noteId };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer(debounceTimer);
      clearTimer(retryTimer);
      /**
       * An in-app navigation unmounts this page without firing `beforeunload`
       * or `visibilitychange`, so a debounce that had not elapsed yet would
       * take the writing with it. The queued patch is sent one last time,
       * fire-and-forget: there is no component left to report the answer to,
       * and `keepalive` lets the browser finish it after the tree is gone.
       */
      const state = stateRef.current;
      const input = pendingSaveInput(state);
      if (input === null || !canSaveNow(state)) return;
      void updateNote(targetRef.current.workspaceId, targetRef.current.noteId, input, {
        keepalive: true,
      });
    };
  }, []);

  // Read after mount so the server render and the first client render agree.
  useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      dispatchRef.current({ type: "online-changed", online: false });
    }
  }, []);

  useEffect(() => {
    function handleOnline(): void {
      dispatchRef.current({ type: "online-changed", online: true });
    }
    function handleOffline(): void {
      dispatchRef.current({ type: "online-changed", online: false });
    }
    /**
     * The one reliable "the page may be going away" signal. `beforeunload` and
     * `unload` are unreliable on mobile and inside bfcache, so the flush is
     * driven from here and the request is made `keepalive` so the browser is
     * allowed to finish it after the document is hidden or discarded.
     * `navigator.sendBeacon` is deliberately not used: it cannot set the
     * `Content-Type` and `Origin` handling the API's trusted-origin check needs.
     */
    function handleVisibilityChange(): void {
      if (document.visibilityState !== "hidden") return;
      dispatchRef.current({ type: "flush", keepalive: true });
    }
    /**
     * No asynchronous work here — none is permitted during unload. This only
     * asks the browser for its native "leave site?" prompt while something is
     * unacknowledged, which is the last chance to stop an in-memory queue from
     * being discarded.
     */
    function handleBeforeUnload(event: BeforeUnloadEvent): void {
      // Two writers, one prompt. `hasUnsavedWork` covers the PATCH this machine
      // owns; the probe covers a collaborative session's unsent Yjs updates,
      // which this machine cannot see at all — in collaborative mode it never
      // receives a `document-changed`, so it would report "nothing pending"
      // while the tab holds edits the status line promised would sync.
      if (!hasUnsavedWork(stateRef.current) && unsavedWorkProbe.current?.() !== true) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  // A reload (`router.refresh()`) re-renders the Server Component with a newer
  // version, which re-seeds the machine and invalidates any response still in
  // flight from the pre-reload state.
  const seedRef = useRef({ version: initialVersion, pageSize: initialPageSize });
  useEffect(() => {
    if (
      seedRef.current.version === initialVersion &&
      seedRef.current.pageSize === initialPageSize
    ) {
      return;
    }
    seedRef.current = { version: initialVersion, pageSize: initialPageSize };
    dispatchRef.current({
      type: "reset",
      version: initialVersion,
      pageSize: initialPageSize,
      document: null,
    });
  }, [initialVersion, initialPageSize]);

  const onDocumentChange = useCallback(
    (document: NoteDocument): void => {
      if (!canUpdate) return;
      dispatchRef.current({ type: "document-changed", document });
    },
    [canUpdate],
  );

  const onDocumentBaseline = useCallback((document: NoteDocument): void => {
    dispatchRef.current({ type: "document-baseline", document });
  }, []);

  const onDocumentRejected = useCallback((rejected: boolean): void => {
    dispatchRef.current({ type: "document-rejected", rejected });
  }, []);

  const applyExternalVersion = useCallback((version: number): void => {
    dispatchRef.current({ type: "external-version", version });
  }, []);

  const requestPageSize = useCallback(
    (pageSize: PageSize): void => {
      if (!canUpdate) return;
      dispatchRef.current({ type: "page-size-changed", pageSize });
    },
    [canUpdate],
  );

  const retry = useCallback((): void => {
    dispatchRef.current({ type: "retry-requested" });
  }, []);

  const reload = useCallback((): void => {
    router.refresh();
  }, [router]);

  // Not React state: read synchronously inside `beforeunload`, and it must never
  // cause a render. One slot, because a note has one editor.
  const registerUnsavedWorkProbe = useCallback((probe: () => boolean): (() => void) => {
    unsavedWorkProbe.current = probe;
    return () => {
      if (unsavedWorkProbe.current === probe) unsavedWorkProbe.current = null;
    };
  }, []);

  return {
    status: snapshot.status,
    description: describeAutosave(snapshot),
    pageSize: effectivePageSize(snapshot),
    version: snapshot.version,
    savedPageSize: snapshot.savedPageSize,
    savedDocument: snapshot.savedDocument,
    documentRejected: snapshot.documentRejected,
    hasUnsavedWork: hasUnsavedWork(snapshot),
    registerUnsavedWorkProbe,
    onDocumentChange,
    onDocumentBaseline,
    onDocumentRejected,
    applyExternalVersion,
    requestPageSize,
    retry,
    reload,
  };
}
