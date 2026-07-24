import type { IsoTimestamp, NoteId, ProjectId, WorkspaceId } from "./common";

export type SearchMode = "full-text" | "semantic" | "hybrid";

export interface SearchHighlight {
  field: "title" | "content" | "tag";
  snippet: string;
}

export interface SearchResultSummary {
  noteId: NoteId;
  workspaceId: WorkspaceId;
  projectId: ProjectId | null;
  title: string;
  updatedAt: IsoTimestamp;
  highlights: SearchHighlight[];
}

export interface SearchResultDetail extends SearchResultSummary {
  mode: SearchMode;
}
