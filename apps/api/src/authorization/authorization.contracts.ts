import type { AuthenticatedPrincipal } from "@notted/shared-types";

export const AUTHORIZATION_ACTIONS = [
  "workspace.read",
  "settings.read",
  "settings.update",
  "billing.read",
  "billing.update",
  "workspace.delete",
  "member.list",
  "member.invite",
  "member.update",
  "member.remove",
  "project.read",
  "project.create",
  "project.update",
  "project.delete",
  "project.share",
  "note.read",
  "note.create",
  "note.update",
  "note.delete",
  "note.share",
  "note.tag",
  "comment.read",
  "comment.create",
  "comment.update",
  "comment.delete",
  "comment.resolve",
  "export.create",
  "export.read",
  "export.download",
  "export.cancel",
  "apiKey.list",
  "apiKey.create",
  "apiKey.revoke",
  "webhook.list",
  "webhook.create",
  "webhook.update",
  "webhook.delete",
  "webhook.redeliver",
  "file.read",
  "file.upload",
  "file.delete",
  "folder.read",
  "folder.create",
  "folder.update",
  "folder.delete",
  "task.read",
  "task.create",
  "task.update",
  "task.delete",
  "task.assign",
  "task.tag",
  "tag.read",
  "tag.create",
  "tag.update",
  "tag.delete",
  "session.list",
  "session.revoke",
  // Part 67. Both address the `workspace` resource: AI is configured once per
  // workspace, and using it spends that workspace's quota against that
  // workspace's credential. `ai.configure` writes provider key material, so it
  // is admin-only AND high-risk; `ai.use` reaches editors but never viewers,
  // who have no authority to spend the workspace's AI budget.
  "ai.configure",
  "ai.use",
  // Part 71. Both address the `workspace` resource: an audit trail is
  // workspace-wide, not per-entity. Reading it exposes who did what, from
  // which address, so it is owner/admin only; exporting it additionally
  // leaves the system as a file.
  "audit.read",
  "audit.export",
] as const;

export type AuthorizationAction = (typeof AUTHORIZATION_ACTIONS)[number];

export const AUTHORIZATION_RESOURCE_KINDS = [
  "workspace",
  "settings",
  "billing",
  "workspaceDeletion",
  "member",
  "project",
  "note",
  "comment",
  "export",
  "apiKey",
  "webhook",
  "file",
  "folder",
  "task",
  "tag",
  "session",
] as const;

export type AuthorizationResourceKind = (typeof AUTHORIZATION_RESOURCE_KINDS)[number];
export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer";
export type ProjectAccessRole = "admin" | "editor" | "viewer";
export type NoteSharePermission = "edit" | "comment" | "view";
export type ApiKeyScope = "read" | "write" | "admin";

export interface UserAuthorizationActor {
  readonly kind: "user";
  readonly userId: string;
  readonly sessionId: string | null;
  readonly assurance: AuthenticatedPrincipal["assurance"];
  readonly authenticatedAt: string | null;
  readonly expiresAt: string | null;
  readonly isFresh: boolean;
  readonly source: "session" | "user-job";
}

export interface ApiKeyAuthorizationActor {
  readonly kind: "api-key";
  readonly apiKeyId: string;
  readonly workspaceId: string;
  readonly scopes: readonly ApiKeyScope[];
}

/** System authority is intentionally a finite capability, never a wildcard. */
export interface SystemAuthorizationActor {
  readonly kind: "system";
  readonly authorityId: string;
  readonly workspaceId: string;
  readonly purpose: string;
  readonly allowedActions: readonly AuthorizationAction[];
  readonly allowedResourceKinds: readonly AuthorizationResourceKind[];
}

export type AuthorizationActor =
  UserAuthorizationActor | ApiKeyAuthorizationActor | SystemAuthorizationActor;

export interface ProjectAuthorizationFacts {
  readonly restricted: boolean;
  readonly actorAccess: ProjectAccessRole | null;
}

export interface DelegationAuthorizationFacts {
  readonly requestedPermission: NoteSharePermission | ProjectAccessRole;
  readonly targetMemberActive: boolean;
  readonly targetProjectAccess: ProjectAccessRole | null;
}

export interface DelegationRequest {
  readonly requestedPermission: NoteSharePermission | ProjectAccessRole;
  readonly targetUserId: string;
}

