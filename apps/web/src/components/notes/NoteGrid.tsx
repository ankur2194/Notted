import { NoteCard } from "./NoteCard";

import type { NoteSummary, TagSummary } from "@notted/shared-types";
import type { ReactNode } from "react";

/**
 * The read-focused card layout (Notted.md §5, "Grid View"). Denser than the
 * list and deliberately without ordering affordances: reordering is the list's
 * and the board's job, and a three-column grid gives a drag no meaningful
 * anchor. It is still a pure projection of the container's cached page, so it
 * costs no request.
 */
export function NoteGrid({
  notes,
  controlsFor,
  tagsById,
}: {
  readonly notes: readonly NoteSummary[];
  readonly controlsFor: (note: NoteSummary) => ReactNode;
  readonly tagsById?: ReadonlyMap<string, TagSummary>;
}) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Notes">
      {notes.map((note) => (
        <li key={note.id}>
          <NoteCard note={note} tagsById={tagsById} controls={controlsFor(note)} />
        </li>
      ))}
    </ul>
  );
}
