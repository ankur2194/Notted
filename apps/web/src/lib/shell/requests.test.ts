import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadNotifications,
  markAllNotificationsRead,
  selectWorkspace,
  setNotificationRead,
} from "@/lib/shell/requests";

const workspaceId = "20000000-0000-4000-8000-000000000001";
const notificationId = "20000000-0000-4000-8000-000000000002";

const notification = {
  id: notificationId,
  workspaceId,
  kind: "workspace",
  actorId: null,
  targetType: null,
  targetId: null,
  summary: "Ada joined the workspace",
  targetLabel: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  readAt: null,
};

const page = { items: [notification], page: 1, limit: 20, hasMore: false, unreadCount: 1 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("shell requests", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("requests one bounded notification page and encodes the workspace selector", async () => {
    fetchMock.mockResolvedValue(jsonResponse(page));

    await expect(loadNotifications(workspaceId, 3)).resolves.toEqual({ ok: true, data: page });

    const [url, init] = fetchMock.mock.calls[0]!;
    const requested = new URL(String(url));
    expect(requested.pathname).toBe(`/api/v1/workspaces/${workspaceId}/notifications`);
    expect(requested.searchParams.get("page")).toBe("3");
    expect(requested.searchParams.get("limit")).toBe("20");
    expect(init?.credentials).toBe("include");
    expect(init?.cache).toBe("no-store");
  });

  it("defaults to the first page", async () => {
    fetchMock.mockResolvedValue(jsonResponse(page));

    await loadNotifications(workspaceId);

    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get("page")).toBe("1");
  });

  it.each([401, 403, 404] as const)("maps %s to a forbidden result", async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));

    await expect(loadNotifications(workspaceId)).resolves.toEqual({ ok: false, kind: "forbidden" });
  });

  it.each([429, 500, 503] as const)("maps %s to a network result", async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));

    await expect(loadNotifications(workspaceId)).resolves.toEqual({ ok: false, kind: "network" });
  });

  it("rejects a response body that does not match the notification contract", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], page: 1, limit: 20, hasMore: false }));

    await expect(loadNotifications(workspaceId)).resolves.toEqual({ ok: false, kind: "invalid" });
  });

  it("treats a thrown request — offline, aborted, timed out — as a network failure", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));

    await expect(loadNotifications(workspaceId)).resolves.toEqual({ ok: false, kind: "network" });
  });

  it("sends the read state as a bounded PATCH body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ notification, unreadCount: 0 }));

    await expect(setNotificationRead(workspaceId, notificationId, true)).resolves.toEqual({
      ok: true,
      data: { notification, unreadCount: 0 },
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe(
      `/api/v1/workspaces/${workspaceId}/notifications/${notificationId}`,
    );
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ isRead: true });
  });

  it("marks every notification read through the dedicated route", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ updatedCount: 4, unreadCount: 0 }));

    await expect(markAllNotificationsRead(workspaceId)).resolves.toEqual({
      ok: true,
      data: { updatedCount: 4, unreadCount: 0 },
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe(
      `/api/v1/workspaces/${workspaceId}/notifications/read-all`,
    );
    expect(init?.method).toBe("POST");
  });

  it("refuses a malformed workspace selector before issuing a request", async () => {
    await expect(selectWorkspace("not-a-uuid")).resolves.toEqual({ ok: false, kind: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * Workspace selection posts to the Next.js route handler, not the API, so it
   * is same-origin: the handler owns the httpOnly selection cookie. A
   * cross-origin `credentials: "include"` here would send API cookies to the
   * web origin for no reason.
   */
  it("posts a valid selection to the same-origin route handler", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(selectWorkspace(workspaceId)).resolves.toEqual({ ok: true, data: true });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/shell/workspace");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(JSON.parse(String(init?.body))).toEqual({ workspaceId });
  });

  it.each([
    [403, "forbidden"],
    [404, "forbidden"],
    [500, "network"],
  ] as const)("maps a %s selection response to %s", async (status, kind) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));

    await expect(selectWorkspace(workspaceId)).resolves.toEqual({ ok: false, kind });
  });

  it("treats a thrown selection request as a network failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(selectWorkspace(workspaceId)).resolves.toEqual({ ok: false, kind: "network" });
  });
});
