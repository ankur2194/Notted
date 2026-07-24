import type { IsoTimestamp, UserId, WorkspaceId } from "./common";

export type WorkspacePlan = "free" | "pro" | "enterprise";
export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer";

export interface WorkspaceSummary {
  id: WorkspaceId;
  name: string;
  slug: string;
  description: string | null;
  plan: WorkspacePlan;
  currentUserRole: WorkspaceRole;
  updatedAt: IsoTimestamp;
}

export interface WorkspaceDetail extends WorkspaceSummary {
  domain: string | null;
  createdById: UserId;
  createdAt: IsoTimestamp;
}
