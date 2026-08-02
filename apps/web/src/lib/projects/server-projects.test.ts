import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cookieStore } = vi.hoisted(() => ({
  cookieStore: { getAll: vi.fn(() => [{ name: "session", value: "safe" }]) },
}));
vi.mock("next/headers", () => ({ cookies: vi.fn(() => Promise.resolve(cookieStore)) }));

import { getServerProjectDetail, parseProjectSearchParams } from "@/lib/projects/server-projects";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const projectId = "30000000-0000-4000-8000-000000000002";

describe("server project reads", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("parses bounded URL filters, pagination, and sort with safe defaults", () => {
    expect(
      parseProjectSearchParams({
        page: "2",
        status: "completed",
        name: "Launch",
        sortBy: "name",
        sortDirection: "asc",
      }),
    ).toMatchObject({
      page: 2,
      limit: 12,
      status: "completed",
      name: "Launch",
      sortBy: "name",
      sortDirection: "asc",
    });
    expect(parseProjectSearchParams({ page: "10001", status: "forged" })).toMatchObject({
      page: 1,
      limit: 12,
      sortBy: "updatedAt",
      sortDirection: "desc",
    });
  });

  it.each([403, 404] as const)(
    "conceals denied and missing detail responses (%s)",
    async (status) => {
      fetchMock.mockResolvedValue(new Response(null, { status }));
      await expect(getServerProjectDetail(workspaceId, projectId)).resolves.toEqual({
        status: "not-found",
      });
    },
  );

  it("rejects malformed route IDs before a request and maps invalid output unavailable", async () => {
    await expect(getServerProjectDetail("bad", projectId)).resolves.toEqual({
      status: "not-found",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: projectId }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(getServerProjectDetail(workspaceId, projectId)).resolves.toEqual({
      status: "unavailable",
    });
  });
});
