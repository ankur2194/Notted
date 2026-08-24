import { Injectable } from "@nestjs/common";

import {
  AUTHORIZATION_ACTIONS,
  AUTHORIZATION_RESOURCE_KINDS,
  type AuthorizationAction,
  type AuthorizationActor,
  type AuthorizationAuditFacts,
  type AuthorizationDecision,
  type AuthorizationEvaluation,
  type AuthorizationResourceFacts,
  type NoteSharePermission,
  type ProjectAccessRole,
  type WorkspaceRole,
} from "./authorization.contracts";

const ACTIONS = new Set<string>(AUTHORIZATION_ACTIONS);
const RESOURCE_KINDS = new Set<string>(AUTHORIZATION_RESOURCE_KINDS);
const HIGH_RISK_ACTIONS = new Set<AuthorizationAction>([
  "billing.update",
  "workspace.delete",
  "member.update",
  "member.remove",
  "apiKey.create",
  "apiKey.revoke",
  "webhook.create",
  "webhook.update",
  "webhook.delete",
  "session.revoke",
  // Part 67: writes a provider API key. Same class as `apiKey.create` —
  // long-lived credential material entering the system on a stolen session.
  "ai.configure",
]);
const MAX_FACT_AGE_MS = 30_000;

const RESOURCE_KINDS_BY_ACTION: Readonly<Record<AuthorizationAction, readonly string[]>> = {
  "workspace.read": ["workspace"],
  "settings.read": ["settings"],
  "settings.update": ["settings"],
  "billing.read": ["billing"],
  "billing.update": ["billing"],
  "workspace.delete": ["workspaceDeletion"],
  "member.list": ["workspace"],
  "member.invite": ["workspace"],
  "member.update": ["member"],
  "member.remove": ["member"],
  "project.read": ["project"],
  "project.create": ["workspace"],
  "project.update": ["project"],
  "project.delete": ["project"],
  "project.share": ["project"],
  "note.read": ["note"],
  "note.create": ["workspace", "project", "note"],
  "note.update": ["note"],
  "note.delete": ["note"],
  "note.share": ["note"],
  "note.tag": ["note"],
  "comment.read": ["comment"],
  "comment.create": ["note"],
  "comment.update": ["comment"],
  "comment.delete": ["comment"],
  "comment.resolve": ["comment"],
  "export.create": ["workspace", "project", "note"],
  "export.read": ["export"],
  "export.download": ["export"],
  "export.cancel": ["export"],
  "apiKey.list": ["workspace"],
  "apiKey.create": ["workspace"],
  "apiKey.revoke": ["apiKey"],
  "webhook.list": ["workspace"],
  "webhook.create": ["workspace"],
  "webhook.update": ["webhook"],
  "webhook.delete": ["webhook"],
  "webhook.redeliver": ["webhook"],
  "file.read": ["file"],
  "file.upload": ["note"],
  "file.delete": ["file"],
  "folder.read": ["folder"],
  "folder.create": ["workspace", "folder"],
  "folder.update": ["folder"],
  "folder.delete": ["folder"],
  "task.read": ["task"],
  "task.create": ["workspace", "project", "task"],
  "task.update": ["task"],
  "task.delete": ["task"],
  "task.assign": ["task"],
  "task.tag": ["task"],
  "tag.read": ["workspace", "tag"],
  "tag.create": ["workspace"],
  "tag.update": ["tag"],
  "tag.delete": ["tag"],
  "session.list": ["session"],
  "session.revoke": ["session"],
  "ai.configure": ["workspace"],
  "ai.use": ["workspace"],
};

const NOTE_PERMISSION_RANK: Readonly<Record<NoteSharePermission, number>> = {
  view: 1,
  comment: 2,
  edit: 3,
};
const PROJECT_PERMISSION_RANK: Readonly<Record<ProjectAccessRole, number>> = {
  viewer: 1,
  editor: 2,
  admin: 3,
};

function audit(
  evaluation: AuthorizationEvaluation,
  outcome: "allow" | "deny",
  reason: string,
): AuthorizationAuditFacts {
  return Object.freeze({
    action: typeof evaluation.action === "string" ? evaluation.action : "unknown",
    actorKind: evaluation.actor?.kind ?? "none",
    resourceKind: evaluation.resource?.kind ?? "unknown",
    outcome,
    reason,
  });
}

