import { firstValueFrom, of } from "rxjs";
import { describe, expect, it, vi } from "vitest";

import { setApiKeyActor } from "../api-keys/api-key-context";
import { ApiHttpException } from "../common/errors/api-http.exception";

import { getAuthorizedOperation, setAuthorizedOperation } from "./authorization-http.context";
import { AuthorizationHttpGuard } from "./authorization-http.guard";
import { AuthorizationHttpInterceptor } from "./authorization-http.interceptor";

import type { AuthorizationAdaptersService } from "./authorization-adapters.service";
import type { HttpAuthorizationSpec } from "./authorization-http.decorator";
import type { AuthorizedOperation } from "./authorization.contracts";
import type { AuthService } from "../auth/auth.service";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import type { AuthenticatedPrincipal } from "@notted/shared-types";
import type { Request } from "express";

const principal: AuthenticatedPrincipal = {
  userId: "40000000-0000-4000-8000-000000000001",
  sessionId: "session-1",
  method: "opaque-session",
  assurance: "single-factor",
  authenticatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  isFresh: true,
};

const operation = {
  actor: {
    kind: "user",
    userId: principal.userId,
    sessionId: principal.sessionId,
    assurance: principal.assurance,
    authenticatedAt: principal.authenticatedAt,
    expiresAt: principal.expiresAt,
    isFresh: true,
    source: "session",
  },
  action: "note.read",
  resource: {
    kind: "note",
    id: "note-1",
    workspaceId: "workspace-1",
    loadedAt: new Date().toISOString(),
    relationsValid: true,
  },
  workspaceId: "workspace-1",
  userId: principal.userId,
  decision: {
    allowed: true,
    audit: {
      action: "note.read",
      actorKind: "user",
      resourceKind: "note",
      outcome: "allow",
      reason: "test",
    },
  },
  membershipRole: "editor",
} as const satisfies AuthorizedOperation;

function executionContext(request: Request): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T = Request>() => request as unknown as T,
      getResponse: <T = unknown>() => ({}) as T,
      getNext: <T = unknown>() => ({}) as T,
    }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToRpc: () => ({ getData: () => undefined, getContext: () => undefined }),
    switchToWs: () => ({
      getClient: () => undefined,
      getData: () => undefined,
      getPattern: () => undefined,
    }),
    getType: () => "http",
  } as unknown as ExecutionContext;
}

