import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTag, deleteTag, requestTagPage, updateTag } from "./requests";

const workspaceId = "40000000-0000-4000-8000-000000000001";
const tagId = "40000000-0000-4000-8000-000000000002";

const tag = {
  id: tagId,
  workspaceId,
  name: "urgent",
  color: "#6b7280",
  noteCount: 3,
  taskCount: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("tag requests", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends every list selector and omits an absent name filter", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [tag], page: 1, limit: 25, hasMore: false }));
    await expect(
      requestTagPage(workspaceId, { page: 2, limit: 25, sortBy: "usage", sortDirection: "desc" }),
    ).resolves.toEqual({ ok: true, data: { items: [tag], page: 1, limit: 25, hasMore: false } });
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(`/api/v1/workspaces/${workspaceId}/tags`);
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("sortBy")).toBe("usage");
    expect(url.searchParams.get("sortDirection")).toBe("desc");
    expect(url.searchParams.has("name")).toBe(false);
  });

  it("passes a present name filter through", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], page: 1, limit: 25, hasMore: false }));
    await requestTagPage(workspaceId, {
      page: 1,
      limit: 25,
      name: "urg",
      sortBy: "name",
      sortDirection: "asc",
    });
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("name")).toBe("urg");
  });

  it("sends the caller's idempotency key on create", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tag }, 201));
    const created = await createTag(workspaceId, { name: "urgent" }, "stable-tag-submission");
    expect(created).toEqual({ ok: true, data: { tag } });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("stable-tag-submission");
  });

  it("fails closed on bad ids, bad input, and a weak idempotency key", async () => {
    await expect(
      requestTagPage("not-a-uuid", { page: 1, limit: 25, sortBy: "name", sortDirection: "asc" }),
    ).resolves.toEqual({ ok: false, kind: "invalid" });
    await expect(createTag(workspaceId, { name: "  " }, "stable-tag-submission")).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    await expect(createTag(workspaceId, { name: "urgent" }, "short")).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    await expect(updateTag(workspaceId, tagId, {})).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    await expect(updateTag(workspaceId, tagId, { color: "red" })).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports both detachment counts a delete removed", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        tagId,
        deleted: true,
        removedNoteAssignments: 12,
        removedTaskAssignments: 30,
      }),
    );
    await expect(deleteTag(workspaceId, tagId)).resolves.toEqual({
      ok: true,
      data: { tagId, deleted: true, removedNoteAssignments: 12, removedTaskAssignments: 30 },
    });
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("treats an off-contract response body as invalid rather than trusting it", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tag: { ...tag, noteCount: -1 } }, 201));
    const result = await createTag(workspaceId, { name: "urgent" }, "stable-tag-submission");
    expect(result).toEqual({ ok: false, kind: "invalid" });
  });
});
