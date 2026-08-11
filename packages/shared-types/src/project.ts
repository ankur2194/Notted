import type { IsoTimestamp, ProjectId, UserId, WorkspaceId } from "./common";
import type { WorkspaceRole } from "./workspace";

export type ProjectStatus = "active" | "archived" | "completed";
export type ProjectSortField = "name" | "createdAt" | "updatedAt" | "dueAt";
export type ProjectMemberAccessSource = "workspace" | "workspace-admin" | "project";
export type ProjectAccessRole = "admin" | "editor" | "viewer";

/** REST paths mounted under the global /api/v1 prefix. */
export const PROJECT_API_PATHS = Object.freeze({
  collection: "/api/v1/workspaces/:workspaceId/projects",
  member: "/api/v1/workspaces/:workspaceId/projects/:projectId",
  archive: "/api/v1/workspaces/:workspaceId/projects/:projectId/archive",
  complete: "/api/v1/workspaces/:workspaceId/projects/:projectId/complete",
  restore: "/api/v1/workspaces/:workspaceId/projects/:projectId/restore",
} as const);

export interface ProjectSummary {
  readonly id: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly description: string | null;
  /** Authorized app-relative attachment reference; the API never fetches it. */
  readonly coverImageUrl: string | null;
  readonly color: string;
  readonly status: ProjectStatus;
  readonly isArchived: boolean;
  readonly isRestricted: boolean;
  readonly dueAt: IsoTimestamp | null;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ProjectMutationProject extends ProjectSummary {
  readonly createdById: UserId;
}

export interface ProjectMember {
  readonly userId: UserId;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly workspaceRole: WorkspaceRole;
  readonly projectRole: ProjectAccessRole | null;
  readonly accessSource: ProjectMemberAccessSource;
}

export interface ProjectTaskProgress {
  /**
   * Part 48 widened the rollup: task rows PLUS inline TipTap checklist items
   * across the project's non-deleted notes. `canceled` tasks are excluded from
   * the total, matching `NoteSummary.progress.tasks` so the two never disagree.
   */
  readonly coverage: "tasks-and-checklists";
  readonly completed: number;
  readonly total: number;
}

export interface ProjectDetail extends ProjectMutationProject {
  readonly lastActivityAt: IsoTimestamp;
  readonly members: readonly ProjectMember[];
  readonly taskProgress: ProjectTaskProgress;
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
  project: ProjectMutationProject;
}

export interface ProjectUpdateResult {
  project: ProjectMutationProject;
}

export interface ProjectStatusResult {
  project: ProjectMutationProject;
}

export interface ProjectDeleteResult {
  id: ProjectId;
  deleted: true;
}