function deny(
  evaluation: AuthorizationEvaluation,
  code: Extract<AuthorizationDecision, { allowed: false }>["code"],
  reason: string,
): AuthorizationDecision {
  if (code === "authorization.unauthenticated") {
    return Object.freeze({
      allowed: false,
      code,
      httpStatus: 401,
      safeMessage: "Authentication is required.",
      audit: audit(evaluation, "deny", reason),
    });
  }
  if (code === "authorization.concealed") {
    return Object.freeze({
      allowed: false,
      code,
      httpStatus: 404,
      safeMessage: "The requested resource was not found.",
      audit: audit(evaluation, "deny", reason),
    });
  }
  return Object.freeze({
    allowed: false,
    code,
    httpStatus: 403,
    safeMessage:
      code === "authorization.recent_authentication_required"
        ? "Confirm your identity to continue."
        : "You are not allowed to do that.",
    audit: audit(evaluation, "deny", reason),
  });
}

function allow(evaluation: AuthorizationEvaluation, reason: string): AuthorizationDecision {
  return Object.freeze({ allowed: true, audit: audit(evaluation, "allow", reason) });
}

function isFreshTimestamp(value: string | null | undefined, now: number): boolean {
  if (value === null || value === undefined) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= now && now - parsed <= MAX_FACT_AGE_MS;
}

function projectCanRead(resource: AuthorizationResourceFacts): boolean {
  const project = resource.project;
  return (
    project === null || project === undefined || !project.restricted || project.actorAccess !== null
  );
}

function projectCanEdit(resource: AuthorizationResourceFacts): boolean {
  const project = resource.project;
  return (
    project === null ||
    project === undefined ||
    !project.restricted ||
    project.actorAccess === "editor" ||
    project.actorAccess === "admin"
  );
}

function projectCanAdmin(resource: AuthorizationResourceFacts): boolean {
  return resource.project?.actorAccess === "admin";
}

function projectCanManage(resource: AuthorizationResourceFacts): boolean {
  return resource.project?.actorAccess === "admin" || resource.project?.actorAccess === "editor";
}

function noteCanEdit(resource: AuthorizationResourceFacts, actorId: string): boolean {
  const note = resource.kind === "note" ? resource : resource.note;
  if (note === null || note === undefined || !projectCanEdit(note)) return false;
  return note.creatorId === actorId || note.sharePermission === "edit";
}

function noteCanComment(resource: AuthorizationResourceFacts): boolean {
  const note = resource.kind === "note" ? resource : resource.note;
  return note !== null && note !== undefined && projectCanRead(note);
}

function resourceCanRead(resource: AuthorizationResourceFacts): boolean {
  if (resource.kind === "note") return projectCanRead(resource);
  if (resource.kind === "comment" || resource.kind === "file") {
    return resource.note !== null && resource.note !== undefined && projectCanRead(resource.note);
  }
  if (resource.kind === "project" || resource.kind === "task") return projectCanRead(resource);
  return true;
}

function exportSourceReadable(resource: AuthorizationResourceFacts): boolean {
  return (
    resource.sourceReadable === true &&
    resource.source !== null &&
    resource.source !== undefined &&
    resourceCanRead(resource.source)
  );
}

function editorDelegationAllowed(resource: AuthorizationResourceFacts, actorId: string): boolean {
  const delegation = resource.delegation;
  if (delegation === null || delegation === undefined || !delegation.targetMemberActive)
    return false;
  if (resource.kind === "project") {
    if (!projectCanAdmin(resource)) return false;
    return PROJECT_PERMISSION_RANK[delegation.requestedPermission as ProjectAccessRole] <= 2;
  }
  if (resource.kind !== "note" || !noteCanEdit(resource, actorId)) return false;
  const requested = delegation.requestedPermission as NoteSharePermission;
  if (!(requested in NOTE_PERMISSION_RANK) || NOTE_PERMISSION_RANK[requested] > 3) return false;
  if (resource.project?.restricted === true) {
    const target = delegation.targetProjectAccess;
    if (target === null) return false;
    const projectCap = target === "viewer" ? 2 : 3;
    return NOTE_PERMISSION_RANK[requested] <= projectCap;
  }
  return true;
}