describe("Nest authorization adapter", () => {
  it("guard delegates authenticated selectors to authorizeHttp and stores only its operation", async () => {
    const request = {
      params: { workspaceId: "workspace-1", noteId: "note-1" },
    } as unknown as Request;
    const spec: HttpAuthorizationSpec = {
      action: "note.read",
      workspaceId: (value) => value.params.workspaceId,
      resource: (value) => ({ kind: "note", id: value.params.noteId as string }),
    };
    const reflector = {
      getAllAndOverride: vi.fn(() => spec),
    } as unknown as Reflector;
    const auth = { authenticate: vi.fn(async () => principal) } as unknown as AuthService;
    const authorizeHttp = vi.fn(async () => operation);
    const adapters = { authorizeHttp } as unknown as AuthorizationAdaptersService;
    const guard = new AuthorizationHttpGuard(reflector, auth, adapters);

    await expect(guard.canActivate(executionContext(request))).resolves.toBe(true);
    expect(authorizeHttp).toHaveBeenCalledOnce();
    expect(authorizeHttp).toHaveBeenCalledWith(
      expect.objectContaining({
        principal,
        workspaceId: "workspace-1",
        action: "note.read",
        resource: { kind: "note", id: "note-1" },
      }),
    );
    expect(getAuthorizedOperation(request)).toBe(operation);
  });

  /**
   * Part 65. An API-key request carries a synthetic principal for the key's
   * creator AND an API-key actor. The synthetic principal keeps the 401 branch
   * unchanged, but the DECISION must come from `authorizeApiKey` so the key's
   * scopes are enforced — routing it through `authorizeHttp` would silently
   * grant a read-only key the creator's full workspace role.
   */
  it("guard decides an api-key request with authorizeApiKey, never authorizeHttp", async () => {
    const request = {
      params: { workspaceId: "workspace-1", noteId: "note-1" },
    } as unknown as Request;
    setApiKeyActor(request, {
      kind: "api-key",
      apiKeyId: "key-1",
      workspaceId: "workspace-1",
      scopes: ["read"],
    });
    const spec: HttpAuthorizationSpec = {
      action: "note.read",
      workspaceId: (value) => value.params.workspaceId,
      resource: (value) => ({ kind: "note", id: value.params.noteId as string }),
    };
    const reflector = { getAllAndOverride: vi.fn(() => spec) } as unknown as Reflector;
    // The pre-guard already installed the synthetic principal, so the guard's
    // own authenticate() call memo-returns it and the 401 branch is untouched.
    const auth = { authenticate: vi.fn(async () => principal) } as unknown as AuthService;
    const authorizeHttp = vi.fn(async () => operation);
    const authorizeApiKey = vi.fn(async () => operation);
    const adapters = { authorizeHttp, authorizeApiKey } as unknown as AuthorizationAdaptersService;
    const guard = new AuthorizationHttpGuard(reflector, auth, adapters);

    await expect(guard.canActivate(executionContext(request))).resolves.toBe(true);
    expect(authorizeHttp).not.toHaveBeenCalled();
    expect(authorizeApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ kind: "api-key", apiKeyId: "key-1", scopes: ["read"] }),
        action: "note.read",
        resource: { kind: "note", id: "note-1" },
      }),
    );
    expect(getAuthorizedOperation(request)).toBe(operation);
  });

  /**
   * Part 65 regression. `authorizeApiKey` derives its tenant context from the
   * ACTOR alone and never sees the route's workspace, so without an explicit
   * binding check a key issued for workspace A is authorized against A while
   * the controller then operates on workspace B. Any creator who belongs to
   * both workspaces would carry the key across the tenant boundary. The seeded
   * tenants have disjoint membership, so only this test covers the leak.
   */
  it("guard refuses an api-key request whose route workspace is not the key's workspace", async () => {
    const request = {
      params: { workspaceId: "workspace-2", noteId: "note-1" },
    } as unknown as Request;
    setApiKeyActor(request, {
      kind: "api-key",
      apiKeyId: "key-1",
      workspaceId: "workspace-1",
      scopes: ["read", "write"],
    });
    const spec: HttpAuthorizationSpec = {
      action: "note.read",
      workspaceId: (value) => value.params.workspaceId,
      resource: (value) => ({ kind: "note", id: value.params.noteId as string }),
    };
    const reflector = { getAllAndOverride: vi.fn(() => spec) } as unknown as Reflector;
    const auth = { authenticate: vi.fn(async () => principal) } as unknown as AuthService;
    const authorizeHttp = vi.fn(async () => operation);
    const authorizeApiKey = vi.fn(async () => operation);
    const adapters = { authorizeHttp, authorizeApiKey } as unknown as AuthorizationAdaptersService;
    const guard = new AuthorizationHttpGuard(reflector, auth, adapters);

    const error = await guard
      .canActivate(executionContext(request))
      .catch((cause: unknown) => cause);
    // 404, never 403: a foreign workspace id must leak no existence signal.
    expect((error as ApiHttpException).getStatus()).toBe(404);
    expect(authorizeApiKey).not.toHaveBeenCalled();
    expect(authorizeHttp).not.toHaveBeenCalled();
    expect(getAuthorizedOperation(request)).toBeUndefined();
  });

  it("interceptor cannot execute a handler without the guard's authorized operation", () => {
    const request = {} as Request;
    const adapters = { run: vi.fn() } as unknown as AuthorizationAdaptersService;
    const interceptor = new AuthorizationHttpInterceptor(adapters);
    expect(() =>
      interceptor.intercept(executionContext(request), { handle: () => of(true) }),
    ).toThrow();
  });

  it("interceptor delegates handler execution to the bounded context runner", async () => {
    const request = {} as Request;
    setAuthorizedOperation(request, operation);
    const run = vi.fn((_operation: AuthorizedOperation, work: () => unknown) => work());
    const adapters = { run } as unknown as AuthorizationAdaptersService;
    const interceptor = new AuthorizationHttpInterceptor(adapters);
    const handler: CallHandler = { handle: () => of("handled") };
    await expect(
      firstValueFrom(interceptor.intercept(executionContext(request), handler)),
    ).resolves.toBe("handled");
    expect(run).toHaveBeenCalledWith(operation, expect.any(Function));
  });
});
