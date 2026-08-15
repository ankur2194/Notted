"use client";

import { useQuery } from "@tanstack/react-query";

import { CollaborationStatus } from "./CollaborationStatus";

import type { NoteCollaborationStatus } from "@/lib/collaboration/note-collaboration-provider";
import type { NoteCollaborationMode } from "@/lib/collaboration/useNoteCollaboration";
import type { PresenceRoster } from "@/lib/realtime/presence-store";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { presenceColorVar } from "@/lib/collaboration/user-color";
import { fetchWorkspaceMemberDirectory } from "@/lib/notes/member-directory";
import { noteQueryKeys } from "@/lib/notes/query-keys";
import { PRESENCE_ROSTER_MAX } from "@/lib/realtime/presence-store";

/**
 * Who else has this note open, and whether live editing is actually working
 * (Part 59).
 *
 * One component for both because they are one sentence to the reader: "three
 * people are here and we are connected" is useless if the two halves can
 * disagree on screen. `CollaborationStatus` is rendered *inside* rather than
 * re-implemented, so Part 58's status vocabulary and its single
 * `[data-collab-status]` element survive untouched.
 *
 * ponytail: no "X is typing" indicator, deliberately. This document syncs at
 * character level and paints a live coloured caret with the writer's name on it,
 * so a typing flag would only restate what the caret already shows — at the cost
 * of an awareness field, a debounce, and a policy for how often a screen reader
 * hears about it. `Plan.md` asks for typing state "where useful"; on a surface
 * with a shared caret it is not. Revisit for a surface that has no caret to
 * share — a comment composer, if Part 60's threads prove one.
 */

/** How many initials fit before the row turns into a count. */
const INITIALS_LIMIT = 5;

/**
 * Part 58's copy for an identity we cannot name, reused verbatim.
 *
 * No display name is ever sent over the wire: `AuthenticatedPrincipal` carries
 * `userId` only, so putting a name in the presence frame would mean a database
 * read per socket for a decoration. Names are resolved here instead, from the
 * member directory the workspace already fetched.
 */
const UNNAMED_VIEWER = "Workspace member";

/** Visual stand-in for initials we cannot derive. Never the only signal — the row is labelled. */
const UNKNOWN_INITIAL = "?";

const RECONNECTABLE: ReadonlySet<NoteCollaborationStatus> = new Set([
  "reconnecting",
  "offline",
  "error",
]);

export interface PresenceBarProps {
  readonly mode: NoteCollaborationMode;
  readonly status: NoteCollaborationStatus;
  readonly workspaceId: string;
  readonly roster: PresenceRoster;
  readonly selfUserId?: string;
  /** Re-dials the shared socket. Never disabled. */
  readonly onReconnect: () => void;
}

