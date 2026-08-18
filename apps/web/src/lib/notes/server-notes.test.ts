import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cookieStore } = vi.hoisted(() => ({
  cookieStore: { getAll: vi.fn<() => { name: string; value: string }[]>(() => []) },
}));
vi.mock("next/headers", () => ({ cookies: vi.fn(() => Promise.resolve(cookieStore)) }));

import {
  getServerFolders,
  getServerNoteDetail,
  getServerNoteList,
  getServerNoteNavigation,
  getServerWorkspaceMembers,
  parseNoteSearchParams,
} from "./server-notes";

describe("server note query parsing", () => {
  it("validates route search values and keeps project selectors server-owned", () => {
    const projectId = "30000000-0000-4000-8000-000000000001";
    expect(
      parseNoteSearchParams({ page: "2", type: "task-list" }, { view: "recent", projectId }),
    ).toMatchObject({ page: 2, scope: "project", projectId, view: "recent", type: "task-list" });
    expect(
      parseNoteSearchParams({ page: "not-a-page", projectId: "forged", isArchived: "yes" }),
    ).toMatchObject({ page: 1, scope: "workspace-root", view: "normal" });
    expect(parseNoteSearchParams({}, { view: "trash" })).toMatchObject({
      sortBy: "deletedAt",
      sortDirection: "desc",
    });
    expect(parseNoteSearchParams({}, { view: "pinned" })).toMatchObject({
      sortBy: "updatedAt",
      sortDirection: "desc",
    });
    expect(parseNoteSearchParams({ isArchived: "true" })).toMatchObject({
      sortBy: "updatedAt",
      sortDirection: "desc",
    });
  });
});

const workspaceId = "20000000-0000-4000-8000-000000000001";
const projectId = "30000000-0000-4000-8000-000000000001";
const noteId = "30000000-0000-4000-8000-000000000002";

