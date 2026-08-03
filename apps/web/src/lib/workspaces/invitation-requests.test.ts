import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acceptWorkspaceInvitation } from "@/lib/workspaces/invitation-requests";

const workspaceId = "20000000-0000-4000-8000-000000000001";
const token = "a".repeat(43);

const accepted = {
  membership: {
    id: "20000000-0000-4000-8000-000000000002",
    workspaceId,
    userId: "10000000-0000-4000-8000-000000000001",
    name: "Ada Editor",
    email: "ada@example.test",
    role: "editor",
    joinedAt: "2026-08-01T00:00:00.000Z",
  },
  joined: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("workspace invitation acceptance", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("posts a well-formed token to the acceptance route", async () => {
    fetchMock.mockResolvedValue(jsonResponse(accepted));

    await expect(acceptWorkspaceInvitation(token)).resolves.toEqual({ ok: true, data: accepted });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe("/api/v1/invitations/accept");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
    expect(JSON.parse(String(init?.body))).toEqual({ token });
  });

  it.each([
    ["an empty token", ""],
    ["a short token", "abc"],
  ])("refuses %s before issuing a request", async (_label, value) => {
    await expect(acceptWorkspaceInvitation(value)).resolves.toEqual({ ok: false, kind: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * A single-use invitation is expired, revoked, or already accepted far more
   * often than it is simply broken. Those answers arrive as 400 and 409 and are
   * the user's to resolve — asking for a fresh invitation — so they must not be
   * folded into the retryable "unavailable" state.
   */
  it.each([400, 409] as const)("reports %s as an invalid invitation", async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));

    await expect(acceptWorkspaceInvitation(token)).resolves.toEqual({ ok: false, kind: "invalid" });
  });

  it.each([401, 403, 404, 500] as const)("reports %s as unavailable", async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));

    await expect(acceptWorkspaceInvitation(token)).resolves.toEqual({
      ok: false,
      kind: "unavailable",
    });
  });

  it("refuses an acceptance payload that does not match the contract", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ workspaceId }));

    await expect(acceptWorkspaceInvitation(token)).resolves.toEqual({
      ok: false,
      kind: "unavailable",
    });
  });

  it("reports a thrown request as unavailable", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));

    await expect(acceptWorkspaceInvitation(token)).resolves.toEqual({
      ok: false,
      kind: "unavailable",
    });
  });
});
