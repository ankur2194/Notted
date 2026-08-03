import { describe, expect, it, vi } from "vitest";

import { AuthorizationPolicyService } from "../authorization/authorization-policy.service";

import { setAuthPrincipal } from "./auth-principal";
import { AuthController } from "./auth.controller";

import type { AuthSecurityService } from "./auth-security.service";
import type { AuthService } from "./auth.service";
import type { AuthenticatedPrincipal } from "@notted/shared-types";
import type { Request } from "express";

const userId = "10000000-0000-4000-8000-000000000001";
const sessionId = "40000000-0000-4000-8000-000000000001";
const otherSessionId = "40000000-0000-4000-8000-000000000002";

function principal(overrides: Partial<AuthenticatedPrincipal> = {}): AuthenticatedPrincipal {
  return {
    userId,
    sessionId,
    method: "opaque-session",
    assurance: "single-factor",
    authenticatedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isFresh: true,
    ...overrides,
  };
}

function request(value?: AuthenticatedPrincipal): Request {
  const target = {} as Request;
  if (value !== undefined) setAuthPrincipal(target, value);
  return target;
}

function controller(
  auth: Partial<AuthService> = {},
  security: Partial<AuthSecurityService> = {},
): AuthController {
  return new AuthController(
    {
      assertTrustedMutationOrigin: vi.fn(),
      requireRecentAuthentication: vi.fn(),
      ...auth,
    } as unknown as AuthService,
    security as AuthSecurityService,
    new AuthorizationPolicyService(),
  );
}

describe("AuthController", () => {
  it("returns capabilities without requiring a principal", () => {
    const capabilities = vi.fn().mockReturnValue({ passkeyEnabled: true });

    expect(controller({ capabilities } as unknown as Partial<AuthService>).capabilities()).toEqual({
      passkeyEnabled: true,
    });
  });

  it("returns the principal the guard attached", () => {
    const attached = principal();

    expect(controller().session(request(attached))).toEqual(attached);
  });

  /**
   * The routes below are all `@UseGuards(AuthGuard)`, so a missing principal
   * means the guard was removed or silently failed. That is a wiring bug, not a
   * client error: it must surface as a 500 rather than be treated as anonymous
   * access to a session-management endpoint.
   */
  it.each([
    ["session", (target: AuthController, value: Request) => target.session(value)],
    [
      "securityOverview",
      (target: AuthController, value: Request) => target.securityOverview(value),
    ],
  ])("fails closed on %s when the guard attached no principal", (_name, invoke) => {
    expect(() => invoke(controller(), request())).toThrow("Auth guard did not attach a principal");
  });

  it.each([
    [
      "revokeOtherSessions",
      (target: AuthController, value: Request) => target.revokeOtherSessions(value),
    ],
    [
      "revokeSession",
      (target: AuthController, value: Request) => target.revokeSession(value, sessionId),
    ],
  ])("fails closed on %s when the guard attached no principal", async (_name, invoke) => {
    await expect(invoke(controller(), request())).rejects.toThrow(
      "Auth guard did not attach a principal",
    );
  });

  it("loads the security overview for the authenticated user's own session", async () => {
    const overview = vi.fn().mockResolvedValue({ twoFactorEnabled: false });
    const attached = principal();

    await expect(controller({}, { overview }).securityOverview(request(attached))).resolves.toEqual(
      {
        twoFactorEnabled: false,
      },
    );
    expect(overview).toHaveBeenCalledWith(attached);
  });

  it("checks mutation origin and recent authentication before revoking other sessions", async () => {
    const assertTrustedMutationOrigin = vi.fn();
    const requireRecentAuthentication = vi.fn();
    const revokeOtherSessions = vi.fn().mockResolvedValue(undefined);
    const attached = principal();

    await expect(
      controller(
        { assertTrustedMutationOrigin, requireRecentAuthentication },
        { revokeOtherSessions },
      ).revokeOtherSessions(request(attached)),
    ).resolves.toEqual({ status: true });

    expect(assertTrustedMutationOrigin).toHaveBeenCalledOnce();
    expect(requireRecentAuthentication).toHaveBeenCalledWith(attached);
    expect(revokeOtherSessions).toHaveBeenCalledWith(attached);
  });

  it("revokes a named session for the authenticated user", async () => {
    const revokeSession = vi.fn().mockResolvedValue(undefined);
    const attached = principal();

    await expect(
      controller({}, { revokeSession }).revokeSession(request(attached), otherSessionId),
    ).resolves.toEqual({ status: true });
    expect(revokeSession).toHaveBeenCalledWith(attached, otherSessionId);
  });

  /**
   * Authorization runs before the service is reached, so a denial must not
   * revoke anything. The decision's code determines the error code the client
   * sees, which is what lets the UI re-prompt for a password instead of showing
   * a dead-end forbidden state.
   */
  it("maps a stale-authentication denial to RECENT_AUTHENTICATION_REQUIRED without revoking", async () => {
    const revokeSession = vi.fn();
    const attached = principal({
      isFresh: false,
      authenticatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    });

    await expect(
      controller({}, { revokeSession }).revokeSession(request(attached), otherSessionId),
    ).rejects.toMatchObject({ response: { code: "RECENT_AUTHENTICATION_REQUIRED" } });
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it("maps an expired-session denial to UNAUTHENTICATED without revoking", async () => {
    const revokeSession = vi.fn();
    const attached = principal({ expiresAt: new Date(Date.now() - 1_000).toISOString() });

    await expect(
      controller({}, { revokeSession }).revokeSession(request(attached), otherSessionId),
    ).rejects.toMatchObject({ response: { code: "UNAUTHENTICATED" } });
    expect(revokeSession).not.toHaveBeenCalled();
  });
});
