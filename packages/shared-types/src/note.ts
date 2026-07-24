import type { IsoTimestamp, NoteId, ProjectId, TagId, UserId, WorkspaceId } from "./common";

export type NoteType = "document" | "task-list";
export type PageSize = "a4" | "letter";

/**
 * Note transport metadata only. TipTap/Yjs documents and rendered content are
 * intentionally deferred to their versioned document contract.
 */
export interface NoteSummary {
  id: NoteId;
  workspaceId: WorkspaceId;
  projectId: ProjectId | null;
  parentId: NoteId | null;
  title: string;
  type: NoteType;
  pageSize: PageSize;
  isTemplate: boolean;
  isPinned: boolean;
  isArchived: boolean;
  tagIds: TagId[];
  version: number;
  updatedAt: IsoTimestamp;
}

export interface NoteDetail extends NoteSummary {
  isDeleted: boolean;
  deletedAt: IsoTimestamp | null;
  createdById: UserId;
  updatedById: UserId | null;
  createdAt: IsoTimestamp;
}