const noteSummary = {
  id: noteId,
  workspaceId,
  location: "workspace-root",
  projectId: null,
  folderId: null,
  parentId: null,
  boardColumnId: null,
  title: "Quarterly plan",
  type: "document",
  pageSize: "a4",
  sortOrder: 1,
  isTemplate: false,
  isPinned: false,
  isArchived: false,
  isDeleted: false,
  tagIds: [],
  progress: { checklist: { done: 0, total: 0 }, tasks: { done: 0, total: 0 } },
  version: 1,
  deletedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const notePage = { items: [noteSummary], page: 1, limit: 50, hasMore: false };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestedUrl(mock: ReturnType<typeof vi.fn<typeof fetch>>): URL {
  return new URL(String(mock.mock.calls[0]![0]));
}

describe("server note reads", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    cookieStore.getAll.mockReset().mockReturnValue([{ name: "notted_session", value: "abc" }]);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("returns the page alongside the query it was resolved from", async () => {
    fetchMock.mockResolvedValue(jsonResponse(notePage));

    await expect(getServerNoteList(workspaceId, { page: "2" })).resolves.toMatchObject({
      status: "ready",
      data: { page: notePage, query: { page: 2, limit: 50, scope: "workspace-root" } },
    });

    const params = requestedUrl(fetchMock).searchParams;
    expect(params.get("page")).toBe("2");
    expect(params.get("limit")).toBe("50");
  });

  it("forwards the archive selector as its query-string form", async () => {
    fetchMock.mockResolvedValue(jsonResponse(notePage));

    await getServerNoteList(workspaceId, { isArchived: "true" });

    expect(requestedUrl(fetchMock).searchParams.get("isArchived")).toBe("true");
  });

  /**
   * The project selector comes from the route segment, never the query string,
   * so a forged `projectId` cannot widen a workspace listing into another
   * project. An invalid one is refused before any request is made.
   */
  it("refuses a malformed workspace or project id before requesting", async () => {
    await expect(getServerNoteList("forged")).resolves.toEqual({ status: "not-found" });
    await expect(getServerNoteList(workspaceId, {}, { projectId: "forged" })).resolves.toEqual({
      status: "not-found",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("scopes the listing to a valid project segment", async () => {
    fetchMock.mockResolvedValue(jsonResponse(notePage));

    await getServerNoteList(workspaceId, {}, { projectId });

    const params = requestedUrl(fetchMock).searchParams;
    expect(params.get("scope")).toBe("project");
    expect(params.get("projectId")).toBe(projectId);
  });

  it("forwards request cookies and omits the header when there are none", async () => {
    fetchMock.mockResolvedValue(jsonResponse(notePage));
    await getServerNoteList(workspaceId);
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("cookie")).toBe(
      "notted_session=abc",
    );

    fetchMock.mockClear();
    cookieStore.getAll.mockReturnValue([]);
    await getServerNoteList(workspaceId);
    expect(fetchMock.mock.calls[0]![1]?.headers).toBeUndefined();
  });

  it("maps 401 to unauthenticated and conceals 403/404 as not-found", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(getServerNoteList(workspaceId)).resolves.toEqual({ status: "unauthenticated" });

    for (const status of [403, 404] as const) {
      fetchMock.mockResolvedValue(new Response(null, { status }));
      await expect(getServerNoteList(workspaceId)).resolves.toEqual({ status: "not-found" });
    }
  });

  it("maps any other failure, malformed payload, or thrown request to unavailable", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    await expect(getServerNoteList(workspaceId)).resolves.toEqual({ status: "unavailable" });

    fetchMock.mockResolvedValue(jsonResponse({ items: [{ id: noteId }], page: 1, limit: 50 }));
    await expect(getServerNoteList(workspaceId)).resolves.toEqual({ status: "unavailable" });

    fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    await expect(getServerNoteList(workspaceId)).resolves.toEqual({ status: "unavailable" });
  });

  it("reads one note detail and refuses forged route ids", async () => {
    await expect(getServerNoteDetail("forged", noteId)).resolves.toEqual({ status: "not-found" });
    await expect(getServerNoteDetail(workspaceId, "forged")).resolves.toEqual({
      status: "not-found",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const detail = {
      ...noteSummary,
      content: { type: "doc", content: [] },
      contentPlain: "",
      createdById: "10000000-0000-4000-8000-000000000001",
      updatedById: null,
      currentActorId: "10000000-0000-4000-8000-000000000001",
      capabilities: { canUpdate: true, canDelete: true, canShare: true, canExport: true },
    };
    fetchMock.mockResolvedValue(jsonResponse(detail));

    await expect(getServerNoteDetail(workspaceId, noteId)).resolves.toEqual({
      status: "ready",
      data: detail,
    });
    expect(requestedUrl(fetchMock).pathname).toBe(
      `/api/v1/workspaces/${workspaceId}/notes/${noteId}`,
    );
  });

  it("requests a bounded navigation tree that excludes archived notes", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ items: [], limit: 500, returned: 0, truncated: false }),
    );

    await expect(getServerNoteNavigation(workspaceId)).resolves.toEqual({
      status: "ready",
      data: { items: [], limit: 500, returned: 0, truncated: false },
    });

    const params = requestedUrl(fetchMock).searchParams;
    expect(params.get("limit")).toBe("500");
    expect(params.get("includeArchived")).toBe("false");
  });

  it("requests a bounded folder page", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], page: 1, limit: 100, hasMore: false }));

    await expect(getServerFolders(workspaceId)).resolves.toMatchObject({ status: "ready" });
    expect(requestedUrl(fetchMock).searchParams.get("limit")).toBe("100");
  });

  it("requests a bounded member page", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], page: 1, limit: 100, hasMore: false }));

    await expect(getServerWorkspaceMembers(workspaceId)).resolves.toMatchObject({
      status: "ready",
    });
    expect(requestedUrl(fetchMock).pathname).toBe(`/api/v1/workspaces/${workspaceId}/members`);
    expect(requestedUrl(fetchMock).searchParams.get("limit")).toBe("100");
  });

  it.each([
    ["getServerNoteNavigation", () => getServerNoteNavigation("forged")],
    ["getServerFolders", () => getServerFolders("forged")],
    ["getServerWorkspaceMembers", () => getServerWorkspaceMembers("forged")],
  ])("refuses %s for a forged workspace id", async (_name, invoke) => {
    await expect(invoke()).resolves.toEqual({ status: "not-found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
