import { describe, expect, it, vi } from "vitest";

import { TenantContextService } from "../tenant";

import { AuthorizationAdaptersService } from "./authorization-adapters.service";
import { AuthorizationEntryService } from "./authorization-entry.service";
import { AuthorizationPolicyService } from "./authorization-policy.service";
import { AuthorizationDeniedError } from "./authorization.errors";

import type { AuthorizationResourceFacts } from "./authorization.contracts";
import type { AuthorizationRepository } from "./authorization.repository";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

const WORKSPACE_ID = "30000000-0000-4000-8000-000000000001";
const USER_ID = "30000000-0000-4000-8000-000000000002";
const NOW = new Date().toISOString();

const principal: AuthenticatedPrincipal = Object.freeze({
  userId: USER_ID,
  sessionId: "session-1",
  method: "opaque-session",
  assurance: "single-factor",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  authenticatedAt: NOW,
  isFresh: true,
});

function noteFacts(): AuthorizationResourceFacts {
  return Object.freeze({
    kind: "note",
    id: "note-1",
    workspaceId: WORKSPACE_ID,
    loadedAt: new Date().toISOString(),
    relationsValid: true,
    creatorId: USER_ID,
    project: null,
    sharePermission: null,
  });
}

function harness() {
  const tenant = new TenantContextService();
  const findMembership = vi.fn<AuthorizationRepository["findMembership"]>();
  findMembership.mockResolvedValue({
    role: "editor",
    loadedAt: new Date().toISOString(),
  });
  const loadResource = vi.fn<AuthorizationRepository["loadResource"]>(async () => {
    expect(tenant.get()).toMatchObject({ workspaceId: WORKSPACE_ID, userId: USER_ID });
    return noteFacts();
  });
  const repository = {
    findMembership,
    loadResource,
  };
  const policy = new AuthorizationPolicyService();
  const decide = vi.spyOn(policy, "decide");
  const entry = new AuthorizationEntryService(
    repository as unknown as AuthorizationRepository,
    policy,
    tenant,
  );
  return { adapters: new AuthorizationAdaptersService(entry), repository, decide, tenant };
}

describe("AuthorizationAdaptersService contracts", () => {
  const transportCases = [
    "authorizeHttp",
    "authorizeRest",
    "authorizeTrpc",
    "authorizeSocketJoin",
    "authorizeSocketMessage",
    "authorizeFile",
  ] as const;

  it.each(transportCases)(
    "%s delegates once to the same policy under proven TenantContext",
    async (method) => {
      const { adapters, repository, decide, tenant } = harness();
      const operation = await adapters[method]({
        principal,
        workspaceId: WORKSPACE_ID,
        action: "note.read",
        resource: { kind: "note", id: "note-1" },
        correlationId: "request-1",
      });

      expect(operation.decision.allowed).toBe(true);
      expect(repository.findMembership).toHaveBeenCalledOnce();
      expect(repository.loadResource).toHaveBeenCalledOnce();
      expect(decide).toHaveBeenCalledOnce();
      expect(tenant.tryGet()).toBeNull();
    },
  );

  it("does not load a resource or establish reusable scope after membership revocation", async () => {
    const { adapters, repository, decide, tenant } = harness();
    repository.findMembership.mockResolvedValueOnce(null);

    await expect(
      adapters.authorizeHttp({
        principal,
        workspaceId: WORKSPACE_ID,
        action: "note.read",
        resource: { kind: "note", id: "guessed-note" },
      }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(repository.loadResource).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledOnce();
    expect(tenant.tryGet()).toBeNull();
  });

  it("rechecks membership and resource access for identifier-only user jobs", async () => {
    const { adapters, repository, decide } = harness();
    const operation = await adapters.authorizeUserJob({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      action: "note.read",
      resource: { kind: "note", id: "note-1" },
      correlationId: "job-1",
    });
    expect(operation.actor).toMatchObject({ source: "user-job", sessionId: null, isFresh: false });
    // The third argument is the optional transaction runner, which only the two
    // note callers that authorize inside an open transaction ever supply — a
    // job path passes nothing and the repository falls back to the pool.
    expect(repository.findMembership).toHaveBeenCalledWith(WORKSPACE_ID, USER_ID, undefined);
    expect(repository.loadResource).toHaveBeenCalledOnce();
    expect(decide).toHaveBeenCalledOnce();
  });

  it("bounds a system job to its explicit action/resource capability and tenant context", async () => {
    const { adapters, repository, decide, tenant } = harness();
    repository.loadResource.mockImplementationOnce(async () => {
      expect(tenant.get()).toMatchObject({ workspaceId: WORKSPACE_ID, userId: null });
      return noteFacts();
    });
    const operation = await adapters.authorizeSystemJob({
      actor: {
        kind: "system",
        authorityId: "export-worker-v1",
        workspaceId: WORKSPACE_ID,
        purpose: "render requested export",
        allowedActions: ["note.read"],
        allowedResourceKinds: ["note"],
      },
      action: "note.read",
      resource: { kind: "note", id: "note-1" },
    });
    expect(operation.decision.allowed).toBe(true);
    expect(repository.findMembership).not.toHaveBeenCalled();
    expect(repository.loadResource).toHaveBeenCalledOnce();
    expect(decide).toHaveBeenCalledOnce();
  });

  it("uses server-authenticated API-key identity without converting it to a user membership", async () => {
    const { adapters, repository, decide, tenant } = harness();
    repository.loadResource.mockImplementationOnce(async () => {
      expect(tenant.get()).toMatchObject({ workspaceId: WORKSPACE_ID, userId: null });
      return noteFacts();
    });
    const operation = await adapters.authorizeApiKey({
      actor: {
        kind: "api-key",
        apiKeyId: "key-1",
        workspaceId: WORKSPACE_ID,
        scopes: ["read"],
      },
      action: "note.read",
      resource: { kind: "note", id: "note-1" },
    });
    expect(operation.decision.allowed).toBe(true);
    expect(repository.findMembership).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledOnce();
  });

  it("keeps handler repository work inside the authorized tenant scope", async () => {
    const { adapters, tenant } = harness();
    const operation = await adapters.authorizeHttp({
      principal,
      workspaceId: WORKSPACE_ID,
      action: "note.read",
      resource: { kind: "note", id: "note-1" },
    });
    const result = adapters.run(operation, () => tenant.get());
    expect(result).toMatchObject({ workspaceId: WORKSPACE_ID, userId: USER_ID });
    expect(tenant.tryGet()).toBeNull();
  });

  it("delegates current-user session controls to the same policy without workspace authority", () => {
    const { adapters, repository, decide } = harness();
    const operation = adapters.authorizeCurrentUserSession({
      principal,
      action: "session.revoke",
      sessionId: "session-1",
      targetUserId: USER_ID,
    });
    expect(operation).toMatchObject({ workspaceId: null, decision: { allowed: true } });
    expect(repository.findMembership).not.toHaveBeenCalled();
    expect(repository.loadResource).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledOnce();
  });
});
