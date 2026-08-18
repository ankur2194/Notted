import type { IsoTimestamp, UserId, WorkspaceId } from "./common";
import type { WorkspaceRole } from "./workspace";

export const SHELL_API_PATHS = Object.freeze({
  bootstrap: "/api/v1/shell/bootstrap",
  notifications: "/api/v1/workspaces/:workspaceId/notifications",
} as const);

export interface ShellUserSummary {
  readonly id: UserId;
  readonly name: string;
  readonly email: string;
}

export interface ShellWorkspaceMembership {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly slug: string;
  readonly role: WorkspaceRole;
}

/** Display hints only. The API re-authorizes every operation. */
export interface ShellPresentationPermissions {
  readonly canViewSettings: boolean;
  readonly canManageWorkspace: boolean;
  readonly canManageMembers: boolean;
  readonly canCreateContent: boolean;
}

export interface ShellBootstrap {
  readonly user: ShellUserSummary;
  readonly workspaces: readonly ShellWorkspaceMembership[];
  readonly currentWorkspace: ShellWorkspaceMembership | null;
  readonly permissions: ShellPresentationPermissions;
  readonly notificationUnreadCount: number;
}

export type NotificationKind = "system" | "workspace" | "mention" | "comment" | "export";
export type NotificationTargetType = "workspace" | "note" | "comment" | "export" | "settings";

export interface NotificationSummary {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly kind: NotificationKind;
  readonly actorId: UserId | null;
  readonly targetType: NotificationTargetType | null;
  readonly targetId: string | null;
  readonly summary: string;
  readonly targetLabel: string | null;
  readonly createdAt: IsoTimestamp;
  readonly readAt: IsoTimestamp | null;
}

export interface NotificationPage {
  readonly items: readonly NotificationSummary[];
  readonly page: number;
  readonly limit: number;
  readonly hasMore: boolean;
  readonly unreadCount: number;
}

export interface NotificationReadResult {
  readonly notification: NotificationSummary;
  readonly unreadCount: number;
}

export interface NotificationEmailPreference {
  readonly mentionEmail: boolean;
}

export interface NotificationsMarkAllResult {
  readonly updatedCount: number;
  readonly unreadCount: 0;
}
