"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * The per-note presence roster (Part 59).
 *
 * A module-level observable rather than React state, for the same reason as
 * `lib/notes/focus-mode.ts`: the writers (the socket handlers in
 * `presence-client.ts`) and the readers (the presence bar, the editor surface)
 * are not in a parent/child relationship, so there is no prop to thread.
 *
 * Keyed by `noteId`, never global. One tab can hold two note rooms open, and a
 * single shared roster would paint note A's viewers on note B.
 *
 * Nothing here is written to `localStorage` or `sessionStorage`. Presence is
 * ephemeral by construction — ADR 0004 makes the server the authority on who is
 * in a room, and a persisted roster would outlive the connection that earned it
 * and show ghosts to the next reader. The store is rebuilt from the server's
 * announce ack on every mount.
 *
 * The store holds no colours and no display names, only ids and a colour index:
 * identity is minted by the server (see `presence-client.ts`), and rendering is
 * the UI layer's job.
 */

export interface PresenceViewer {
  readonly presenceId: string;
  readonly userId: string;
  readonly colorIndex: number;
  readonly awarenessClientId: number;
}

export interface PresenceRoster {
  readonly viewers: readonly PresenceViewer[];
  readonly selfPresenceId: string | null;
  readonly viewerCount: number;
  /** The server refused to list: more viewers than the roster cap. */
  readonly overflow: boolean;
}

/** Mirrors the API's REALTIME_MAX_PRESENCE_PER_ROOM default. */
export const PRESENCE_ROSTER_MAX = 50;

/**
 * The one object every note without a roster shares. `useSyncExternalStore`
 * compares snapshots by reference and re-renders forever if `getSnapshot`
 * builds a fresh value each call, so "no roster" must be a singleton and not a
 * new `{ viewers: [] }`.
 */
export const EMPTY_PRESENCE_ROSTER: PresenceRoster = Object.freeze({
  viewers: Object.freeze([]) as readonly PresenceViewer[],
  selfPresenceId: null,
  viewerCount: 0,
  overflow: false,
});

type PresenceListener = () => void;

const rosters = new Map<string, PresenceRoster>();
const listenersByNote = new Map<string, Set<PresenceListener>>();

/**
 * Deterministic order by `presenceId`. Anything derived from arrival order
 * would reshuffle the avatar row every time somebody joined or reconnected,
 * which reads as flicker rather than as information. Compared by code unit, not
 * by locale: the same roster must sort the same way in every browser.
 */
function byPresenceId(first: PresenceViewer, second: PresenceViewer): number {
  if (first.presenceId < second.presenceId) return -1;
  if (first.presenceId > second.presenceId) return 1;
  return 0;
}

function freezeRoster(
  viewers: readonly PresenceViewer[],
  selfPresenceId: string | null,
  viewerCount: number,
  overflow: boolean,
): PresenceRoster {
  const sorted = Object.freeze([...viewers].sort(byPresenceId));
  // The count can never be smaller than the rows we are holding, whatever the
  // server or a caller claims.
  const count = Math.max(viewerCount, sorted.length);

  return Object.freeze({
    viewers: sorted,
    selfPresenceId,
    viewerCount: count,
    overflow: overflow || count > sorted.length,
  });
}

function publish(noteId: string, roster: PresenceRoster): void {
  rosters.set(noteId, roster);

  const listeners = listenersByNote.get(noteId);
  if (listeners === undefined) return;
  // Copied before iterating so a listener that unsubscribes during the
  // notification cannot skip the next one.
  for (const listener of [...listeners]) listener();
}

/** Replaces the whole roster: the answer to an announce, not an increment. */
export function setPresenceRoster(noteId: string, roster: PresenceRoster): void {
  publish(
    noteId,
    freezeRoster(roster.viewers, roster.selfPresenceId, roster.viewerCount, roster.overflow),
  );
}

export function applyPresenceJoined(noteId: string, entry: PresenceViewer): void {
  const current = getPresenceRoster(noteId);

  // Two kinds of stale row are dropped here, not one:
  //   - the same `presenceId`, because a re-announce is an update, not a second
  //     viewer;
  //   - the same `awarenessClientId` under a different `presenceId`, because an
  //     epoch reset re-mints presence for a tab that keeps its Yjs client id,
  //     and the abandoned row would paint a ghost caret label next to the live
  //     one.
  const kept = current.viewers.filter(
    (viewer) =>
      viewer.presenceId !== entry.presenceId &&
      viewer.awarenessClientId !== entry.awarenessClientId,
  );
  const dropped = current.viewers.length - kept.length;
  const viewerCount = current.viewerCount - dropped + 1;

  if (kept.length >= PRESENCE_ROSTER_MAX) {
    // Past the cap the roster stops growing but the count keeps telling the
    // truth, so the UI can say "and N more" instead of lying about the room.
    publish(noteId, freezeRoster(kept, current.selfPresenceId, viewerCount, true));
    return;
  }

  publish(noteId, freezeRoster([...kept, entry], current.selfPresenceId, viewerCount, false));
}

export function applyPresenceLeft(noteId: string, presenceId: string): void {
  const current = rosters.get(noteId);
  if (current === undefined) return;

  const kept = current.viewers.filter((viewer) => viewer.presenceId !== presenceId);

  if (kept.length === current.viewers.length) {
    // Not one of the rows we hold. Either a frame for somebody we never listed
    // — nothing to do, and notifying would re-render every subscriber for no
    // change — or the departure of a viewer the cap hid from us, which is the
    // only signal we will ever get that the hidden tail shrank.
    if (current.viewerCount <= kept.length) return;

    publish(
      noteId,
      freezeRoster(current.viewers, current.selfPresenceId, current.viewerCount - 1, false),
    );
    return;
  }

  const selfPresenceId = current.selfPresenceId === presenceId ? null : current.selfPresenceId;
  // `freezeRoster` floors the count at the row count and recomputes `overflow`,
  // so the badge clears itself once the hidden tail is gone.
  publish(noteId, freezeRoster(kept, selfPresenceId, current.viewerCount - 1, false));
}

/** Drops the note's roster entirely: unmount, disable, or a failed announce. */
export function clearPresence(noteId: string): void {
  if (!rosters.delete(noteId)) return;

  const listeners = listenersByNote.get(noteId);
  if (listeners === undefined) return;
  for (const listener of [...listeners]) listener();
}

export function getPresenceRoster(noteId: string): PresenceRoster {
  return rosters.get(noteId) ?? EMPTY_PRESENCE_ROSTER;
}

export function subscribeToPresence(noteId: string, listener: PresenceListener): () => void {
  const registered = listenersByNote.get(noteId) ?? new Set<PresenceListener>();
  registered.add(listener);
  listenersByNote.set(noteId, registered);

  return () => {
    registered.delete(listener);
    // The map must not accumulate one empty `Set` per note ever opened.
    if (registered.size === 0 && listenersByNote.get(noteId) === registered) {
      listenersByNote.delete(noteId);
    }
  };
}

/** A Server Component render has no socket and therefore no viewers. */
function serverSnapshot(): PresenceRoster {
  return EMPTY_PRESENCE_ROSTER;
}

/** Subscribe a client component to one note's roster. */
export function usePresence(noteId: string): PresenceRoster {
  // Both callbacks are memoised on `noteId`: `useSyncExternalStore` resubscribes
  // whenever `subscribe` changes identity, and a fresh closure every render
  // would tear the subscription down and rebuild it on every keystroke.
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeToPresence(noteId, onStoreChange),
    [noteId],
  );
  const snapshot = useCallback(() => getPresenceRoster(noteId), [noteId]);

  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