function delegationIsValid(resource: AuthorizationResourceFacts): boolean {
  const delegation = resource.delegation;
  if (delegation === null || delegation === undefined || !delegation.targetMemberActive)
    return false;
  if (resource.kind === "project") {
    return delegation.requestedPermission in PROJECT_PERMISSION_RANK;
  }
  if (resource.kind !== "note" || !(delegation.requestedPermission in NOTE_PERMISSION_RANK)) {
    return false;
  }
  if (resource.project?.restricted !== true) return true;
  const target = delegation.targetProjectAccess;
  if (target === null) return false;
  const cap = target === "viewer" ? 2 : 3;
  return NOTE_PERMISSION_RANK[delegation.requestedPermission as NoteSharePermission] <= cap;
}

@Injectable()
export class AuthorizationPolicyService {
  decide(evaluation: AuthorizationEvaluation, now = Date.now()): AuthorizationDecision {
    if (evaluation.actor === null) {
      return deny(evaluation, "authorization.unauthenticated", "missing_actor");
    }
    if (
      evaluation.action === null ||
      !ACTIONS.has(evaluation.action) ||
      evaluation.resource === null ||
      !RESOURCE_KINDS.has(evaluation.resource.kind)
    ) {
      return deny(evaluation, "authorization.invalid_request", "unknown_action_or_resource");
    }

    const action = evaluation.action as AuthorizationAction;
    const resource = evaluation.resource;
    if (!RESOURCE_KINDS_BY_ACTION[action].includes(resource.kind)) {
      return deny(evaluation, "authorization.invalid_request", "action_resource_mismatch");
    }
    if (!resource.relationsValid) {
      return deny(evaluation, "authorization.concealed", "invalid_parent_scope");
    }
    if (action === "export.download" && resource.status !== "ready") {
      return deny(evaluation, "authorization.forbidden", "export_not_downloadable");
    }
    if (
      action === "export.cancel" &&
      resource.status !== "queued" &&
      resource.status !== "processing"
    ) {
      return deny(evaluation, "authorization.forbidden", "export_not_cancellable");
    }
    if (!isFreshTimestamp(resource.loadedAt, now)) {
      return deny(evaluation, "authorization.stale_facts", "stale_resource_facts");
    }
    if ((action === "note.share" || action === "project.share") && !delegationIsValid(resource)) {
      return deny(evaluation, "authorization.forbidden", "delegation_cap_or_membership_denied");
    }

    if (resource.kind === "session") {
      return this.decideSession(evaluation, action, resource, now);
    }

    if (
      evaluation.tenant.workspaceId === null ||
      resource.workspaceId === null ||
      resource.workspaceId !== evaluation.tenant.workspaceId
    ) {
      return deny(evaluation, "authorization.concealed", "workspace_mismatch");
    }

    if (evaluation.actor.kind === "system") {
      return this.decideSystem(evaluation, action, resource);
    }
    if (evaluation.actor.kind === "api-key") {
      return this.decideApiKey(evaluation, action, resource);
    }

    if (
      evaluation.tenant.membershipRole === null ||
      !isFreshTimestamp(evaluation.tenant.membershipLoadedAt, now)
    ) {
      return deny(evaluation, "authorization.concealed", "missing_or_stale_membership");
    }
    if (evaluation.actor.expiresAt !== null && Date.parse(evaluation.actor.expiresAt) <= now) {
      return deny(evaluation, "authorization.unauthenticated", "expired_principal");
    }
    if (HIGH_RISK_ACTIONS.has(action) && !evaluation.actor.isFresh) {
      return deny(
        evaluation,
        "authorization.recent_authentication_required",
        "fresh_authentication_required",
      );
    }

    return this.decideUser(
      evaluation,
      action,
      resource,
      evaluation.tenant.membershipRole,
      evaluation.actor,
    );
  }

  /**
   * Part 52.2 — batch-friendly `note.read` predicate for the search result
   * repository. This is the SAME rule `decide` applies for `note.read` after
   * membership/tenant scoping succeeds, factored so the search path can decide
   * many notes from a single batched fact load without reconstructing a full
   * {@link AuthorizationEvaluation} per candidate.
   *
   * Rule (matches `projectCanRead` for editor/viewer, allow for owner/admin):
   * - owner/admin: always readable.
   * - editor/viewer: readable iff the project is null (standalone note), not
   *   restricted, OR the actor has an explicit `project_access` grant.
   *
   * The existing `note.read` policy DOES NOT broaden restricted-project access
   * via a note share (see `authorization-policy.service.test.ts` — "does not
   * let a note share broaden a restricted project"). Callers that want
   * search-time inclusion of explicitly-shared notes must OR that condition in
   * at the call site and document the deviation.
   */
  canReadNote(
    role: WorkspaceRole,
    project: {
      readonly restricted: boolean;
      readonly actorAccess: ProjectAccessRole | null;
    } | null,
  ): boolean {
    if (role === "owner" || role === "admin") return true;
    if (project === null || project === undefined) return true;
    return !project.restricted || project.actorAccess !== null;
  }

