import { useEffect } from "react";

import type { PresenceRoster, PresenceViewer } from "@/lib/realtime/presence-store";

import { getRealtimeSocket } from "@/lib/collaboration/realtime-socket";
import { PRESENCE_COLOR_COUNT } from "@/lib/collaboration/user-color";
import {
  applyPresenceJoined,
  applyPresenceLeft,
  clearPresence,
  setPresenceRoster,
  usePresence,
} from "@/lib/realtime/presence-store";

/**
 * The socket wiring behind `presence-store` (Part 59).
 *
 * No `"use client"`: this module holds no JSX and is only ever imported by a
 * client component, exactly like `lib/collaboration/useNoteCollaboration.ts`.
 * Marking it would only widen the client boundary for nothing.
 *
 * It owns no connection. `getRealtimeSocket()` is the single multiplexed socket
 * for the tab (Part 58); presence is one more set of events on it.
 *
 * Presence is decoration. Every failure path here ends in an empty roster and
 * silence — a note must stay editable when nobody can be listed.
 */

const EVENT = {
  announce: "realtime:presence:announce",
  joined: "realtime:presence:joined",
  left: "realtime:presence:left",
} as const;

/**
 * How long an announce ack is still worth adopting. Generous on purpose — this
 * is a staleness bound, not a latency budget, and a slow-but-honest ack should
 * still populate the roster.
 */
const ANNOUNCE_ACK_TIMEOUT_MS = 10_000;

export interface NotePresenceOptions {
  readonly enabled: boolean;
  readonly workspaceId: string;
  readonly noteId: string;
  /** The live Yjs awareness clientID; `null` until the collaborative binding exists. */
  readonly awarenessClientId: number | null;
  /**
   * Whether Part 58's handshake currently holds the note room on the SERVER.
   *
   * Load-bearing, not cosmetic. The gateway refuses an announce from a socket
   * that is not already in the room, and the room is entered by `note:sync`,
   * whose ack is asynchronous. Announcing off the socket's own `connect` event
   * would therefore fire in the same tick the provider *starts* its re-join and
   * be denied every time, leaving the roster permanently empty after a
   * reconnect. `synced` is the provider's own "the room is joined" signal, so
   * re-announcing is keyed to it instead.
   */
  readonly synced: boolean;
}

/* ------------------------------------------------------------------------- *
 * Trust boundary
 *
 * Every frame below arrives over a socket and is `unknown` until proven
 * otherwise. These parsers are deliberately local copies rather than imports
 * from `note-collaboration-provider.ts`: that module's helpers are private to
 * the Yjs protocol, and presence must not become a reason to widen them.
 * ------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The colour index selects a CSS custom property (`--notted-presence-0..7`), so
 * an out-of-range value would resolve to nothing and render an invisible caret
 * label. Clamped rather than rejected: a viewer with an odd colour is still a
 * viewer worth showing.
 */
function clampColorIndex(index: number): number {
  return Math.min(Math.max(index, 0), PRESENCE_COLOR_COUNT - 1);
}

function parseViewer(value: unknown): PresenceViewer | null {
  const record = asRecord(value);
  if (record === null) return null;

  const presenceId = asString(record.presenceId);
  const userId = asString(record.userId);
  const colorIndex = asInteger(record.colorIndex);
  const awarenessClientId = asInteger(record.awarenessClientId);

  if (presenceId === null || userId === null || colorIndex === null || awarenessClientId === null) {
    return null;
  }

  return { presenceId, userId, colorIndex: clampColorIndex(colorIndex), awarenessClientId };
}

/**
 * Lenient about the list, strict about each row: one unparsable viewer is not a
 * reason to show an empty room.
 */
function parseViewers(value: unknown): PresenceViewer[] | null {
  if (!Array.isArray(value)) return null;

  const viewers: PresenceViewer[] = [];
  for (const entry of value) {
    const viewer = parseViewer(entry);
    if (viewer !== null) viewers.push(viewer);
  }

  return viewers;
}

/**
 * One Socket.io connection is shared by the whole app and Socket.io dispatches
 * by EVENT NAME, not by room: a socket holding two note rooms receives both
 * notes' presence frames on these handlers. Part 58 found this the hard way on
 * the document channel. Every frame carries `noteId`; anything else is somebody
 * else's note and is dropped.
 */
function isForNote(record: Record<string, unknown>, noteId: string): boolean {
  return record.noteId === noteId;
}

