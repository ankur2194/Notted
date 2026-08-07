import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceDetail, WorkspaceStorageUsage } from "@notted/shared-types";

const { cookieStore } = vi.hoisted(() => ({
  cookieStore: { getAll: vi.fn<() => { name: string; value: string }[]>(() => []) },
}));
vi.mock("next/headers", () => ({ cookies: vi.fn(() => Promise.resolve(cookieStore)) }));

import {
  getServerWorkspaceDetail,
  getServerWorkspaceList,
  getServerWorkspaceStorageUsage,
} from "@/lib/workspaces/server-workspaces";

const workspaceId = "20000000-0000-4000-8000-000000000001";

const detail = {
  id: workspaceId,
  name: "Acme Design",
  slug: "acme-design",
  description: null,
  plan: "free",
  currentUserRole: "owner",
  logoUrl: null,
  domain: null,
  settings: { defaultPageSize: "letter" },
  storageLimitBytes: null,
  createdById: "10000000-0000-4000-8000-000000000001",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
} satisfies WorkspaceDetail;

const summary = {
  id: workspaceId,
  name: detail.name,
  slug: detail.slug,
  description: null,
  plan: "free",
  currentUserRole: "owner",
  logoUrl: null,
  updatedAt: detail.updatedAt,
};

const page = { items: [summary], page: 1, limit: 25, hasMore: false };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function search(mock: ReturnType<typeof vi.fn<typeof fetch>>): URLSearchParams {
  return new URL(String(mock.mock.calls[0]![0])).searchParams;
}