  private decideSession(
    evaluation: AuthorizationEvaluation,
    action: AuthorizationAction,
    resource: AuthorizationResourceFacts,
    now: number,
  ): AuthorizationDecision {
    const actor = evaluation.actor;
    if (actor === null || actor.kind !== "user" || resource.targetUserId !== actor.userId) {
      return deny(evaluation, "authorization.concealed", "session_owner_mismatch");
    }
    if (action !== "session.list" && action !== "session.revoke") {
      return deny(evaluation, "authorization.forbidden", "invalid_session_action");
    }
    if (action === "session.revoke" && !actor.isFresh) {
      return deny(
        evaluation,
        "authorization.recent_authentication_required",
        "fresh_authentication_required",
      );
    }
    if (actor.expiresAt !== null && Date.parse(actor.expiresAt) <= now) {
      return deny(evaluation, "authorization.unauthenticated", "expired_principal");
    }
    return allow(evaluation, "current_user_session_control");
  }

  private decideSystem(
    evaluation: AuthorizationEvaluation,
    action: AuthorizationAction,
    resource: AuthorizationResourceFacts,
  ): AuthorizationDecision {
    const actor = evaluation.actor as Extract<AuthorizationActor, { kind: "system" }>;
    if (
      actor.workspaceId !== resource.workspaceId ||
      !actor.allowedActions.includes(action) ||
      !actor.allowedResourceKinds.includes(resource.kind) ||
      actor.purpose.trim() === ""
    ) {
      return deny(evaluation, "authorization.forbidden", "system_capability_mismatch");
    }
    return allow(evaluation, "narrow_system_capability");
  }

  private decideApiKey(
    evaluation: AuthorizationEvaluation,
    action: AuthorizationAction,
    resource: AuthorizationResourceFacts,
  ): AuthorizationDecision {
    const actor = evaluation.actor as Extract<AuthorizationActor, { kind: "api-key" }>;
    if (actor.workspaceId !== resource.workspaceId) {
      return deny(evaluation, "authorization.concealed", "api_key_workspace_mismatch");
    }
    // Part 67: NO `ai.*` action is ever reachable by an API key, at any scope.
    // Configuring AI writes provider key material, and using AI spends money
    // against a credential the key's holder did not supply — neither belongs on
    // a long-lived integration token that no human is watching.
    if (action.startsWith("ai.")) {
      return deny(evaluation, "authorization.forbidden", "api_key_ai_denied");
    }
    const readAction =
      action.endsWith(".read") || action.endsWith(".list") || action === "export.download";
    const adminAction =
      action.startsWith("member.") ||
      action.startsWith("settings.") ||
      action.startsWith("billing.") ||
      action.startsWith("apiKey.") ||
      action.startsWith("webhook.") ||
      action === "workspace.delete";
    const allowed = adminAction
      ? actor.scopes.includes("admin")
      : readAction
        ? actor.scopes.includes("read") || actor.scopes.includes("admin")
        : actor.scopes.includes("write") || actor.scopes.includes("admin");
    return allowed && resourceCanRead(resource)
      ? allow(evaluation, "api_key_scope")
      : deny(evaluation, "authorization.forbidden", "api_key_scope_denied");
  }

  private decideUser(
    evaluation: AuthorizationEvaluation,
    action: AuthorizationAction,
    resource: AuthorizationResourceFacts,
    role: WorkspaceRole,
    actor: Extract<AuthorizationActor, { kind: "user" }>,
  ): AuthorizationDecision {
    if (role === "owner") return allow(evaluation, "workspace_owner");
    if (role === "admin") {
      if (
        action === "billing.read" ||
        action === "billing.update" ||
        action === "workspace.delete"
      ) {
        return deny(evaluation, "authorization.forbidden", "owner_only");
      }
      if (
        (action === "member.update" || action === "member.remove") &&
        resource.targetRole === "owner"
      ) {
        return deny(evaluation, "authorization.forbidden", "owner_membership_protected");
      }
      return allow(evaluation, "workspace_admin");
    }

    const editorAllowed = this.editorAllowed(action, resource, actor.userId);
    if (role === "editor" && editorAllowed) return allow(evaluation, "workspace_editor_policy");
    const viewerAllowed = this.viewerAllowed(action, resource, actor.userId);
    if (role === "viewer" && viewerAllowed) return allow(evaluation, "workspace_viewer_policy");
    return deny(evaluation, "authorization.forbidden", "role_or_resource_denied");
  }

