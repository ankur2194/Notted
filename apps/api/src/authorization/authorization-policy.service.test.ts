import { describe, expect, it } from "vitest";

import { AuthorizationPolicyService } from "./authorization-policy.service";
import {
  AUTHORIZATION_ACTIONS,
  type AuthorizationAction,
  type AuthorizationEvaluation,
  type AuthorizationResourceFacts,
  type AuthorizationResourceKind,
  type UserAuthorizationActor,
  type WorkspaceRole,
} from "./authorization.contracts";

const NOW = Date.parse("2026-07-29T12:00:00.000Z");
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000002";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000003";

const actor: UserAuthorizationActor = Object.freeze({
  kind: "user",
  userId: USER_ID,
  sessionId: "session-1",
  assurance: "single-factor",
  authenticatedAt: new Date(NOW - 1_000).toISOString(),
  expiresAt: new Date(NOW + 60_000).toISOString(),
  isFresh: true,
  source: "session",
});

function kindForAction(action: AuthorizationAction): AuthorizationResourceKind {
  if (
    [
      "member.list",
      "member.invite",
      "project.create",
      "apiKey.list",
      "apiKey.create",
      "webhook.list",
      "webhook.create",
      "folder.create",
      "tag.create",
      // Part 67: AI is configured once per workspace and spends that
      // workspace's quota, so both AI actions address the workspace itself.
      "ai.configure",
      "ai.use",
      // Part 71: an audit trail is workspace-wide, not per-entity.
      "audit.read",
      "audit.export",
    ].includes(action)
  )
    return "workspace";
  if (action === "comment.create" || action === "file.upload" || action === "export.create")
    return "note";
  if (action === "task.create") return "project";
  if (action.startsWith("workspace."))
    return action === "workspace.delete" ? "workspaceDeletion" : "workspace";
  if (action.startsWith("settings.")) return "settings";
  if (action.startsWith("billing.")) return "billing";
  if (action.startsWith("member.")) return "member";
  if (action.startsWith("project.")) return "project";
  if (action.startsWith("note.")) return "note";
  if (action.startsWith("comment.")) return "comment";
  if (action.startsWith("export.")) return "export";
  if (action.startsWith("apiKey.")) return "apiKey";
  if (action.startsWith("webhook.")) return "webhook";
  if (action.startsWith("file.")) return "file";
  if (action.startsWith("folder.")) return "folder";
  if (action.startsWith("task.")) return "task";
  if (action.startsWith("tag.")) return "tag";
  return "session";
}

function noteFacts(
  overrides: Partial<AuthorizationResourceFacts> = {},
): AuthorizationResourceFacts {
  return Object.freeze({
    kind: "note",
    id: "note-1",
    workspaceId: WORKSPACE_ID,
    loadedAt: new Date(NOW).toISOString(),
    relationsValid: true,
    creatorId: USER_ID,
    project: null,
    sharePermission: null,
    ...overrides,
  });
}

function resourceFor(action: AuthorizationAction): AuthorizationResourceFacts {
  const kind = kindForAction(action);
  const common = {
    kind,
    id: `${kind}-1`,
    workspaceId: kind === "session" ? null : WORKSPACE_ID,
    loadedAt: new Date(NOW).toISOString(),
    relationsValid: true,
    creatorId: USER_ID,
  } as const;
  if (kind === "session") return Object.freeze({ ...common, targetUserId: USER_ID });
  if (kind === "project") {
    return Object.freeze({
      ...common,
      project: { restricted: false, actorAccess: null },
      ...(action === "project.share"
        ? {
            delegation: {
              requestedPermission: "viewer" as const,
              targetMemberActive: true,
              targetProjectAccess: null,
            },
          }
        : {}),
    });
  }
  if (kind === "note") {
    return noteFacts(
      action === "note.share"
        ? {
            delegation: {
              requestedPermission: "edit",
              targetMemberActive: true,
              targetProjectAccess: null,
            },
          }
        : {},
    );
  }
  if (kind === "comment" || kind === "file") return Object.freeze({ ...common, note: noteFacts() });
  if (kind === "task") {
    return Object.freeze({ ...common, project: { restricted: false, actorAccess: null } });
  }
  if (kind === "member")
    return Object.freeze({ ...common, targetUserId: OTHER_USER_ID, targetRole: "editor" });
  if (kind === "export") {
    return Object.freeze({
      ...common,
      requestedById: USER_ID,
      sourceReadable: true,
      source: noteFacts(),
      status: action === "export.cancel" ? "queued" : "ready",
    });
  }
  return Object.freeze(common);
}

