import type { NoteMoveDestination } from "./NoteList";
import type { CustomTaskStatus, NoteSummary } from "@notted/shared-types";

/**
 * The note view-switching contract (Part 49.4). Four clauses, and a new view is
 * only a "view" if it satisfies all four.
 *
 * 1. **One query key per scope.** Every view (grid / list / board / timeline) is
 *    a pure projection of the same cached `NotePage` under
 *    `noteQueryKeys.list(workspaceId, query)`. Switching views issues no *note*
 *    request and writes nothing. A view may read an adjacent resource under that
 *    resource's own key factory — the timeline reads tasks under
 *    `taskQueryKeys.list` — but never a second note query.
 *
 * 2. **One mutation shape.** The only note write any view may perform is
 *    `moveNote(workspaceId, noteId, destination)` where `destination` is
 *    `NoteMoveDestination`. A view never calls `updateNote` and never touches
 *    `content`, `title` or `version` directly.
 *
 * 3. **No view may add a column to `notes`.** `board_column_id` is the last
 *    field a view is permitted to introduce; anything a future view needs that
 *    is not derivable from `NoteSummary` + `TaskSummary` + `ProjectDetail` is an
 *    ADR, not a view.
 *
 * 4. **Fixed child props.** `NoteBrowser` remains the sole owner of data,
 *    mutations, the live region and the version-conflict banner. Each view child
 *    receives the `NoteViewProps` data/gating/mutation surface below and returns
 *    markup; anything else a view receives is purely presentational and carries
 *    no new note field. A new view is a new file implementing that prop type,
 *    with zero container changes.
 */
export interface NoteViewProps {
  readonly notes: readonly NoteSummary[];
  readonly columns: readonly CustomTaskStatus[];
  readonly projectDueAt: string | null;
  readonly canEdit: boolean;
  readonly pendingIds: ReadonlySet<string>;
  readonly onMove: (note: NoteSummary, destination: NoteMoveDestination) => void;
}
