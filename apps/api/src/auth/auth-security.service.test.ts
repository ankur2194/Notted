import { describe, expect, it, vi } from "vitest";

import { AuthSecurityService } from "./auth-security.service";

import type { BetterAuthInstance } from "./better-auth.setup";
import type { DatabaseService } from "../database/database.service";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

const userId = "10000000-0000-4000-8000-000000000001";
const currentSessionId = "40000000-0000-4000-8000-000000000001";
const otherSessionId = "40000000-0000-4000-8000-000000000002";

const principal: AuthenticatedPrincipal = {
  userId,
  sessionId: currentSessionId,
  method: "opaque-session",
  assurance: "single-factor",
  authenticatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  isFresh: true,
};

/**
 * Drizzle's query builders are thenable at every step — `revokeOtherSessions`
 * awaits `.where(...)` directly while `overview` awaits `.orderBy(...)` and
 * `revokeSession` awaits `.limit(...)`. One thenable chain covers all three.
 */
function builder(rows: readonly unknown[]): unknown {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve: (value: readonly unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

function database(...resultsInCallOrder: readonly (readonly unknown[])[]): DatabaseService {
  let call = 0;
  const select = vi.fn(() => builder(resultsInCallOrder[call++] ?? []));
  return { db: { select } } as unknown as DatabaseService;
}

function authInstance(deleteSession = vi.fn()): {
  auth: BetterAuthInstance;
  deleteSession: ReturnType<typeof vi.fn>;
} {
  return {
    auth: {
      $context: Promise.resolve({ internalAdapter: { deleteSession } }),
    } as unknown as BetterAuthInstance,
    deleteSession,
  };
}

function sessionRow(id: string, userAgent: string | null) {
  return {
    id,
    userAgent,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-02T00:00:00.000Z"),
    expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    token: `token-${id}`,
  };
}

describe("AuthSecurityService", () => {
  /**
   * Every method fails closed when Better Auth is not wired: reporting an empty
   * session list, or silently succeeding at a revocation that never happened,
   * would both tell the user something untrue about their account security.
   */
  it.each([
    ["overview", (service: AuthSecurityService) => service.overview(principal)],
    [
      "revokeSession",
      (service: AuthSecurityService) => service.revokeSession(principal, otherSessionId),
    ],
    [
      "revokeOtherSessions",
      (service: AuthSecurityService) => service.revokeOtherSessions(principal),
    ],
  ])("reports %s as unavailable when auth is not configured", async (_name, invoke) => {
    await expect(invoke(new AuthSecurityService(database(), null))).rejects.toMatchObject({
      response: { code: "SERVICE_UNAVAILABLE" },
    });
  });

  it("marks the caller's own session and summarizes the rest", async () => {
    const service = new AuthSecurityService(
      database(
        [{ twoFactorEnabled: true }],
        [
          sessionRow(currentSessionId, "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0"),
          sessionRow(otherSessionId, "Mozilla/5.0 (iPhone) Safari/605.1"),
        ],
        [],
      ),
      authInstance().auth,
    );

    const overview = await service.overview(principal);

    expect(overview.twoFactorEnabled).toBe(true);
    expect(overview.sessions).toEqual([
      expect.objectContaining({ id: currentSessionId, current: true, device: "Chrome on Windows" }),
      expect.objectContaining({ id: otherSessionId, current: false, device: "Safari on iOS" }),
    ]);
  });

  /**
   * The device label is shown next to a "revoke" button, so it has to be
   * recognisable enough for someone to tell their own laptop from a session
   * they do not recognise. It is derived from an untrusted user-agent string
   * and never rendered raw.
   */
  it.each([
    ["Mozilla/5.0 (Windows NT 10.0) Edg/120.0", "Edge on Windows"],
    ["Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0", "Firefox on Linux"],
    ["Mozilla/5.0 (Linux; Android 14) Chrome/120.0", "Chrome on Android"],
    ["Mozilla/5.0 (iPad) Safari/605.1", "Safari on iOS"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/605.1", "Safari on macOS"],
    ["Some-Api-Client/2.0", "Browser on unknown OS"],
    ["", "Unknown device"],
    ["   ", "Unknown device"],
    [null, "Unknown device"],
  ])("summarizes the user agent %s as %s", async (userAgent, expected) => {
    const service = new AuthSecurityService(
      database([{ twoFactorEnabled: false }], [sessionRow(otherSessionId, userAgent)], []),
      authInstance().auth,
    );

    const overview = await service.overview(principal);

    expect(overview.sessions[0]?.device).toBe(expected);
  });

  it("falls back to a generic passkey label when the stored name is blank", async () => {
    const service = new AuthSecurityService(
      database(
        [{ twoFactorEnabled: false }],
        [],
        [
          {
            id: "p1",
            name: "  ",
            deviceType: "platform",
            backedUp: true,
            createdAt: new Date("2026-08-01T00:00:00.000Z"),
          },
          {
            id: "p2",
            name: "Work laptop",
            deviceType: "platform",
            backedUp: false,
            createdAt: new Date("2026-08-01T00:00:00.000Z"),
          },
        ],
      ),
      authInstance().auth,
    );

    const overview = await service.overview(principal);

    expect(overview.passkeys.map((entry) => entry.name)).toEqual(["Passkey", "Work laptop"]);
  });

  it("treats a principal with no matching user row as unauthenticated", async () => {
    const service = new AuthSecurityService(database([], [], []), authInstance().auth);

    await expect(service.overview(principal)).rejects.toMatchObject({
      response: { code: "UNAUTHENTICATED" },
    });
  });

  it("rejects a session identifier that is not a UUID", async () => {
    const { auth, deleteSession } = authInstance();
    const service = new AuthSecurityService(database(), auth);

    await expect(service.revokeSession(principal, "../admin")).rejects.toMatchObject({
      response: { code: "VALIDATION_ERROR" },
    });
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("refuses to revoke the caller's own session through the remote route", async () => {
    const { auth, deleteSession } = authInstance();
    const service = new AuthSecurityService(database(), auth);

    await expect(service.revokeSession(principal, currentSessionId)).rejects.toMatchObject({
      response: { code: "CURRENT_SESSION_NOT_REMOTE" },
    });
    expect(deleteSession).not.toHaveBeenCalled();
  });

  /**
   * The lookup is scoped to the caller's own user id, so another user's session
   * id simply matches nothing. Returning quietly is deliberate: a distinct
   * "no such session" error would confirm that the id exists.
   */
  it("does nothing when the session does not belong to the caller", async () => {
    const { auth, deleteSession } = authInstance();
    const service = new AuthSecurityService(database([]), auth);

    await expect(service.revokeSession(principal, otherSessionId)).resolves.toBeUndefined();
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("deletes the stored token for a session the caller owns", async () => {
    const { auth, deleteSession } = authInstance();
    const service = new AuthSecurityService(database([{ token: "token-remote" }]), auth);

    await service.revokeSession(principal, otherSessionId);

    expect(deleteSession).toHaveBeenCalledWith("token-remote");
  });

  it("revokes every other session while keeping the current one", async () => {
    const { auth, deleteSession } = authInstance();
    const service = new AuthSecurityService(
      database([
        { id: currentSessionId, token: "token-current" },
        { id: otherSessionId, token: "token-other" },
        { id: "40000000-0000-4000-8000-000000000003", token: "token-third" },
      ]),
      auth,
    );

    await service.revokeOtherSessions(principal);

    expect(deleteSession.mock.calls.map(([token]) => token)).toEqual([
      "token-other",
      "token-third",
    ]);
  });
});