function evaluation(
  role: WorkspaceRole,
  action: AuthorizationAction | string,
  resource: AuthorizationResourceFacts | null = typeof action === "string" &&
  AUTHORIZATION_ACTIONS.includes(action as AuthorizationAction)
    ? resourceFor(action as AuthorizationAction)
    : null,
  actorOverride: UserAuthorizationActor | null = actor,
): AuthorizationEvaluation {
  return {
    actor: actorOverride,
    action,
    resource,
    tenant: {
      workspaceId: resource?.kind === "session" ? null : WORKSPACE_ID,
      membershipRole: resource?.kind === "session" ? null : role,
      membershipLoadedAt: resource?.kind === "session" ? null : new Date(NOW).toISOString(),
    },
  };
}

const ADMIN_DENIED = new Set<AuthorizationAction>([
  "billing.read",
  "billing.update",
  "workspace.delete",
]);
const EDITOR_ALLOWED = new Set<AuthorizationAction>([
  "workspace.read",
  "settings.read",
  "member.list",
  "project.read",
  "note.read",
  "note.create",
  "note.update",
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
  "file.read",
  "file.upload",
  "file.delete",
  "folder.read",
  "folder.create",
  "folder.update",
  "task.read",
  "task.create",
  "task.update",
  "task.tag",
  // Editors curate the workspace tag vocabulary but may not delete a tag:
  // deleting one strips it from every note and task workspace-wide.
  "tag.read",
  "tag.create",
  "tag.update",
  // Editors may spend the workspace's AI budget on notes they write, but
  // `ai.configure` (provider key material) is deliberately absent.
  "ai.use",
  "session.list",
  "session.revoke",
]);
const VIEWER_ALLOWED = new Set<AuthorizationAction>([
  "workspace.read",
  "settings.read",
  "member.list",
  "project.read",
  "note.read",
  "comment.read",
  "comment.create",
  "comment.update",
  "comment.delete",
  "export.create",
  "export.read",
  "export.download",
  "export.cancel",
  "file.read",
  "folder.read",
  "task.read",
  "tag.read",
  "session.list",
  "session.revoke",
]);