/**
 * Server-loaded facts only. Callers must not construct these from request bodies,
 * cookies, room payloads, job payloads, object keys, or client permission flags.
 */
export interface AuthorizationResourceFacts {
  readonly kind: AuthorizationResourceKind;
  readonly id: string;
  readonly workspaceId: string | null;
  readonly loadedAt: string;
  readonly relationsValid: boolean;
  readonly creatorId?: string | null;
  readonly targetUserId?: string | null;
  readonly targetRole?: WorkspaceRole | null;
  readonly targetMemberActive?: boolean;
  readonly project?: ProjectAuthorizationFacts | null;
  readonly sharePermission?: NoteSharePermission | null;
  readonly requestedById?: string | null;
  readonly sourceReadable?: boolean;
  readonly status?: string | null;
  readonly delegation?: DelegationAuthorizationFacts | null;
  readonly note?: AuthorizationResourceFacts | null;
  readonly source?: AuthorizationResourceFacts | null;
}

export interface AuthorizationTenantFacts {
  readonly workspaceId: string | null;
  readonly membershipRole: WorkspaceRole | null;
  readonly membershipLoadedAt: string | null;
}

export interface AuthorizationEvaluation {
  readonly actor: AuthorizationActor | null;
  readonly action: AuthorizationAction | string | null;
  readonly resource: AuthorizationResourceFacts | null;
  readonly tenant: AuthorizationTenantFacts;
}

export type AuthorizationDenialCode =
  | "authorization.unauthenticated"
  | "authorization.concealed"
  | "authorization.forbidden"
  | "authorization.recent_authentication_required"
  | "authorization.invalid_request"
  | "authorization.stale_facts";

export interface AuthorizationAuditFacts {
  readonly action: string;
  readonly actorKind: AuthorizationActor["kind"] | "none";
  readonly resourceKind: AuthorizationResourceKind | "unknown";
  readonly outcome: "allow" | "deny";
  readonly reason: string;
}

export type AuthorizationDecision =
  | {
      readonly allowed: true;
      readonly audit: AuthorizationAuditFacts;
    }
  | {
      readonly allowed: false;
      readonly code: AuthorizationDenialCode;
      readonly httpStatus: 401 | 403 | 404;
      readonly safeMessage: string;
      readonly audit: AuthorizationAuditFacts;
    };

export type ResourceLocator =
  | { readonly kind: "workspace" | "settings" | "billing" | "workspaceDeletion" }
  | { readonly kind: "member"; readonly id: string }
  | { readonly kind: "project"; readonly id: string; readonly delegation?: DelegationRequest }
  | {
      readonly kind: "note";
      readonly id: string;
      readonly delegation?: DelegationRequest;
      readonly tagId?: string;
    }
  | {
      readonly kind: "task";
      readonly id: string;
      readonly targetUserId?: string;
      readonly tagId?: string;
    }
  | {
      readonly kind: "comment" | "export" | "apiKey" | "webhook" | "file" | "folder";
      readonly id: string;
    }
  | { readonly kind: "tag"; readonly id: string }
  | { readonly kind: "session"; readonly id: string; readonly targetUserId: string };

export interface AuthorizedOperation {
  readonly actor: AuthorizationActor;
  readonly action: AuthorizationAction;
  readonly resource: AuthorizationResourceFacts;
  readonly workspaceId: string | null;
  readonly userId: string | null;
  readonly decision: Extract<AuthorizationDecision, { readonly allowed: true }>;
  /**
   * The actor's workspace membership role at the time of authorization.
   *
   * `null` for system / API-key actors and for the session-only
   * `authorizeCurrentUserSession` path. User actors carry the role loaded by
   * `AuthorizationRepository.findMembership`; downstream handlers that need
   * the role for batch decisions (e.g. Part 52 search authorizing many notes
   * with one role lookup) read it from here rather than re-querying.
   */
  readonly membershipRole: WorkspaceRole | null;
}

export function actorFromPrincipal(principal: AuthenticatedPrincipal): UserAuthorizationActor {
  return Object.freeze({
    kind: "user",
    userId: principal.userId,
    sessionId: principal.sessionId,
    assurance: principal.assurance,
    authenticatedAt: principal.authenticatedAt,
    expiresAt: principal.expiresAt,
    isFresh: principal.isFresh,
    source: "session",
  });
}
