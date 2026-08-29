import type { IsoTimestamp, NoteId, UserId } from "./common";

function collectionPath(workspaceId: string, noteId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/notes/${encodeURIComponent(noteId)}/comments`;
}

export const COMMENT_API_PATHS = Object.freeze({
  collection: collectionPath,
  detail: (workspaceId: string, noteId: string, commentId: string): string =>
    `${collectionPath(workspaceId, noteId)}/${encodeURIComponent(commentId)}`,
  resolution: (workspaceId: string, noteId: string, commentId: string): string =>
    `${collectionPath(workspaceId, noteId)}/${encodeURIComponent(commentId)}/resolution`,
} as const);

/** Encoding scheme for a selection anchor. See `comment.schema.ts`. */
export type CommentAnchorScheme = "yrel:1" | "pmabs:1";

/**
 * A stored selection anchor, echoed back exactly as the client wrote it. The
 * server never remaps: only a client holding the live Y.Doc can resolve
 * `relFrom`/`relTo`, and it derives orphan state from that resolution.
 */
export interface CommentAnchor {
  readonly scheme: CommentAnchorScheme;
  readonly from: number;
  readonly to: number;
  readonly quote: string;
  readonly relFrom?: string;
  readonly relTo?: string;
  readonly schemaVersion: number;
}

export interface CommentAuthor {
  readonly id: UserId;
  readonly name: string;
}

export interface CommentSummary {
  readonly id: string;
  readonly noteId: NoteId;
  readonly parentId: string | null;
  readonly content: string;
  readonly createdBy: CommentAuthor;
  readonly isResolved: boolean;
  readonly resolvedAt: IsoTimestamp | null;
  readonly resolvedBy: CommentAuthor | null;
  /** `null` = a whole-note comment with no selection. */
  readonly anchor: CommentAnchor | null;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** One top-level comment with its replies, oldest first. */
export interface CommentThread extends CommentSummary {
  readonly replies: readonly CommentSummary[];
  /**
   * `true` when this thread has more replies than the server returns.
   *
   * Replies are capped PER THREAD rather than across the page, so one very long
   * argument cannot starve the other threads — and the cap is reported instead
   * of applied silently, because a truncated list that looks complete is worse
   * than an obviously partial one.
   */
  readonly repliesTruncated: boolean;
}

export interface CommentPage {
  readonly items: readonly CommentThread[];
  readonly page: number;
  readonly limit: number;
  readonly hasMore: boolean;
  /** Unresolved top-level threads on this note, across all pages. */
  readonly openCount: number;
}

export interface CommentMutationResult {
  readonly comment: CommentSummary;
}

export interface CommentDeleteResult {
  readonly id: string;
  /** The comment plus any replies removed by the `parent_id` cascade. */
  readonly deletedCount: number;
}

/**
 * Server -> note-room broadcast. IDENTIFIERS ONLY: no content, no author name.
 * `noteId` is mandatory — one app-wide socket receives every joined note's
 * frames on the same handler, so a frame without it would be applied to the
 * wrong note (the cross-note corruption Part 58 fixed).
 */
export interface CommentChangedEvent {
  readonly noteId: NoteId;
  readonly commentId: string;
  /** The top-level comment the change belongs to; equals `commentId` for a root. */
  readonly threadId: string;
  readonly kind: "created" | "updated" | "deleted" | "resolved" | "unresolved";
}
