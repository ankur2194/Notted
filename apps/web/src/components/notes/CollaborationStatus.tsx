import type { NoteCollaborationStatus } from "@/lib/collaboration/note-collaboration-provider";
import type { NoteCollaborationMode } from "@/lib/collaboration/useNoteCollaboration";

/**
 * Live-editing state, in plain language (Part 58).
 *
 * The house pattern from `SaveStatusIndicator`: one inline polite live region
 * that rewrites itself, never a toast. A writer who is reconnecting several
 * times an hour must not be interrupted several times an hour, and the same
 * words have to stay on screen afterwards for anyone who missed the
 * announcement.
 *
 * No hooks and no handlers, so no `"use client"` boundary is opened here — it
 * renders wherever its parent renders.
 *
 * Nothing is signalled by colour, and nothing moves: every state has its own
 * sentence. In solo mode this renders nothing at all, because the save
 * indicator beside it is already saying the only thing that matters — the note
 * is being saved.
 */

export const COLLAB_STATUS_TEST_ID = "note-collab-status";

export interface CollaborationStatusProps {
  readonly mode: NoteCollaborationMode;
  readonly status: NoteCollaborationStatus;
  readonly peerCount?: number;
}

const MESSAGE: Readonly<Record<NoteCollaborationStatus, string>> = {
  connecting: "Connecting to live editing",
  synced: "Live editing",
  reconnecting: "Reconnecting",
  offline: "Offline — changes will sync when you reconnect",
  error: "Live editing unavailable — saving normally",
};

function message(status: NoteCollaborationStatus, peerCount: number): string {
  if (status !== "synced" || peerCount <= 0) {
    return MESSAGE[status];
  }

  return `${MESSAGE.synced} · ${peerCount} ${peerCount === 1 ? "other" : "others"} editing`;
}

export function CollaborationStatus({ mode, status, peerCount = 0 }: CollaborationStatusProps) {
  if (mode === "solo") {
    return null;
  }

  return (
    <p
      // Polite and atomic, matching the save indicator: a fragment such as
      // "2 others editing" without its state reads as a different message.
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid={COLLAB_STATUS_TEST_ID}
      data-collab-status={status}
      data-notted-print-hide
      className="notted-collab-status text-sm text-muted-foreground"
    >
      {message(status, peerCount)}
    </p>
  );
}
