import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  requestSearchPage,
  requestSearchSuggestions,
  SEARCH_PAGE_DEFAULT_LIMIT,
  SEARCH_SUGGESTION_DEFAULT_LIMIT,
} from "./requests";

const workspaceId = "52000000-0000-4000-8000-000000000001";
const noteId = "52000000-0000-4000-8000-000000000002";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("search requests", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  describe("requestSearchPage", () => {
    const emptyPage = {
      items: [],
      page: 1,
      limit: SEARCH_PAGE_DEFAULT_LIMIT,
      total: 0,
      hasMore: false,
      availability: {
        textSearchAvailable: true,
        mode: "full-text",
        fallback: "none",
      },
    };

    it("serializes the query and applies schema defaults for page, limit, sort", async () => {
      fetchMock.mockResolvedValue(jsonResponse(emptyPage));

      await requestSearchPage(workspaceId, { query: "release notes" });

      const params = new URL(String(fetchMock.mock.calls[0]![0]), "https://api.test").searchParams;
      expect(params.get("query")).toBe("release notes");
      expect(params.get("mode")).toBe("full-text");
      expect(params.get("page")).toBe("1");
      expect(params.get("limit")).toBe(String(SEARCH_PAGE_DEFAULT_LIMIT));
      expect(params.get("sortBy")).toBe("relevance");
      expect(params.get("sortDirection")).toBe("desc");
      expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe(
        `/api/v1/workspaces/${workspaceId}/search`,
      );
    });

    it("includes only the optional selectors that were supplied", async () => {
      fetchMock.mockResolvedValue(jsonResponse(emptyPage));

      await requestSearchPage(workspaceId, {
        query: "x",
        projectId: noteId,
        authorId: workspaceId,
        createdFrom: "2026-01-01T00:00:00.000Z",
        createdTo: "2026-02-01T00:00:00.000Z",
        hasAttachments: "true",
        sortBy: "updatedAt",
        sortDirection: "asc",
        page: 2,
        limit: 10,
      });

      const params = new URL(String(fetchMock.mock.calls[0]![0]), "https://api.test").searchParams;
      expect(params.get("projectId")).toBe(noteId);
      expect(params.get("authorId")).toBe(workspaceId);
      expect(params.get("createdFrom")).toBe("2026-01-01T00:00:00.000Z");
      expect(params.get("createdTo")).toBe("2026-02-01T00:00:00.000Z");
      expect(params.get("hasAttachments")).toBe("true");
      expect(params.get("sortBy")).toBe("updatedAt");
      expect(params.get("sortDirection")).toBe("asc");
      expect(params.get("page")).toBe("2");
      expect(params.get("limit")).toBe("10");
    });

    it("rejects an out-of-contract query before the network boundary", async () => {
      await expect(
        requestSearchPage(workspaceId, {
          query: "x",
          createdFrom: "2026-02-01",
          createdTo: "2026-01-01",
        }),
      ).resolves.toMatchObject({ ok: false, kind: "invalid" });
      await expect(requestSearchPage(workspaceId, { query: "   " })).resolves.toMatchObject({
        ok: false,
        kind: "invalid",
      });
      await expect(requestSearchPage("not-a-uuid", { query: "x" })).resolves.toMatchObject({
        ok: false,
        kind: "invalid",
      });
      // Unknown keys are rejected by the strict schema before any fetch.
      await expect(
        requestSearchPage(workspaceId, { query: "x", unexpected: true } as never),
      ).resolves.toMatchObject({ ok: false, kind: "invalid" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a page whose items do not match the contract", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ items: [{ id: noteId }], page: 1, limit: 25 }));

      await expect(requestSearchPage(workspaceId, { query: "x" })).resolves.toEqual({
        ok: false,
        kind: "invalid",
      });
    });

    it("maps a valid page through the schema", async () => {
      const page = {
        items: [
          {
            noteId,
            workspaceId,
            projectId: null,
            authorId: workspaceId,
            authorName: "Author",
            projectTitle: null,
            title: "Release notes",
            updatedAt: "2026-08-01T00:00:00.000Z",
            createdAt: "2026-07-01T00:00:00.000Z",
            isArchived: false,
            isTemplate: false,
            hasAttachments: false,
            highlights: [{ field: "title", snippet: "Release" }],
            snippet: "Release",
          },
        ],
        page: 1,
        limit: 25,
        total: 1,
        hasMore: false,
        availability: { textSearchAvailable: true, mode: "full-text", fallback: "none" },
      };
      fetchMock.mockResolvedValue(jsonResponse(page));

      const result = await requestSearchPage(workspaceId, { query: "release" });
      if (!result.ok) throw new Error(`expected success, got ${result.kind}`);
      expect(result.data.items).toHaveLength(1);
      expect(result.data.availability.mode).toBe("full-text");
    });

    it.each([
      [400, "invalid"],
      [403, "forbidden-or-not-found"],
      [404, "forbidden-or-not-found"],
      [429, "unavailable"],
      [500, "unavailable"],
    ] as const)("maps a %s response to the expected failure kind", async (status, kind) => {
      fetchMock.mockResolvedValue(new Response(null, { status }));
      await expect(requestSearchPage(workspaceId, { query: "x" })).resolves.toMatchObject({
        ok: false,
        kind,
      });
    });

    it("treats a thrown request as unavailable", async () => {
      fetchMock.mockRejectedValue(new DOMException("timeout", "TimeoutError"));
      await expect(requestSearchPage(workspaceId, { query: "x" })).resolves.toEqual({
        ok: false,
        kind: "unavailable",
        retryable: true,
      });
    });
  });

  describe("requestSearchSuggestions", () => {
    it("builds the suggestion query and validates the array", async () => {
      const suggestions = [
        { noteId, title: "Release notes", updatedAt: "2026-08-01T00:00:00.000Z" },
      ];
      fetchMock.mockResolvedValue(jsonResponse(suggestions));

      const result = await requestSearchSuggestions(workspaceId, "rel");
      if (!result.ok) throw new Error(`expected success, got ${result.kind}`);
      expect(result.data).toHaveLength(1);

      const url = new URL(String(fetchMock.mock.calls[0]![0]));
      expect(url.pathname).toBe(`/api/v1/workspaces/${workspaceId}/search/suggestions`);
      expect(url.searchParams.get("query")).toBe("rel");
      expect(url.searchParams.get("limit")).toBe(String(SEARCH_SUGGESTION_DEFAULT_LIMIT));
    });

    it("rejects an empty query and an invalid workspace before fetching", async () => {
      await expect(requestSearchSuggestions(workspaceId, "")).resolves.toMatchObject({
        ok: false,
        kind: "invalid",
      });
      await expect(requestSearchSuggestions("forged", "x")).resolves.toMatchObject({
        ok: false,
        kind: "invalid",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fails closed when the body is not a suggestion array", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ noteId, title: "x" }));
      await expect(requestSearchSuggestions(workspaceId, "x")).resolves.toEqual({
        ok: false,
        kind: "invalid",
      });

      fetchMock.mockResolvedValue(jsonResponse([{ noteId, title: "x", unexpected: true }]));
      // Each element is validated with the strict single-suggestion schema, so
      // an unknown key rejects the whole list rather than leaking a partial one.
      await expect(requestSearchSuggestions(workspaceId, "x")).resolves.toEqual({
        ok: false,
        kind: "invalid",
      });
    });

    it("honors a custom limit", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));
      await requestSearchSuggestions(workspaceId, "x", 3);
      const url = new URL(String(fetchMock.mock.calls[0]![0]));
      expect(url.searchParams.get("limit")).toBe("3");
    });
  });
});
