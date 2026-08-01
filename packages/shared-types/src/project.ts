import type { IsoTimestamp, ProjectId, UserId, WorkspaceId } from "./common";

export type ProjectStatus = "active" | "archived" | "completed";
export type ProjectSortField = "name" | "createdAt" | "updatedAt" | "dueAt";

/** REST paths mounted under the global /api/v1 prefix. */
export const PROJECT_API_PATHS = Object.freeze({
  collection: "/api/v1/workspaces/:workspaceId/projects",
  member: "/api/v1/workspaces/:workspaceId/projects/:projectId",
  archive: "/api/v1/workspaces/:workspaceId/projects/:projectId/archive",
  complete: "/api/v1/workspaces/:workspaceId/projects/:projectId/complete",
  restore: "/api/v1/workspaces/:workspaceId/projects/:projectId/restore",
} as const);

export interface ProjectSummary {
  id: ProjectId;
  workspaceId: WorkspaceId;
  name: string;
  description: string | null;
  /** Authorized app-relative attachment reference; the API never fetches it. */
  coverImageUrl: string | null;
  color: string;
  status: ProjectStatus;
  isArchived: boolean;
  dueAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface ProjectDetail extends ProjectSummary {
  createdById: UserId;
}

export interface ProjectListQuery {
  page: number;
  limit: number;
  status?: ProjectStatus;
  archived?: boolean;
  dueFrom?: IsoTimestamp;
  dueTo?: IsoTimestamp;
  name?: string;
  sortBy?: ProjectSortField;
  sortDirection?: "asc" | "desc";
}

export interface ProjectPage {
  items: readonly ProjectSummary[];
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface ProjectCreateResult {
  project: ProjectDetail;
}

export interface ProjectUpdateResult {
  project: ProjectDetail;
}

export interface ProjectStatusResult {
  project: ProjectDetail;
}

export interface ProjectDeleteResult {
  id: ProjectId;
  deleted: true;
}