  private editorAllowed(
    action: AuthorizationAction,
    resource: AuthorizationResourceFacts,
    actorId: string,
  ): boolean {
    if (
      action.startsWith("billing.") ||
      action.startsWith("apiKey.") ||
      action.startsWith("webhook.") ||
      action === "workspace.delete" ||
      action === "settings.update" ||
      action === "ai.configure" ||
      (action.startsWith("member.") && action !== "member.list")
    ) {
      return false;
    }
    if (["workspace.read", "settings.read", "member.list"].includes(action)) return true;
    // Editors write notes, so they may spend the workspace's AI budget on the
    // notes they write. They may not point that budget at a different provider.
    if (action === "ai.use") return true;
    if (action.endsWith(".read") || action.endsWith(".list") || action === "export.download") {
      if (resource.kind === "export") {
        return resource.requestedById === actorId && exportSourceReadable(resource);
      }
      return resourceCanRead(resource);
    }
    if (action === "project.update") return projectCanManage(resource);
    if (action === "project.share") return editorDelegationAllowed(resource, actorId);
    if (action === "note.create") return projectCanEdit(resource);
    if (action === "note.update") return noteCanEdit(resource, actorId);
    if (action === "note.share") return editorDelegationAllowed(resource, actorId);
    if (action === "note.tag") return noteCanEdit(resource, actorId);
    if (action === "comment.create") return noteCanComment(resource);
    if (action === "comment.update" || action === "comment.delete")
      return resource.creatorId === actorId;
    if (action === "comment.resolve") return noteCanEdit(resource, actorId);
    if (action === "export.create") {
      return resource.kind === "export"
        ? resource.sourceReadable === true
        : resourceCanRead(resource);
    }
    if (action === "export.cancel")
      return resource.requestedById === actorId && exportSourceReadable(resource);
    if (action === "file.upload") return noteCanEdit(resource, actorId);
    if (action === "file.delete") {
      return resource.creatorId === actorId && noteCanEdit(resource, actorId);
    }
    if (action === "folder.create") return true;
    if (action === "folder.update") return resource.creatorId === actorId;
    if (action === "task.create") return projectCanEdit(resource);
    if (action === "task.update") return resource.creatorId === actorId && projectCanEdit(resource);
    if (action === "task.assign")
      return projectCanEdit(resource) && resource.targetMemberActive === true;
    if (action === "task.tag") return resource.creatorId === actorId && projectCanEdit(resource);
    // `tag.read` needs no branch: it is caught by the `.read` suffix above.
    // `tag.delete` deliberately has none — deleting a tag strips it from every
    // note and task in the workspace, so it falls through to the final deny,
    // exactly like `note.delete` and `folder.delete`.
    if (action === "tag.create" || action === "tag.update") return true;
    return false;
  }

  private viewerAllowed(
    action: AuthorizationAction,
    resource: AuthorizationResourceFacts,
    actorId: string,
  ): boolean {
    if (
      action.startsWith("billing.") ||
      action.startsWith("apiKey.") ||
      action.startsWith("webhook.") ||
      action === "workspace.delete" ||
      action === "settings.update" ||
      // Viewers read; they never spend the workspace's AI budget, and the
      // prefix (not the two names) is denied so a future `ai.*` action cannot
      // slip in through the `.read`/`.list` suffix rule below.
      action.startsWith("ai.") ||
      (action.startsWith("member.") && action !== "member.list")
    ) {
      return false;
    }
    if (["workspace.read", "settings.read", "member.list"].includes(action)) return true;
    if (action.endsWith(".read") || action.endsWith(".list") || action === "file.read") {
      if (resource.kind === "export") {
        return resource.requestedById === actorId && exportSourceReadable(resource);
      }
      return resourceCanRead(resource);
    }
    if (action === "comment.create") return noteCanComment(resource);
    if (action === "comment.update" || action === "comment.delete")
      return resource.creatorId === actorId;
    if (action === "export.create") {
      return resource.kind === "export"
        ? resource.sourceReadable === true
        : resourceCanRead(resource);
    }
    if (action === "export.download" || action === "export.cancel") {
      return resource.requestedById === actorId && exportSourceReadable(resource);
    }
    return false;
  }
}
