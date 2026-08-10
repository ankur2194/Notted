import type { IsoTimestamp, TagId, WorkspaceId } from "./common";

export const TAG_API_PATHS = Object.freeze({
  collection: (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/tags`,
  detail: (workspaceId: string, tagId: string) => `/api/v1/workspaces/${workspaceId}/tags/${tagId}`,
} as const);

export type TagSortField = "name" | "usage" | "createdAt";

export interface TagSummary {
  readonly id: TagId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  /**
   * `#rrggbb` accent color, lowercased. Never null on the wire: the database
   * column is nullable, and the service coalesces it to the shared default
   * (`TAG_DEFAULT_COLOR` in `@notted/shared-validators`) when projecting.
   */
  readonly color: string;
  readonly noteCount: number;
  readonly taskCount: number;
  readonly createdAt: IsoTimestamp;
}

export interface TagPage {
  readonly items: readonly TagSummary[];
  readonly page: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

export interface TagListQuery {
  readonly page: number;
  readonly limit: number;
  readonly name?: string;
  readonly sortBy: TagSortField;
  readonly sortDirection: "asc" | "desc";
}

export interface TagCreateResult {
  readonly tag: TagSummary;
}

export interface TagUpdateResult {
  readonly tag: TagSummary;
}

/**
 * Note and task detachments are reported separately on purpose: a confirmation
 * that says "used on 12 notes" while silently detaching 30 tasks is a
 * data-loss surprise. Do not blend them into one usage count.
 */
export interface TagDeleteResult {
  readonly tagId: TagId;
  readonly deleted: true;
  readonly removedNoteAssignments: number;
  readonly removedTaskAssignments: number;
}
