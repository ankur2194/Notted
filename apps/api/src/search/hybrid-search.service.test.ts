import { describe, expect, it, vi } from "vitest";

import { HybridRankingService } from "./hybrid-ranking.service";
import { HybridSearchService } from "./hybrid-search.service";

import type { NoteIndexRepository, NoteSearchCandidate } from "./note-index.repository";
import type { SearchResultRepository, NoteSearchFact } from "./search-result.repository";
import type { SemanticSearchService } from "./semantic-search.service";
import type { StructuredLogger } from "../common/logging/structured-logger.service";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const WORKSPACE = "10000000-0000-4000-8000-000000000001";
const candidate = (id: string): NoteSearchCandidate => ({
  id,
  title: id,
  contentSnippet: "sensitive snippet",
  tags: [],
  formattedTitle: id,
  formattedContent: "",
  formattedTags: [],
  rankingScore: 0.8,
});
const fact = (id: string): NoteSearchFact => ({
  noteId: id,
  title: "sensitive title",
  projectId: null,
  createdById: A,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  isArchived: false,
  isTemplate: false,
  isPinned: false,
  hasAttachments: false,
  accessible: true,
  authorName: "Author",
  projectTitle: null,
});
const input = {
  workspaceId: WORKSPACE,
  query: "sensitive query",
  mode: "hybrid" as const,
  filters: {},
  sort: { sortBy: "relevance" as const, sortDirection: "desc" as const },
  page: 1,
  limit: 10,
};
const principal = {
  principal: {
    userId: A,
    sessionId: "s",
    method: "opaque-session" as const,
    assurance: "single-factor" as const,
    authenticatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-02T00:00:00.000Z",
    isFresh: true,
  },
  membershipRole: "editor" as const,
};

function service(
  options: { available?: boolean; semanticReject?: boolean; lexicalReject?: boolean } = {},
) {
  const lexical = options.lexicalReject
    ? vi.fn().mockRejectedValue(new Error("provider body secret"))
    : vi
        .fn()
        .mockResolvedValue({ candidates: [candidate(A)], providerTotal: 1, offset: 0, limit: 40 });
  const semantic = options.semanticReject
    ? vi.fn().mockRejectedValue(new Error("API key secret"))
    : vi.fn().mockResolvedValue([{ id: B, similarity: 0.9 }]);
  const loadFacts = vi.fn().mockResolvedValue(
    new Map([
      [A, fact(A)],
      [B, fact(B)],
    ]),
  );
  const info = vi.fn();
  let time = 0;
  return {
    lexical,
    semantic,
    loadFacts,
    info,
    instance: new HybridSearchService(
      { search: lexical } as unknown as NoteIndexRepository,
      {
        isAvailable: () => options.available ?? true,
        rankedCandidates: semantic,
      } as unknown as SemanticSearchService,
      { loadFacts } as unknown as SearchResultRepository,
      new HybridRankingService(),
      { info } as unknown as StructuredLogger,
      () => ++time,
    ),
  };
}

describe("HybridSearchService", () => {
  it("starts both sources concurrently and includes semantic-only authorized candidates", async () => {
    const calls: string[] = [];
    const fixture = service();
    fixture.lexical.mockImplementation(async () => {
      calls.push("lexical-start");
      await Promise.resolve();
      return { candidates: [candidate(A)], providerTotal: 1, offset: 0, limit: 40 };
    });
    fixture.semantic.mockImplementation(async () => {
      calls.push("semantic-start");
      return [{ id: B, similarity: 0.9 }];
    });
    const page = await fixture.instance.search(input, principal);
    expect(calls.slice(0, 2)).toEqual(["lexical-start", "semantic-start"]);
    expect(page.items.map(({ noteId }) => noteId)).toContain(B);
    expect(fixture.loadFacts).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(page)).not.toContain("combinedScore");
  });

  it.each([{ available: false }, { semanticReject: true }])(
    "falls back to text-only when semantic is disabled or out",
    async (options) => {
      const fixture = service(options);
      const page = await fixture.instance.search(input, principal);
      expect(page.availability).toEqual({
        textSearchAvailable: true,
        mode: "full-text",
        fallback: "text-only",
      });
      expect(page.items.map(({ noteId }) => noteId)).toEqual([A]);
    },
  );

  it("fails safely rather than presenting semantic success after lexical outage", async () => {
    const page = await service({ lexicalReject: true }).instance.search(input, principal);
    expect(page.items).toEqual([]);
    expect(page.availability.fallback).toBe("provider-unavailable");
  });

  it("paginates only after ranking the shared bounded candidate window", async () => {
    const fixture = service({ available: false });
    fixture.lexical.mockResolvedValue({
      candidates: [candidate(A), candidate(B)],
      providerTotal: 2,
      offset: 0,
      limit: 4,
    });
    const page = await fixture.instance.search({ ...input, page: 2, limit: 1 }, principal);

    expect(fixture.lexical).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, limit: 4 }));
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(false);
  });

  it("expands candidate depth for pages beyond the default four-page window", async () => {
    const fixture = service({ available: false });
    fixture.lexical.mockResolvedValue({ candidates: [], providerTotal: 0, offset: 0, limit: 106 });

    await fixture.instance.search({ ...input, page: 5, limit: 21 }, principal);

    expect(fixture.lexical).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 0, limit: 106 }),
    );
  });

  it("logs only the diagnostics allow-list and no query, ids, content, errors or scores", async () => {
    const fixture = service({ semanticReject: true });
    await fixture.instance.search(input, principal);
    const serialized = JSON.stringify(fixture.info.mock.calls);
    for (const sensitive of [
      input.query,
      A,
      B,
      "sensitive snippet",
      "sensitive title",
      "API key",
      "0.8",
      "0.9",
    ])
      expect(serialized).not.toContain(sensitive);
    expect(fixture.info.mock.calls[0]?.[0]).toMatchObject({
      searchMode: "hybrid",
      searchFallback: "text-only",
      searchSemanticOutage: true,
    });
  });
});
