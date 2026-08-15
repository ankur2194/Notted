import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type {
  NoteCollaborationBinding,
  NoteCollaborationSnapshot,
  NoteCollaborationStatus,
} from "@/lib/collaboration/note-collaboration-provider";

import { NoteCollaborationProvider } from "@/lib/collaboration/note-collaboration-provider";
import { getRealtimeSocket } from "@/lib/collaboration/realtime-socket";

/**
 * The React adapter around `NoteCollaborationProvider` (Part 58).
 *
 * No `"use client"`: this module holds no JSX and is only ever imported by a
 * client component, exactly like `components/notes/useNoteAutosave.ts`'s
 * sibling modules. Marking it would only widen the client boundary.
 *
 * `mode` is the decision the editor cares about, and it is deliberately
 * three-valued. `"pending"` means the handshake has not answered yet, so the
 * caller must not commit to either editor shape; `"collaborative"` means the
 * document is shared; `"solo"` means live editing is unavailable and the Part 39
 * autosave is the only writer. Falling back to solo is always safe — the note is
 * still saved — which is why every failure path resolves here rather than
 * retrying forever.
 *
 * It is a SUBSCRIPTION to the provider's status, not the result of the first
 * handshake. The provider re-handshakes on every `realtime:ready`, so a session
 * that started solo because the server was slow to accept the connection is
 * promoted the moment a handshake succeeds. It is deliberately one-way:
 * demoting a live session would remount `TiptapEditor` onto the note's
 * load-time document and lose everything typed since. A collaborative session
 * whose writes start failing keeps its editor and gets the Part 39 autosave
 * back instead — see `NoteEditorSurface`.
 */

export type NoteCollaborationMode = "pending" | "collaborative" | "solo";

export interface NoteCollaborationState {
  readonly mode: NoteCollaborationMode;
  readonly binding: NoteCollaborationBinding | null;
  readonly epoch: number;
  /**
   * Identifies the current `Y.Doc`. The editor must key its remount on this and
   * not on `epoch` — the `stale`-ack reset path replaces the document without
   * moving the epoch.
   */
  readonly generation: number;
  readonly status: NoteCollaborationStatus;
}

export interface UseNoteCollaborationOptions {
  readonly enabled: boolean;
  readonly workspaceId: string;
  readonly noteId: string;
  readonly user: { readonly id: string; readonly name: string };
  /** The server projected a Yjs revision into a stored note version. */
  readonly onProjected?: (version: number) => void;
  /** The epoch moved: the document was discarded and rebuilt. */
  readonly onReset?: () => void;
}

const DISABLED_SNAPSHOT: NoteCollaborationSnapshot = Object.freeze({
  status: "offline" as NoteCollaborationStatus,
  epoch: 0,
  generation: 0,
  errorReason: null,
});

const NO_OP_UNSUBSCRIBE = () => {};

export function useNoteCollaboration(options: UseNoteCollaborationOptions): NoteCollaborationState {
  const { enabled, workspaceId, noteId } = options;
  const userId = options.user.id;
  const userName = options.user.name;

  const [provider, setProvider] = useState<NoteCollaborationProvider | null>(null);
  const [mode, setMode] = useState<NoteCollaborationMode>(enabled ? "pending" : "solo");

  // Callbacks live in refs so a caller re-creating them inline cannot tear the
  // socket down and re-run the handshake on every render.
  const onProjectedRef = useRef(options.onProjected);
  const onResetRef = useRef(options.onReset);

  useEffect(() => {
    onProjectedRef.current = options.onProjected;
    onResetRef.current = options.onReset;
  });

  useEffect(() => {
    if (!enabled) {
      setProvider(null);
      setMode("solo");
      return;
    }

    const instance = new NoteCollaborationProvider({
      socket: getRealtimeSocket(),
      workspaceId,
      noteId,
      user: { id: userId, name: userName },
    });
    let active = true;

    setProvider(instance);
    setMode("pending");

    const stopProjected = instance.onProjected((payload) => {
      onProjectedRef.current?.(payload.version);
    });

    // Epoch 0 is "never synced", so the first sync is not a reset.
    let lastEpoch = 0;
    const stopSnapshots = instance.subscribe((snapshot) => {
      // Any successful handshake promotes the session, including one that only
      // succeeded after `connect()` had already given up.
      if (snapshot.status === "synced") {
        setMode("collaborative");
      }
      if (snapshot.epoch === lastEpoch) {
        return;
      }
      const previous = lastEpoch;
      lastEpoch = snapshot.epoch;
      if (previous !== 0) {
        onResetRef.current?.();
      }
    });

    void instance.connect().then((synced) => {
      if (!active) {
        return;
      }
      // Never demotes: a handshake that resolved late has already published
      // `"synced"` through the subscription above, and this one-shot result is
      // only allowed to settle a session that has not started.
      setMode((current) => (current === "collaborative" || synced ? "collaborative" : "solo"));
    });

    return () => {
      active = false;
      stopProjected();
      stopSnapshots();
      instance.destroy();
      setProvider(null);
    };
  }, [enabled, workspaceId, noteId, userId, userName]);

  const snapshot = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => provider?.subscribe(onStoreChange) ?? NO_OP_UNSUBSCRIBE,
      [provider],
    ),
    () => provider?.snapshot ?? DISABLED_SNAPSHOT,
    () => DISABLED_SNAPSHOT,
  );

  return {
    mode,
    // Only a live, synced provider hands out a binding: an editor bound to a
    // document the server never acknowledged would look collaborative and
    // silently lose every keystroke.
    binding: provider !== null && mode === "collaborative" ? provider.binding : null,
    epoch: snapshot.epoch,
    generation: snapshot.generation,
    status: snapshot.status,
  };
}
