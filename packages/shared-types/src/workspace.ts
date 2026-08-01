import type { IsoTimestamp, UserId, WorkspaceId } from "./common";

export type WorkspacePlan = "free" | "pro" | "enterprise";
export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer";
export type WorkspaceSettings = {
  defaultPageSize: "a4" | "letter";
};

/**
 * REST paths exposed by the Part 26 workspace lifecycle endpoints. Mounted under
 * the global `/api/v1` prefix; `:id` is the workspace UUID selector.
 */
export const WORKSPACE_API_PATHS = Object.freeze({
  collection: "/api/v1/workspaces",
  member: "/api/v1/workspaces/:id",
} as const);

/** REST paths for Part 28 membership and invitation operations. */
export const MEMBERSHIP_API_PATHS = Object.freeze({
  members: "/api/v1/workspaces/:workspaceId/members",
  member: "/api/v1/workspaces/:workspaceId/members/:memberId",
  leave: "/api/v1/workspaces/:workspaceId/members/leave",
  invitations: "/api/v1/workspaces/:workspaceId/invitations",
  invitation: "/api/v1/workspaces/:workspaceId/invitations/:invitationId",
  resendInvitation: "/api/v1/workspaces/:workspaceId/invitations/:invitationId/resend",
  acceptInvitation: "/api/v1/invitations/accept",
} as const);

export interface WorkspaceSummary {
  id: WorkspaceId;
  name: string;
  slug: string;
  description: string | null;
  plan: WorkspacePlan;
  currentUserRole: WorkspaceRole;
  /** Public workspace branding logo. Database-only/secret columns stay internal. */
  logoUrl: string | null;
  updatedAt: IsoTimestamp;
}

export interface WorkspaceDetail extends WorkspaceSummary {
  domain: string | null;
  settings: WorkspaceSettings;
  /** Explicit override only; null means the plan-managed limit applies. */
  storageLimitBytes: number | null;
  createdById: UserId;
  createdAt: IsoTimestamp;
}

/** Query options for listing the authenticated user's workspace memberships. */
export interface WorkspaceListQuery {
  page: number;
  limit: number;
  name?: string;
  plan?: WorkspacePlan;
  currentUserRole?: WorkspaceRole;
  sortBy?: "name" | "createdAt" | "updatedAt";
  sortDirection?: "asc" | "desc";
}

/** Paginated membership view across the user's workspaces (not workspace-scoped). */
export interface WorkspacePage {
  items: readonly WorkspaceSummary[];
  page: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Create result carries the FINAL slug after collision-safe resolution so the
 * caller learns the persisted handle even when a suffix was appended.
 */
export interface WorkspaceCreateResult {
  workspace: WorkspaceDetail;
  slug: string;
}

export interface WorkspaceUpdateResult {
  workspace: WorkspaceDetail;
}

export interface WorkspaceDeleteResult {
  id: WorkspaceId;
  deleted: true;
}

export type WorkspaceInvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface WorkspaceMemberSummary {
  id: string;
  workspaceId: WorkspaceId;
  userId: UserId;
  name: string;
  email: string;
  role: WorkspaceRole;
  joinedAt: IsoTimestamp;
}

export interface WorkspaceInvitationSummary {
  id: string;
  workspaceId: WorkspaceId;
  email: string;
  role: WorkspaceRole;
  status: WorkspaceInvitationStatus;
  invitedById: UserId;
  acceptedById: UserId | null;
  expiresAt: IsoTimestamp;
  acceptedAt: IsoTimestamp | null;
  revokedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface MembershipListQuery {
  page: number;
  limit: number;
}

export interface WorkspaceMemberPage extends MembershipListQuery {
  items: readonly WorkspaceMemberSummary[];
  hasMore: boolean;
}

export interface WorkspaceInvitationPage extends MembershipListQuery {
  items: readonly WorkspaceInvitationSummary[];
  hasMore: boolean;
}

export interface WorkspaceInviteResult {
  invitation: WorkspaceInvitationSummary;
}

export interface WorkspaceInvitationAcceptResult {
  membership: WorkspaceMemberSummary;
  joined: boolean;
}

export interface WorkspaceMemberRoleChangeResult {
  membership: WorkspaceMemberSummary;
  previousRole: WorkspaceRole;
}

export interface WorkspaceInvitationResendResult {
  revokedInvitationId: string;
  invitation: WorkspaceInvitationSummary;
}

export interface WorkspaceInvitationRevokeResult {
  invitationId: string;
  revoked: true;
}

export interface WorkspaceMemberLeaveResult {
  memberId: string;
  left: true;
}

export interface WorkspaceMemberRemoveResult {
  memberId: string;
  removed: true;
}
