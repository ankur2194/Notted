import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { auditLogExportUrl, listAuditLogs } from "./requests";

const workspaceId = "50000000-0000-4000-8000-000000000001";
const actorId = "50000000-0000-4000-8000-000000000002";

const entry = {
  id: "50000000-0000-4000-8000-000000000003",
  workspaceId,
  userId: actorId,
  userName: "Ada Lovelace",
  action: "apiKey.created",
  entityType: "apiKey",
  entityId: "50000000-0000-4000-8000-000000000004",
  metadata: { name: "CI deploy" },
  ipAddress: "203.0.113.7",
  userAgent: "Mozilla/5.0",
  requestId: "50000000-0000-4000-8000-000000000005",
  createdAt: "2026-08-01T00:00:00.000Z",
};

const baseQuery = { page: 1, limit: 25 } as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("audit log requests", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends page and limit and parses the page", async () => {
    const body = { items: [entry], page: 1, limit: 25, hasMore: false };
    fetchMock.mockResolvedValue(jsonResponse(body));

    await expect(listAuditLogs(workspaceId, baseQuery)).resolves.toEqual({ ok: true, data: body });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(`/api/v1/workspaces/${workspaceId}/audit-logs`);
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("limit")).toBe("25");
  });

  it("sends only the filters that are set", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], page: 1, limit: 25, hasMore: false }));

    await listAuditLogs(workspaceId, { ...baseQuery, action: "apiKey.created", userId: actorId });

    const params = new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams;
    expect(params.get("action")).toBe("apiKey.created");
    expect(params.get("userId")).toBe(actorId);
    expect(params.has("entityType")).toBe(false);
    expect(params.has("entityId")).toBe(false);
    expect(params.has("from")).toBe(false);
    expect(params.has("to")).toBe(false);
  });

  it("fails closed on a bad workspace id or an invalid filter, without fetching", async () => {
    await expect(listAuditLogs("not-a-uuid", baseQuery)).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    await expect(
      listAuditLogs(workspaceId, { ...baseQuery, entityId: "not-a-uuid" }),
    ).resolves.toEqual({ ok: false, kind: "invalid" });
    await expect(
      listAuditLogs(workspaceId, {
        ...baseQuery,
        from: "2026-08-10T00:00:00.000Z",
        to: "2026-08-01T00:00:00.000Z",
      }),
    ).resolves.toEqual({ ok: false, kind: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an off-contract response body as invalid rather than trusting it", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ items: [{ ...entry, action: "" }], page: 1, limit: 25, hasMore: false }),
    );

    await expect(listAuditLogs(workspaceId, baseQuery)).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
  });

  it("maps a 403 onto forbidden-or-not-found", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: "FORBIDDEN" } }, 403));

    await expect(listAuditLogs(workspaceId, baseQuery)).resolves.toEqual({
      ok: false,
      kind: "forbidden-or-not-found",
    });
  });

  it("builds an absolute export url carrying the workspace id and filters", () => {
    const url = auditLogExportUrl(workspaceId, { action: "apiKey.created", userId: actorId });

    expect(url).toMatch(/^https?:\/\//u);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(`/api/v1/workspaces/${workspaceId}/audit-logs/export`);
    expect(parsed.searchParams.get("action")).toBe("apiKey.created");
    expect(parsed.searchParams.get("userId")).toBe(actorId);
  });

  it("omits filters from the export url when they are absent", () => {
    const url = new URL(auditLogExportUrl(workspaceId, {}));

    expect(url.searchParams.toString()).toBe("");
  });
});