function initialsOf(name: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return UNKNOWN_INITIAL;
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

function viewerCountLabel(count: number): string {
  return `${count} ${count === 1 ? "viewer" : "viewers"}`;
}

/** `Viewers: Ada Lovelace, Alan Turing and 3 more (5 viewers)`. */
function triggerLabel(shownNames: readonly string[], viewerCount: number): string {
  const remaining = Math.max(0, viewerCount - shownNames.length);
  const named = shownNames.join(", ");
  const listed = remaining === 0 ? named : `${named} and ${remaining} more`;
  return `Viewers: ${listed} (${viewerCountLabel(viewerCount)})`;
}

export function PresenceBar({
  mode,
  status,
  workspaceId,
  roster,
  selfUserId,
  onReconnect,
}: PresenceBarProps) {
  const hasOthers = roster.viewerCount > 1;

  /*
   * Names come from the same authorized member listing the share dialog and the
   * mention menu use, under the same cache key, so a note that already loaded it
   * spends no request at all. Presence is decoration: while this is loading, and
   * if it fails outright, every viewer simply renders unnamed and the bar keeps
   * working. Nothing here re-implements authorization — an unknown id is left
   * unnamed rather than looked up anywhere else.
   */
  const directory = useQuery({
    queryKey: noteQueryKeys.members(workspaceId),
    queryFn: () => fetchWorkspaceMemberDirectory(workspaceId),
    enabled: hasOthers,
  });

  const namesByUserId = new Map<string, string>(
    (directory.data?.items ?? []).map((member): [string, string] => [member.userId, member.name]),
  );
  const nameFor = (userId: string): string | null => namesByUserId.get(userId) ?? null;

  const shown = roster.viewers.slice(0, INITIALS_LIMIT);
  const hiddenCount = Math.max(0, roster.viewerCount - shown.length);

  return (
    <div
      className="flex flex-wrap items-center gap-3"
      data-testid="note-presence-bar"
      data-notted-print-hide
    >
      {/*
       * The one and only status line. `peerCount` is everyone *except* this
       * session, which is what "2 others editing" has to mean.
       */}
      <CollaborationStatus
        mode={mode}
        status={status}
        peerCount={Math.max(0, roster.viewerCount - 1)}
      />
      {RECONNECTABLE.has(status) ? (
        // Never natively `disabled` (the Part 34 rule): a disabled control can
        // vanish from the tab order while it is focused. `CollaborationStatus`
        // already says what is wrong, so this only offers the action.
        <Button
          type="button"
          size="sm"
          variant="link"
          className="h-auto p-0"
          data-testid="note-presence-reconnect"
          onClick={onReconnect}
        >
          Reconnect
        </Button>
      ) : null}
      {hasOthers ? (
        roster.overflow ? (
          // The server stopped listing past its cap, so there is no roster to
          // render — only an honest count.
          <p className="text-sm text-muted-foreground" data-testid="note-presence-overflow">
            {PRESENCE_ROSTER_MAX}+ viewers — too many to list
          </p>
        ) : (
          <Dialog>
            <DialogTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="link"
                className="h-auto p-0"
                data-testid="note-presence-trigger"
                aria-label={triggerLabel(
                  shown.map((viewer) => nameFor(viewer.userId) ?? UNNAMED_VIEWER),
                  roster.viewerCount,
                )}
              >
                <span
                  // Deliberately silent. Announcing every join and leave makes a
                  // ten-person session unusable with a screen reader; the count
                  // lives in this button's `aria-label` and in the dialog
                  // heading, which are read on demand instead.
                  aria-live="off"
                  data-testid="note-presence-initials"
                  className="flex items-center gap-1"
                >
                  {shown.map((viewer) => (
                    <span
                      key={viewer.presenceId}
                      // Colour is decoration only — the name is on the label and
                      // in the dialog list, never carried by the colour alone.
                      aria-hidden="true"
                      data-presence-initial
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[0.625rem] font-semibold text-white"
                      style={{ backgroundColor: presenceColorVar(viewer.colorIndex) }}
                    >
                      {initialsOf(nameFor(viewer.userId))}
                    </span>
                  ))}
                  {hiddenCount > 0 ? (
                    <span aria-hidden="true" className="text-sm text-muted-foreground">
                      +{hiddenCount} more
                    </span>
                  ) : null}
                </span>
              </Button>
            </DialogTrigger>
            <DialogContent data-testid="note-presence-dialog">
              <DialogHeader>
                <DialogTitle>{viewerCountLabel(roster.viewerCount)}</DialogTitle>
                <DialogDescription>Everyone with this note open right now.</DialogDescription>
              </DialogHeader>
              <ul className="space-y-2">
                {roster.viewers.map((viewer) => {
                  const name = nameFor(viewer.userId);
                  return (
                    <li
                      key={viewer.presenceId}
                      // The `Mention.ts` precedent: an id the directory cannot
                      // resolve is marked unknown, never silently dropped and
                      // never presented as a departed member.
                      data-presence-name-state={name === null ? "unknown" : "known"}
                      className="flex items-center gap-2 text-sm"
                    >
                      <span
                        aria-hidden="true"
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[0.625rem] font-semibold text-white"
                        style={{ backgroundColor: presenceColorVar(viewer.colorIndex) }}
                      >
                        {initialsOf(name)}
                      </span>
                      <span>
                        {name ?? UNNAMED_VIEWER}
                        {viewer.userId === selfUserId ? " (you)" : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </DialogContent>
          </Dialog>
        )
      ) : null}
    </div>
  );
}
