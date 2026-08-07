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
  /**
   * Part 45 storage usage. A SEPARATE route from the workspace detail on
   * purpose: usage is a `sum()` over the workspace's attachment rows, and every
   * ordinary workspace read would otherwise pay for it.
   */
  storage: "/api/v1/workspaces/:workspaceId/storage",
  /** Part 45 administrative cleanup. Owner/admin only; supports `dryRun`. */
  storageMaintenance: "/api/v1/workspaces/:workspaceId/storage/maintenance",
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

/**
 * Part 45 — derived workspace storage accounting.
 *
 * Every value is computed from the workspace's own `attachments` rows at read
 * time; there is no stored counter to drift. Field meanings:
 *
 * - `usedBytes` — bytes of attachments that finished uploading (`ready`).
 * - `pendingBytes` — bytes of uploads still in flight (`pending`/`processing`).
 *   These ARE the quota reservation, so they are already charged against the
 *   limit even though the content is not usable yet.
 * - `limitBytes` — the effective quota after the explicit override or the plan
 *   default is clamped by the deployment ceiling.
 * - `availableBytes` — `limitBytes - usedBytes - pendingBytes`, floored at zero.
 * - `attachmentCount` — number of `ready` attachments, i.e. files the workspace
 *   actually holds.
 * - `limitSource` — whether the limit came from an explicit per-workspace
 *   override or from the plan default, so settings can say which one applies.
 */
export interface WorkspaceStorageUsage {
  workspaceId: WorkspaceId;
  plan: WorkspacePlan;
  usedBytes: number;
  pendingBytes: number;
  limitBytes: number;
  availableBytes: number;
  attachmentCount: number;
  limitSource: "override" | "plan";
}

/** The four Part 45 sweeps, in the order the plan names them. */
export type StorageMaintenanceSweepName =
  "abandonedUploads" | "orphanedObjects" | "expiredExports" | "deletedNoteRetention";

/**
 * One sweep's outcome. Counts and UUID samples ONLY — never a filename, an
 * object key, a signed URL, or a byte of document content
 * (`docs/standards/observability.md`).
 */
export interface StorageMaintenanceSweepReport {
  sweep: StorageMaintenanceSweepName;
  /** Rows or objects the sweep looked at. */
  examined: number;
  /** How many of those met the sweep's deletion/marking predicate. */
  selected: number;
  /** Rows hard-deleted. Always `0` when `dryRun` is true. */
  rowsRemoved: number;
  /** Rows whose state was changed rather than deleted. `0` when `dryRun`. */
  rowsMarked: number;
  /** Objects removed from storage. Always `0` when `dryRun` is true. */
  objectsRemoved: number;
  /** `true` when the batch bound was hit and another pass has work left. */
  truncated: boolean;
  /** Bounded sample of affected resource UUIDs, for operator follow-up. */
  sampleIds: readonly string[];
  /**
   * Fixed-vocabulary observations (for example `storage_disabled`,
   * `unreferenced_attachments_detected`). Never free-form text from an error.
   */
  notes: readonly string[];
}

export interface StorageMaintenanceReport {
  startedAt: IsoTimestamp;
  finishedAt: IsoTimestamp;
  /** `true` means nothing was deleted or modified; counts are what WOULD happen. */
  dryRun: boolean;
  /** `workspace` for the authorized per-workspace route, `system` for the sweeper. */
  scope: "workspace" | "system";
  sweeps: readonly StorageMaintenanceSweepReport[];
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