describe("server workspace reads", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    cookieStore.getAll.mockReset().mockReturnValue([{ name: "notted_session", value: "abc" }]);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("applies the shared list defaults when no query is supplied", async () => {
    fetchMock.mockResolvedValue(jsonResponse(page));

    await expect(getServerWorkspaceList()).resolves.toEqual({ status: "ready", data: page });

    const params = search(fetchMock);
    expect(Object.fromEntries(params.entries())).toEqual({
      page: "1",
      limit: "25",
      sortBy: "updatedAt",
      sortDirection: "desc",
    });
  });

  it("forwards only the optional filters that were provided", async () => {
    fetchMock.mockResolvedValue(jsonResponse(page));

    await getServerWorkspaceList({
      page: 2,
      limit: 10,
      name: "Acme",
      plan: "free",
      sortBy: "name",
      sortDirection: "asc",
    });

    expect(Object.fromEntries(search(fetchMock).entries())).toEqual({
      page: "2",
      limit: "10",
      name: "Acme",
      plan: "free",
      sortBy: "name",
      sortDirection: "asc",
    });
  });

  /**
   * The query is normalized through `workspaceListQuerySchema` before it is
   * forwarded, so an out-of-range page from a crafted URL cannot reach the API
   * as an unbounded offset scan.
   */
  it("drops an out-of-range query rather than forwarding it", async () => {
    fetchMock.mockResolvedValue(jsonResponse(page));

    await getServerWorkspaceList({ page: 10_001 });

    expect([...search(fetchMock).keys()]).toEqual([]);
  });

  it("forwards the caller's cookies and omits the header when there are none", async () => {
    fetchMock.mockResolvedValue(jsonResponse(page));
    await getServerWorkspaceList();
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("cookie")).toBe(
      "notted_session=abc",
    );

    fetchMock.mockClear();
    cookieStore.getAll.mockReturnValue([]);
    await getServerWorkspaceList();
    expect(fetchMock.mock.calls[0]![1]?.headers).toBeUndefined();
  });

  it.each([401, 403] as const)("maps %s on the user-scoped list to unauthenticated", async (s) => {
    fetchMock.mockResolvedValue(new Response(null, { status: s }));

    await expect(getServerWorkspaceList()).resolves.toEqual({ status: "unauthenticated" });
  });

  it("maps any other list failure to unavailable", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));

    await expect(getServerWorkspaceList()).resolves.toEqual({ status: "unavailable" });
  });

  it("refuses a list payload that does not match the contract", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], page: 1, limit: 25 }));

    await expect(getServerWorkspaceList()).resolves.toEqual({ status: "unavailable" });
  });

  it("reports a thrown list request as unavailable", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(getServerWorkspaceList()).resolves.toEqual({ status: "unavailable" });
  });

  it("rejects a malformed workspace id before issuing a detail request", async () => {
    await expect(getServerWorkspaceDetail("not-a-uuid")).resolves.toEqual({ status: "not-found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a validated workspace detail", async () => {
    fetchMock.mockResolvedValue(jsonResponse(detail));

    await expect(getServerWorkspaceDetail(workspaceId)).resolves.toEqual({
      status: "ready",
      data: detail,
    });
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe(
      `/api/v1/workspaces/${workspaceId}`,
    );
  });

  /**
   * Part 26 conceals unknown, cross-tenant, and revoked-membership workspaces
   * behind 404 and insufficient-role reads behind 403. Both must collapse to
   * the same client-visible outcome, otherwise the difference between the two
   * discloses that the workspace exists.
   */
  it.each([403, 404] as const)("conceals a %s detail response as not-found", async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));

    await expect(getServerWorkspaceDetail(workspaceId)).resolves.toEqual({ status: "not-found" });
  });

  it("maps 401 on a detail read to unauthenticated", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    await expect(getServerWorkspaceDetail(workspaceId)).resolves.toEqual({
      status: "unauthenticated",
    });
  });

  it("maps any other detail failure to unavailable", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    await expect(getServerWorkspaceDetail(workspaceId)).resolves.toEqual({ status: "unavailable" });
  });

  it("refuses a detail payload that does not match the contract", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: workspaceId }));

    await expect(getServerWorkspaceDetail(workspaceId)).resolves.toEqual({ status: "unavailable" });
  });

  it("reports a thrown detail request as unavailable", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));

    await expect(getServerWorkspaceDetail(workspaceId)).resolves.toEqual({ status: "unavailable" });
  });

  // Part 45. Storage usage degrades its own card rather than the page, so every
  // failure mode has to land on a distinct status the overview can render.
  describe("workspace storage usage", () => {
    const storageUsage = {
      workspaceId,
      plan: "free",
      usedBytes: 2_048,
      pendingBytes: 1_024,
      limitBytes: 1_073_741_824,
      availableBytes: 1_073_738_752,
      attachmentCount: 2,
      limitSource: "plan",
    } satisfies WorkspaceStorageUsage;

    it("returns the contract-validated aggregate on success", async () => {
      fetchMock.mockResolvedValue(jsonResponse(storageUsage));

      await expect(getServerWorkspaceStorageUsage(workspaceId)).resolves.toEqual({
        status: "ready",
        data: storageUsage,
      });
      expect(String(fetchMock.mock.calls[0]![0])).toContain(`/workspaces/${workspaceId}/storage`);
    });

    it.each([401, 403, 404])(
      "reports %i as forbidden so a lost membership reads as a permission fact",
      async (status) => {
        // 404 included deliberately: the API does not leak the existence of a
        // workspace the caller may not see, so "not found" here means "not yours".
        fetchMock.mockResolvedValue(new Response(null, { status }));

        await expect(getServerWorkspaceStorageUsage(workspaceId)).resolves.toEqual({
          status: "forbidden",
        });
      },
    );

    it("maps any other storage failure to unavailable", async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 500 }));

      await expect(getServerWorkspaceStorageUsage(workspaceId)).resolves.toEqual({
        status: "unavailable",
      });
    });

    it("refuses a storage payload that does not match the contract", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ workspaceId, usedBytes: -1 }));

      await expect(getServerWorkspaceStorageUsage(workspaceId)).resolves.toEqual({
        status: "unavailable",
      });
    });

    it("reports a thrown storage request as unavailable", async () => {
      fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));

      await expect(getServerWorkspaceStorageUsage(workspaceId)).resolves.toEqual({
        status: "unavailable",
      });
    });

    it("never issues a request for a malformed workspace id", async () => {
      await expect(getServerWorkspaceStorageUsage("not-a-uuid")).resolves.toEqual({
        status: "unavailable",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