describe("AuthorizationPolicyService", () => {
  const policy = new AuthorizationPolicyService();

  const roleCases: readonly [WorkspaceRole, ReadonlySet<AuthorizationAction>][] = [
    ["owner", new Set(AUTHORIZATION_ACTIONS)],
    ["admin", new Set(AUTHORIZATION_ACTIONS.filter((action) => !ADMIN_DENIED.has(action)))],
    ["editor", EDITOR_ALLOWED],
    ["viewer", VIEWER_ALLOWED],
  ];

  for (const [role, allowedActions] of roleCases) {
    it.each(AUTHORIZATION_ACTIONS)(
      `${role} evaluates %s against its canonical resource`,
      (action) => {
        expect(policy.decide(evaluation(role, action), NOW).allowed).toBe(
          allowedActions.has(action),
        );
      },
    );
  }

  it.each([
    ["unrestricted", { restricted: false, actorAccess: null }, true, true],
    ["restricted-no-grant", { restricted: true, actorAccess: null }, false, false],
    ["restricted-viewer", { restricted: true, actorAccess: "viewer" as const }, true, false],
    ["restricted-editor", { restricted: true, actorAccess: "editor" as const }, true, true],
  ])("applies project inheritance/restriction: %s", (_name, project, canRead, canEdit) => {
    const resource = noteFacts({ project, sharePermission: "edit", creatorId: OTHER_USER_ID });
    expect(policy.decide(evaluation("editor", "note.read", resource), NOW).allowed).toBe(canRead);
    expect(policy.decide(evaluation("editor", "note.update", resource), NOW).allowed).toBe(canEdit);
  });

  it("lets editors mutate projects only through an explicit delegated project role", () => {
    const inherited = resourceFor("project.update");
    const delegated = Object.freeze({
      ...inherited,
      project: { restricted: true, actorAccess: "editor" as const },
    });
    expect(policy.decide(evaluation("editor", "project.update", inherited), NOW).allowed).toBe(
      false,
    );
    expect(policy.decide(evaluation("editor", "project.update", delegated), NOW).allowed).toBe(
      true,
    );
  });

  it.each([
    [USER_ID, null, true],
    [OTHER_USER_ID, "edit" as const, true],
    [OTHER_USER_ID, "comment" as const, false],
    [OTHER_USER_ID, "view" as const, false],
    [OTHER_USER_ID, null, false],
  ])("applies note creator/share edit rules", (creatorId, sharePermission, expected) => {
    const resource = noteFacts({ creatorId, sharePermission });
    expect(policy.decide(evaluation("editor", "note.update", resource), NOW).allowed).toBe(
      expected,
    );
  });

  it("does not let a note share broaden a restricted project", () => {
    const resource = noteFacts({
      creatorId: OTHER_USER_ID,
      sharePermission: "edit",
      project: { restricted: true, actorAccess: null },
    });
    expect(policy.decide(evaluation("editor", "note.read", resource), NOW)).toMatchObject({
      allowed: false,
    });
  });

  it.each([
    ["comment.create", OTHER_USER_ID, true],
    ["comment.update", USER_ID, true],
    ["comment.delete", USER_ID, true],
    ["comment.update", OTHER_USER_ID, false],
    ["comment.resolve", OTHER_USER_ID, true],
  ] as const)("enforces comment/thread action %s", (action, creatorId, expected) => {
    const resource = Object.freeze({
      ...resourceFor(action),
      creatorId,
      note: noteFacts({ creatorId: USER_ID }),
    });
    expect(policy.decide(evaluation("editor", action, resource), NOW).allowed).toBe(expected);
  });

  it("caps editor delegation and requires a current target membership", () => {
    const base = noteFacts({ creatorId: USER_ID });
    const permitted = Object.freeze({
      ...base,
      delegation: {
        requestedPermission: "edit" as const,
        targetMemberActive: true,
        targetProjectAccess: null,
      },
    });
    const revokedTarget = Object.freeze({
      ...permitted,
      delegation: { ...permitted.delegation, targetMemberActive: false },
    });
    expect(policy.decide(evaluation("editor", "note.share", permitted), NOW).allowed).toBe(true);
    expect(policy.decide(evaluation("editor", "note.share", revokedTarget), NOW).allowed).toBe(
      false,
    );
    expect(policy.decide(evaluation("owner", "note.share", revokedTarget), NOW).allowed).toBe(
      false,
    );
  });

  it.each(["billing.read", "billing.update", "workspace.delete"] as const)(
    "keeps %s owner-only",
    (action) => {
      expect(policy.decide(evaluation("owner", action), NOW).allowed).toBe(true);
      expect(policy.decide(evaluation("admin", action), NOW).allowed).toBe(false);
    },
  );

  it.each(["apiKey.create", "apiKey.revoke", "webhook.create", "webhook.delete"] as const)(
    "requires admin privilege and freshness for %s",
    (action) => {
      expect(policy.decide(evaluation("admin", action), NOW).allowed).toBe(true);
      expect(policy.decide(evaluation("editor", action), NOW).allowed).toBe(false);
      expect(
        policy.decide(
          evaluation("admin", action, resourceFor(action), { ...actor, isFresh: false }),
          NOW,
        ),
      ).toMatchObject({ allowed: false, code: "authorization.recent_authentication_required" });
    },
  );

  it.each([
    ["editor", "tag.create", true],
    ["editor", "tag.update", true],
    ["editor", "tag.delete", false],
    ["viewer", "tag.read", true],
    ["viewer", "tag.create", false],
    ["viewer", "tag.update", false],
    ["viewer", "tag.delete", false],
    ["admin", "tag.delete", true],
  ] as const)("resolves %s %s against the workspace tag vocabulary", (role, action, expected) => {
    expect(policy.decide(evaluation(role, action), NOW).allowed).toBe(expected);
  });

  it("denies a tag action pointed at the wrong resource kind", () => {
    expect(
      policy.decide(evaluation("owner", "tag.update", resourceFor("note.read")), NOW),
    ).toMatchObject({
      allowed: false,
      audit: { reason: "action_resource_mismatch" },
    });
    expect(
      policy.decide(evaluation("owner", "tag.create", resourceFor("tag.update")), NOW),
    ).toMatchObject({
      allowed: false,
      audit: { reason: "action_resource_mismatch" },
    });
  });

  it("conceals a tag from another workspace as 404 rather than 403", () => {
    const foreign = Object.freeze({
      ...resourceFor("tag.update"),
      workspaceId: "other-workspace",
    });
    expect(policy.decide(evaluation("owner", "tag.update", foreign), NOW)).toMatchObject({
      allowed: false,
      httpStatus: 404,
    });
  });

  it.each([
    ["owner", "task.read", true],
    ["admin", "task.read", true],
    ["editor", "task.read", true],
    ["viewer", "task.read", true],
    ["editor", "task.create", true],
    ["editor", "task.update", true],
    ["editor", "task.tag", true],
    ["viewer", "task.create", false],
    ["viewer", "task.update", false],
    ["viewer", "task.tag", false],
    ["owner", "task.delete", true],
    ["admin", "task.delete", true],
    // Deleting a task hard-deletes its whole subtree, so editors fall through
    // to the trailing deny exactly like note.delete and tag.delete.
    ["editor", "task.delete", false],
    ["viewer", "task.delete", false],
  ] as const)("resolves %s %s against its canonical task resource", (role, action, expected) => {
    expect(policy.decide(evaluation(role, action), NOW).allowed).toBe(expected);
  });

  it("lets an editor reassign a task only to a currently active member", () => {
    const base = resourceFor("task.assign");
    const active = Object.freeze({ ...base, targetMemberActive: true });
    const revoked = Object.freeze({ ...base, targetMemberActive: false });
    expect(policy.decide(evaluation("editor", "task.assign", active), NOW).allowed).toBe(true);
    expect(policy.decide(evaluation("editor", "task.assign", revoked), NOW).allowed).toBe(false);
    // An unloaded target fact is not a permission.
    expect(policy.decide(evaluation("editor", "task.assign", base), NOW).allowed).toBe(false);
    expect(policy.decide(evaluation("admin", "task.assign", active), NOW).allowed).toBe(true);
  });

  it("keeps an editor's task edits to tasks they created inside editable projects", () => {
    const foreign = Object.freeze({ ...resourceFor("task.update"), creatorId: OTHER_USER_ID });
    const restricted = Object.freeze({
      ...resourceFor("task.update"),
      project: { restricted: true, actorAccess: null },
    });
    expect(policy.decide(evaluation("editor", "task.update", foreign), NOW).allowed).toBe(false);
    expect(policy.decide(evaluation("editor", "task.update", restricted), NOW).allowed).toBe(false);
    expect(policy.decide(evaluation("admin", "task.update", foreign), NOW).allowed).toBe(true);
  });

  it("ties exports to requester/admin and a currently readable source", () => {
    const sourceLost = Object.freeze({ ...resourceFor("export.download"), sourceReadable: false });
    const otherRequester = Object.freeze({
      ...resourceFor("export.download"),
      requestedById: OTHER_USER_ID,
    });
    expect(policy.decide(evaluation("editor", "export.download", sourceLost), NOW).allowed).toBe(
      false,
    );
    expect(
      policy.decide(evaluation("editor", "export.download", otherRequester), NOW).allowed,
    ).toBe(false);
    expect(policy.decide(evaluation("admin", "export.download", otherRequester), NOW).allowed).toBe(
      true,
    );
  });

  it("authorizes files only through their note and uploader/edit rules", () => {
    const readable = resourceFor("file.read");
    const restricted = Object.freeze({
      ...readable,
      note: noteFacts({ project: { restricted: true, actorAccess: null } }),
    });
    expect(policy.decide(evaluation("viewer", "file.read", readable), NOW).allowed).toBe(true);
    expect(policy.decide(evaluation("viewer", "file.read", restricted), NOW).allowed).toBe(false);
    expect(policy.decide(evaluation("editor", "file.delete", readable), NOW).allowed).toBe(true);
  });

  it("allows only the exact narrow system/job capability", () => {
    const resource = noteFacts();
    const system = {
      kind: "system" as const,
      authorityId: "export-worker-v1",
      workspaceId: WORKSPACE_ID,
      purpose: "render requested export",
      allowedActions: ["note.read"] as const,
      allowedResourceKinds: ["note"] as const,
    };
    const base = evaluation("viewer", "note.read", resource);
    expect(policy.decide({ ...base, actor: system }, NOW).allowed).toBe(true);
    expect(policy.decide({ ...base, actor: system, action: "note.update" }, NOW).allowed).toBe(
      false,
    );
  });

  it("enforces API-key scopes without treating authentication as user authorization", () => {
    const base = evaluation("viewer", "note.read", noteFacts());
    const readKey = {
      kind: "api-key" as const,
      apiKeyId: "key-1",
      workspaceId: WORKSPACE_ID,
      scopes: ["read"] as const,
    };
    expect(policy.decide({ ...base, actor: readKey }, NOW).allowed).toBe(true);
    expect(policy.decide({ ...base, actor: readKey, action: "note.update" }, NOW).allowed).toBe(
      false,
    );
  });

  it("never lets an API key reach an AI action, at any scope", () => {
    const base = evaluation("owner", "ai.use", resourceFor("ai.use"));
    for (const scopes of [["read"], ["write"], ["admin"], ["read", "write", "admin"]] as const) {
      const key = {
        kind: "api-key" as const,
        apiKeyId: "key-1",
        workspaceId: WORKSPACE_ID,
        scopes,
      };
      expect(policy.decide({ ...base, actor: key }, NOW).allowed).toBe(false);
      expect(policy.decide({ ...base, actor: key, action: "ai.configure" }, NOW).allowed).toBe(
        false,
      );
    }
  });

  it("requires a fresh session to write AI provider credentials", () => {
    const stale: UserAuthorizationActor = { ...actor, isFresh: false };
    expect(
      policy.decide(evaluation("owner", "ai.configure", resourceFor("ai.configure"), stale), NOW),
    ).toMatchObject({ allowed: false, code: "authorization.recent_authentication_required" });
    // Using AI is not credential material, so it does not demand re-auth.
    expect(
      policy.decide(evaluation("editor", "ai.use", resourceFor("ai.use"), stale), NOW).allowed,
    ).toBe(true);
  });

  /*
   * The load-bearing negative for the invite step-up.
   *
   * Freshness for `invite` is enforced in `MembershipsService.invite`, NOT by
   * adding `member.invite` to `HIGH_RISK_ACTIONS` — because that one action also
   * authorizes `listInvitations`, `resend`, `revoke`, the invitation-email
   * worker, and `ShellService`'s `canManageMembers` capability probe. Gating it
   * at the policy layer would evaluate freshness on all of them, so with
   * `AUTH_RECENT_AUTH_SECONDS` at 600 the members section would disappear from
   * the shell of every session more than ten minutes old.
   *
   * If someone later "simplifies" the service check into the policy set, this
   * is the test that says why not.
   */
  it("keeps member.invite out of the step-up set so the shell probe survives a stale session", () => {
    const stale: UserAuthorizationActor = { ...actor, isFresh: false };
    expect(
      policy.decide(evaluation("owner", "member.invite", resourceFor("member.invite"), stale), NOW)
        .allowed,
    ).toBe(true);
    // Its neighbours genuinely are step-up gated, and stay that way.
    for (const action of ["member.update", "member.remove"] as const) {
      expect(
        policy.decide(evaluation("owner", action, resourceFor(action), stale), NOW),
      ).toMatchObject({ allowed: false, code: "authorization.recent_authentication_required" });
    }
  });

  it("allows only owner/admin to read and export the audit trail", () => {
    expect(policy.decide(evaluation("owner", "audit.read"), NOW).allowed).toBe(true);
    expect(policy.decide(evaluation("owner", "audit.export"), NOW).allowed).toBe(true);
    expect(policy.decide(evaluation("admin", "audit.read"), NOW).allowed).toBe(true);
    expect(policy.decide(evaluation("admin", "audit.export"), NOW).allowed).toBe(true);
  });

  it("denies audit actions to editors and viewers despite matching the generic `.read` suffix rule", () => {
    // `audit.read` ends in `.read`, so without the explicit `action.startsWith("audit.")`
    // entry in the editor/viewer deny blocks, the generic `action.endsWith(".read")` rule
    // further down each method would allow it. This is the regression the deny
    // block exists to prevent — mirroring the same hazard already documented for `ai.`.
    expect(policy.decide(evaluation("editor", "audit.read"), NOW).allowed).toBe(false);
    expect(policy.decide(evaluation("editor", "audit.export"), NOW).allowed).toBe(false);
    expect(policy.decide(evaluation("viewer", "audit.read"), NOW).allowed).toBe(false);
    expect(policy.decide(evaluation("viewer", "audit.export"), NOW).allowed).toBe(false);
  });

  it("requires the admin API-key scope for audit.read, not merely a read scope", () => {
    const base = evaluation("owner", "audit.read");
    const adminKey = {
      kind: "api-key" as const,
      apiKeyId: "key-1",
      workspaceId: WORKSPACE_ID,
      scopes: ["admin"] as const,
    };
    const readKey = {
      kind: "api-key" as const,
      apiKeyId: "key-1",
      workspaceId: WORKSPACE_ID,
      scopes: ["read"] as const,
    };
    expect(policy.decide({ ...base, actor: adminKey }, NOW).allowed).toBe(true);
    expect(policy.decide({ ...base, actor: readKey }, NOW).allowed).toBe(false);
  });

  it("rechecks user-requested jobs without granting freshness", () => {
    const jobActor: UserAuthorizationActor = {
      ...actor,
      sessionId: null,
      source: "user-job",
      isFresh: false,
    };
    expect(
      policy.decide(evaluation("editor", "note.read", noteFacts(), jobActor), NOW).allowed,
    ).toBe(true);
    expect(
      policy.decide(
        evaluation("owner", "workspace.delete", resourceFor("workspace.delete"), jobActor),
        NOW,
      ),
    ).toMatchObject({
      allowed: false,
      code: "authorization.recent_authentication_required",
    });
  });

  it("denies missing, unknown, mismatched, invalid-parent, and stale facts by default", () => {
    expect(policy.decide(evaluation("owner", "unknown.action", null), NOW).allowed).toBe(false);
    expect(policy.decide(evaluation("owner", "note.read", null), NOW).allowed).toBe(false);
    expect(policy.decide(evaluation("owner", "note.read", noteFacts(), null), NOW)).toMatchObject({
      allowed: false,
      httpStatus: 401,
    });
    expect(
      policy.decide(
        evaluation("owner", "note.read", noteFacts({ workspaceId: "other-workspace" })),
        NOW,
      ),
    ).toMatchObject({ allowed: false, httpStatus: 404 });
    expect(
      policy.decide(evaluation("owner", "note.read", noteFacts({ relationsValid: false })), NOW),
    ).toMatchObject({ allowed: false, httpStatus: 404 });
    expect(
      policy.decide(
        evaluation(
          "owner",
          "note.read",
          noteFacts({ loadedAt: new Date(NOW - 31_000).toISOString() }),
        ),
        NOW,
      ),
    ).toMatchObject({ allowed: false, code: "authorization.stale_facts" });
  });
});
