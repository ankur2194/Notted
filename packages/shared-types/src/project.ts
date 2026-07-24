import type { IsoTimestamp, ProjectId, UserId, WorkspaceId } from "./common";

export type ProjectStatus = "active" | "archived" | "completed";

export interface ProjectSummary {
  id: ProjectId;
  workspaceId: WorkspaceId;
  name: string;
  description: string | null;
  color: string;
  status: ProjectStatus;
  dueAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface ProjectDetail extends ProjectSummary {
  createdById: UserId;
}
