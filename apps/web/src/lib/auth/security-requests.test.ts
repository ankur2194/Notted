import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadPrincipal,
  loadSecurityOverview,
  revokeOtherSessions,
  revokeRemoteSession,
} from "@/lib/auth/security-requests";

const overview = { twoFactorEnabled: true, sessions: [], passkeys: [] };
const principal = { userId: "10000000-0000-4000-8000-000000000001", sessionId: "session-1" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("auth security requests", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("loads the security overview with credentials attached", async () => {
    fetchMock.mockResolvedValue(jsonResponse(overview));

    await expect(loadSecurityOverview()).resolves.toEqual(overview);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe("/api/v1/auth/security");
    expect(init?.credentials).toBe("include");
    expect(init?.cache).toBe("no-store");
  });

  it.each([401, 403, 500] as const)("returns null for a %s overview response", async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));

    await expect(loadSecurityOverview()).resolves.toBeNull();
  });

  it.each([
    ["a non-object body", "nope"],
    ["a null body", null],
    ["a non-boolean twoFactorEnabled", { ...overview, twoFactorEnabled: "yes" }],
    ["a sessions field that is not an array", { ...overview, sessions: {} }],
    ["a passkeys field that is not an array", { ...overview, passkeys: null }],
  ])("returns null for %s", async (_label, body) => {
    fetchMock.mockResolvedValue(jsonResponse(body));

    await expect(loadSecurityOverview()).resolves.toBeNull();
  });

  it("returns null when the overview request throws", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(loadSecurityOverview()).resolves.toBeNull();
  });

  it("loads the principal from the first-party session route", async () => {
    fetchMock.mockResolvedValue(jsonResponse(principal));

    await expect(loadPrincipal()).resolves.toEqual(principal);
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe("/api/v1/auth/session");
  });

  it("returns null for an unauthenticated principal request", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    await expect(loadPrincipal()).resolves.toBeNull();
  });

  it.each([
    ["a non-object body", 42],
    ["a null body", null],
    ["a missing userId", { sessionId: "session-1" }],
    ["a missing sessionId", { userId: principal.userId }],
    ["a non-string userId", { userId: 1, sessionId: "session-1" }],
  ])("returns null for %s", async (_label, body) => {
    fetchMock.mockResolvedValue(jsonResponse(body));

    await expect(loadPrincipal()).resolves.toBeNull();
  });

  it("returns null when the principal request throws", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(loadPrincipal()).resolves.toBeNull();
  });

  it("revokes one remote session by encoded id", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(revokeRemoteSession("session/../admin")).resolves.toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe("/api/v1/auth/sessions/session%2F..%2Fadmin");
    expect(init?.method).toBe("DELETE");
    expect(init?.credentials).toBe("include");
  });

  /**
   * Revoking sessions is a sensitive mutation, so the API answers 403 when the
   * caller's authentication is no longer recent. That is the one failure the UI
   * must distinguish: it re-prompts for a password instead of showing a generic
   * error the user cannot act on.
   */
  it("reports a 403 as requiring recent authentication", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));

    await expect(revokeRemoteSession("session-1")).resolves.toEqual({
      ok: false,
      recentAuthenticationRequired: true,
    });
  });

  it.each([401, 404, 500] as const)("reports %s as a plain failure", async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));

    await expect(revokeRemoteSession("session-1")).resolves.toEqual({
      ok: false,
      recentAuthenticationRequired: false,
    });
  });

  it("does not claim recent authentication is required when the request throws", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(revokeRemoteSession("session-1")).resolves.toEqual({
      ok: false,
      recentAuthenticationRequired: false,
    });
  });

  it("posts to the dedicated revoke-others route", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await expect(revokeOtherSessions()).resolves.toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe("/api/v1/auth/sessions/revoke-others");
    expect(init?.method).toBe("POST");
  });

  it("reports a 403 on revoke-others as requiring recent authentication", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));

    await expect(revokeOtherSessions()).resolves.toEqual({
      ok: false,
      recentAuthenticationRequired: true,
    });
  });
});
