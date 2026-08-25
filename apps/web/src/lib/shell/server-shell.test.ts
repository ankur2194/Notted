import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShellBootstrap } from "@notted/shared-types";

const { cookieStore } = vi.hoisted(() => ({
  cookieStore: {
    getAll: vi.fn<() => { name: string; value: string }[]>(() => []),
    get: vi.fn<(name: string) => { name: string; value: string } | undefined>(() => undefined),
  },
}));
vi.mock("next/headers", () => ({ cookies: vi.fn(() => Promise.resolve(cookieStore)) }));

import { getServerShell, WORKSPACE_SELECTION_COOKIE } from "@/lib/shell/server-shell";

const workspaceId = "20000000-0000-4000-8000-000000000001";
const otherWorkspaceId = "20000000-0000-4000-8000-000000000002";

const bootstrap: ShellBootstrap = {
  user: {
    id: "10000000-0000-4000-8000-000000000001",
    name: "Ada Editor",
    email: "ada@example.test",
  },
  workspaces: [
    { workspaceId, name: "Alpha", slug: "alpha", role: "editor", logoUrl: null, accentColor: null },
  ],
  currentWorkspace: {
    workspaceId,
    name: "Alpha",
    slug: "alpha",
    role: "editor",
    logoUrl: null,
    accentColor: null,
  },
  permissions: {
    canViewSettings: true,
    canManageWorkspace: false,
    canManageMembers: false,
    canCreateContent: true,
  },
  notificationUnreadCount: 0,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestedWorkspaceIds(mock: ReturnType<typeof vi.fn<typeof fetch>>): (string | null)[] {
  return mock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("workspaceId"));
}

describe("server shell bootstrap", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    cookieStore.getAll.mockReset().mockReturnValue([]);
    cookieStore.get.mockReset().mockReturnValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("forwards every request cookie so the API can prove the session", async () => {
    cookieStore.getAll.mockReturnValue([
      { name: "notted_session", value: "abc" },
      { name: "other", value: "def" },
    ]);
    fetchMock.mockResolvedValue(jsonResponse(bootstrap));

    await expect(getServerShell()).resolves.toEqual({ status: "ready", data: bootstrap });

    const headers = new Headers(fetchMock.mock.calls[0]![1]?.headers);
    expect(headers.get("cookie")).toBe("notted_session=abc; other=def");
  });

  it("omits the cookie header entirely when the browser sent none", async () => {
    fetchMock.mockResolvedValue(jsonResponse(bootstrap));

    await getServerShell();

    expect(fetchMock.mock.calls[0]![1]?.headers).toBeUndefined();
  });

  it("requests the selected workspace when the selection cookie holds a valid UUID", async () => {
    cookieStore.get.mockImplementation((name) =>
      name === WORKSPACE_SELECTION_COOKIE ? { name, value: workspaceId } : undefined,
    );
    fetchMock.mockResolvedValue(jsonResponse(bootstrap));

    await getServerShell();

    expect(requestedWorkspaceIds(fetchMock)).toEqual([workspaceId]);
  });

  it("ignores a malformed selection cookie instead of forwarding it", async () => {
    cookieStore.get.mockImplementation((name) =>
      name === WORKSPACE_SELECTION_COOKIE ? { name, value: "not-a-uuid" } : undefined,
    );
    fetchMock.mockResolvedValue(jsonResponse(bootstrap));

    await getServerShell();

    expect(requestedWorkspaceIds(fetchMock)).toEqual([null]);
  });

  /**
   * A selection cookie outlives the membership it points at. When the API says
   * the selected workspace is gone — revoked membership, deleted workspace, or
   * a cookie copied from another tenant — the retry drops the selector entirely
   * so the server picks the user's own first membership. Retaining the stale
   * selection would strand the user on an error page they cannot escape.
   */
  it("retries without the selector when the selected workspace is no longer visible", async () => {
    cookieStore.get.mockImplementation((name) =>
      name === WORKSPACE_SELECTION_COOKIE ? { name, value: otherWorkspaceId } : undefined,
    );
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse(bootstrap));

    await expect(getServerShell()).resolves.toEqual({ status: "ready", data: bootstrap });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestedWorkspaceIds(fetchMock)).toEqual([otherWorkspaceId, null]);
  });

  it("does not retry a 404 when no workspace was selected", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    await expect(getServerShell()).resolves.toEqual({ status: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403] as const)("reports %s as unauthenticated", async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));

    await expect(getServerShell()).resolves.toEqual({ status: "unauthenticated" });
  });

  it("reports a still-denied retry as unauthenticated", async () => {
    cookieStore.get.mockImplementation((name) =>
      name === WORKSPACE_SELECTION_COOKIE ? { name, value: workspaceId } : undefined,
    );
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    await expect(getServerShell()).resolves.toEqual({ status: "unauthenticated" });
  });

  it("reports a server error as unavailable", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));

    await expect(getServerShell()).resolves.toEqual({ status: "unavailable" });
  });

  it("refuses a bootstrap payload that does not match the contract", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...bootstrap, notificationUnreadCount: -1 }));

    await expect(getServerShell()).resolves.toEqual({ status: "unavailable" });
  });

  it("reports a thrown request as unavailable rather than crashing the render", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));

    await expect(getServerShell()).resolves.toEqual({ status: "unavailable" });
  });
});