export function useNotePresence(options: NotePresenceOptions): PresenceRoster {
  const { enabled, workspaceId, noteId, awarenessClientId, synced } = options;

  useEffect(() => {
    // No awareness client id means there is no collaborative binding yet, so
    // there is nothing to tie a caret to and nothing worth announcing. Not
    // synced means the server does not hold the room for us yet, and an
    // announce would be denied.
    if (!enabled || !synced || awarenessClientId === null) {
      clearPresence(noteId);
      return;
    }

    const socket = getRealtimeSocket();
    // Guards every write that can land after cleanup: an ack in flight when the
    // note unmounts must not repopulate the roster we just cleared.
    let active = true;
    /*
     * Socket.io acks have no deadline of their own, so a server that accepts the
     * announce and never answers leaves this callback armed for the lifetime of
     * the socket. The roster is already empty until the ack lands, so the value
     * here is the other direction: an ack that arrives minutes later describes a
     * room as it was minutes ago, and painting that stale roster over a live one
     * is worse than showing nobody. After the deadline the announce is abandoned
     * and its ack ignored.
     */
    let ackDeadline: ReturnType<typeof setTimeout> | undefined;
    let abandoned = false;

    const handleJoined = (payload: unknown): void => {
      const record = asRecord(payload);
      if (!active || record === null || !isForNote(record, noteId)) return;

      const viewer = parseViewer(record.presence);
      if (viewer === null) return;

      applyPresenceJoined(noteId, viewer);
    };

    const handleLeft = (payload: unknown): void => {
      const record = asRecord(payload);
      if (!active || record === null || !isForNote(record, noteId)) return;

      const presenceId = asString(record.presenceId);
      if (presenceId === null) return;

      applyPresenceLeft(noteId, presenceId);
    };

    const announce = (): void => {
      ackDeadline = setTimeout(() => {
        abandoned = true;
        if (active) clearPresence(noteId);
      }, ANNOUNCE_ACK_TIMEOUT_MS);
      // The payload carries the room selector and the awareness client id, and
      // deliberately nothing else — no presenceId, no userId, no display name,
      // no colour. The server mints the identity from the authenticated socket.
      // This is the anti-forgery guarantee, not an oversight: a client that
      // could name itself could impersonate any member of the workspace.
      socket.emit(
        EVENT.announce,
        { selector: { kind: "note", workspaceId, noteId }, awarenessClientId },
        (raw: unknown) => {
          clearTimeout(ackDeadline);
          if (!active || abandoned) return;

          const record = asRecord(raw);
          if (record === null) {
            clearPresence(noteId);
            return;
          }

          if (record.ok !== true) {
            const viewerCount = asInteger(record.viewerCount);
            if (record.error === "limited" && viewerCount !== null) {
              // Too many viewers to list. The count is still true, so the UI can
              // say how busy the note is without naming anybody.
              setPresenceRoster(noteId, {
                viewers: [],
                selfPresenceId: null,
                viewerCount,
                overflow: true,
              });
              return;
            }
            // Denied, unavailable, malformed: stay silent and show nobody.
            clearPresence(noteId);
            return;
          }

          const self = parseViewer(record.presence);
          const viewers = parseViewers(record.viewers);
          const viewerCount = asInteger(record.viewerCount);

          if (self === null || viewers === null || viewerCount === null) {
            clearPresence(noteId);
            return;
          }

          setPresenceRoster(noteId, {
            viewers,
            selfPresenceId: self.presenceId,
            viewerCount,
            // Never on this path. A successful ack lists exactly what it counts
            // (`realtime.gateway.ts` answers `viewerCount: viewers.length`), and
            // the ONE case where the server counts more than it lists is the
            // `limited` branch above, which sets this itself. A `viewerCount >
            // viewers.length` comparison here read like a second source of
            // truth while being dead code.
            overflow: false,
          });
        },
      );
    };

    // Listeners before the announce: the ack carries the roster as it was when
    // the server handled it, and a join that happens in between arrives as a
    // frame. Announcing first would drop that viewer until their next event.
    socket.on(EVENT.joined, handleJoined);
    socket.on(EVENT.left, handleLeft);

    // A reconnect is a new socket session on the server, so the old presence
    // entry died with the old socket and the room must be announced again. That
    // re-announce is driven by `synced` re-entering this effect — never by the
    // socket's `connect` event, which fires before the room has been re-joined.
    if (socket.connected) announce();

    return () => {
      active = false;
      clearTimeout(ackDeadline);
      socket.off(EVENT.joined, handleJoined);
      socket.off(EVENT.left, handleLeft);
      // No leave frame. `NoteCollaborationProvider.destroy()` already emits
      // `realtime:room:leave`, and the API broadcasts presence-left from both
      // its leave handler and its disconnect cleanup. A second emit here would
      // be a duplicate at best and a race at worst — do not add one.
      clearPresence(noteId);
    };
  }, [enabled, workspaceId, noteId, awarenessClientId, synced]);

  return usePresence(noteId);
}
