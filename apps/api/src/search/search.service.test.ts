import { describe, expect, it, vi } from "vitest";

import {
  HIGHLIGHT_POST_TAG,
  HIGHLIGHT_PRE_TAG,
  NoteIndexRepository,
  type NoteSearchCandidate,
  type NoteSearchCandidatePage,
} from "./note-index.repository";
import { SearchService, type SearchServiceInput } from "./search.service";

import type { NoteSearchFact, SearchResultRepository } from "./search-result.repository";
import type { SemanticSearchService } from "./semantic-search.service";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { MeilisearchService } from "../infrastructure/meilisearch/meilisearch.service";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

// --------------------------------------------------------------------------- //
// Stable identifiers
// --------------------------------------------------------------------------- //

const WORKSPACE_ID = "11111111-0000-4000-8000-000000000001";
const USER_ID = "22222222-0000-4000-8000-000000000002";
const NOTE_A = "33333333-0000-4000-8000-000000000003";
const NOTE_B = "44444444-0000-4000-8000-000000000004";
const NOTE_C = "55555555-0000-4000-8000-000000000005";
const NOTE_DELETED_IN_PG = "66666666-0000-4000-8000-000000000006";
const PROJECT_ID = "77777777-0000-4000-8000-000000000007";
const AUTHOR_ID = "88888888-0000-4000-8000-000000000008";

const PRINCIPAL: AuthenticatedPrincipal = Object.freeze({
  userId: USER_ID,
  sessionId: "session-1",
  method: "opaque-session",
  assurance: "single-factor",
  authenticatedAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-08-02T00:00:00.000Z",
  isFresh: true,
});

const NOW = new Date("2026-08-12T12:00:00.000Z");

function buildCandidate(overrides: Partial<NoteSearchCandidate>): NoteSearchCandidate {
  return Object.freeze({
    id: NOTE_A,
    title: "Note A",
    contentSnippet: "Body content",
    tags: ["planning"],
    formattedTitle: "Note A",
    formattedContent: `Body ${HIGHLIGHT_PRE_TAG}content${HIGHLIGHT_POST_TAG}`,
    formattedTags: [],
    rankingScore: 0.7,
    ...overrides,
  });
}

function buildFact(overrides: Partial<NoteSearchFact> = {}): NoteSearchFact {
  return Object.freeze({
    noteId: NOTE_A,
    title: "Note A",
    projectId: null,
    createdById: AUTHOR_ID,
    createdAt: NOW,
    updatedAt: NOW,
    isArchived: false,
    isTemplate: false,
    isPinned: false,
    hasAttachments: false,
    accessible: true,
    authorName: "Author Name",
    projectTitle: null,
    ...overrides,
  });
}

function buildService(deps: {
  readonly meilisearch: { readonly enabled: boolean };
  readonly noteIndex: {
    readonly search: ReturnType<typeof vi.fn>;
  };
  readonly searchResults: {
    readonly loadFacts: ReturnType<typeof vi.fn>;
  };
  readonly semantic?: SemanticSearchService;
}): SearchService {
  return new SearchService(
    { isEnabled: () => deps.meilisearch.enabled } as unknown as MeilisearchService,
    deps.noteIndex as unknown as NoteIndexRepository,
    deps.searchResults as unknown as SearchResultRepository,
    {
      info: vi.fn(),
      failure: vi.fn(),
    } as unknown as StructuredLogger,
    deps.semantic,
  );
}

function baseInput(overrides: Partial<SearchServiceInput> = {}): SearchServiceInput {
  return {
    workspaceId: WORKSPACE_ID,
    query: "release",
    mode: "full-text",
    filters: {},
    sort: { sortBy: "relevance", sortDirection: "desc" },
    page: 1,
    limit: 10,
    ...overrides,
  };
}

describe("SearchService.search", () => {
  it("returns an authorized full-text page with highlight markers preserved", async () => {
    const candidatePage: NoteSearchCandidatePage = {
      candidates: [buildCandidate({ id: NOTE_A })],
      providerTotal: 1,
      limit: 10,
      offset: 0,
    };
    const facts = new Map<string, NoteSearchFact>([[NOTE_A, buildFact()]]);

    const service = buildService({
      meilisearch: { enabled: true },
      noteIndex: { search: vi.fn().mockResolvedValue(candidatePage) },
      searchResults: { loadFacts: vi.fn().mockResolvedValue(facts) },
    });

    const page = await service.search(baseInput(), {
      principal: PRINCIPAL,
      membershipRole: "editor",
      requestId: "req-1",
    });

    expect(page.items).toHaveLength(1);
    const result = page.items[0];
    expect(result?.noteId).toBe(NOTE_A);
    expect(result?.workspaceId).toBe(WORKSPACE_ID);
    expect(result?.authorName).toBe("Author Name");
    expect(result?.isArchived).toBe(false);
    expect(result?.isTemplate).toBe(false);
    expect(result?.hasAttachments).toBe(false);
    // Highlight markers preserved verbatim — never HTML.
    expect(result?.snippet).toBe(`Body ${HIGHLIGHT_PRE_TAG}content${HIGHLIGHT_POST_TAG}`);
    expect(result?.highlights[0]?.field).toBe("title");
    expect(result?.highlights[1]?.field).toBe("content");
    expect(result?.highlights[1]?.snippet).toBe(
      `Body ${HIGHLIGHT_PRE_TAG}content${HIGHLIGHT_POST_TAG}`,
    );
    expect(page.availability).toEqual({
      textSearchAvailable: true,
      mode: "full-text",
      fallback: "none",
    });
    expect(page.hasMore).toBe(false);
    expect(page.total).toBe(1);
  });

  it("returns a safe empty page when Meilisearch is disabled", async () => {
    const noteIndexSearch = vi.fn();
    const service = buildService({
      meilisearch: { enabled: false },
      noteIndex: { search: noteIndexSearch },
      searchResults: { loadFacts: vi.fn() },
    });

    const page = await service.search(baseInput(), {
      principal: PRINCIPAL,
      membershipRole: "editor",
    });

    expect(noteIndexSearch).not.toHaveBeenCalled();
    expect(page.items).toEqual([]);
    expect(page.availability).toEqual({
      textSearchAvailable: false,
      mode: "full-text",
      fallback: "provider-unavailable",
    });
  });

  it("rejects semantic mode with provider-unavailable (no 500)", async () => {
    const noteIndexSearch = vi.fn();
    const service = buildService({
      meilisearch: { enabled: true },
      noteIndex: { search: noteIndexSearch },
      searchResults: { loadFacts: vi.fn() },
    });

    const page = await service.search(baseInput({ mode: "semantic" }), {
      principal: PRINCIPAL,
      membershipRole: "editor",
    });

    expect(noteIndexSearch).not.toHaveBeenCalled();
    expect(page.items).toEqual([]);
    expect(page.availability.fallback).toBe("provider-unavailable");
    expect(page.availability.mode).toBe("semantic");
  });

  it("rejects hybrid mode with provider-unavailable (no 500)", async () => {
    const noteIndexSearch = vi.fn();
    const service = buildService({
      meilisearch: { enabled: true },
      noteIndex: { search: noteIndexSearch },
      searchResults: { loadFacts: vi.fn() },
    });

    const page = await service.search(baseInput({ mode: "hybrid" }), {
      principal: PRINCIPAL,
      membershipRole: "editor",
    });

    expect(noteIndexSearch).not.toHaveBeenCalled();
    expect(page.availability.fallback).toBe("provider-unavailable");
  });

  it("scans semantic windows from zero and paginates after authorization", async () => {
    const ids = Array.from(
      { length: 30 },
      (_unused, index) => `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    const authorizedIds = ids.slice(20);
    const candidates = vi.fn(
      async ({ offset, limit }: { readonly offset: number; readonly limit: number }) =>
        ids.slice(offset, offset + limit),
    );
    const loadFacts = vi.fn(
      async (candidateIds: readonly string[]) =>
        new Map(
          candidateIds
            .filter((id) => authorizedIds.includes(id))
            .map((id) => [id, buildFact({ noteId: id })]),
        ),
    );
    const service = buildService({
      meilisearch: { enabled: true },
      noteIndex: { search: vi.fn() },
      searchResults: { loadFacts },
      semantic: {
        isAvailable: () => true,
        candidates,
      } as unknown as SemanticSearchService,
    });

    const page = await service.search(baseInput({ mode: "semantic", page: 2, limit: 3 }), {
      principal: PRINCIPAL,
      membershipRole: "viewer",
    });

    expect(candidates).toHaveBeenNthCalledWith(1, expect.objectContaining({ offset: 0 }));
    expect(page.items.map(({ noteId }) => noteId)).toEqual(authorizedIds.slice(3, 6));
    expect(page.hasMore).toBe(true);
  });

  it("excludes candidates denied by the result repository (over-fetch + authorize)", async () => {
    // 3 candidates, but only NOTE_B is authorized.
    const candidatePage: NoteSearchCandidatePage = {
      candidates: [
        buildCandidate({ id: NOTE_A }),
        buildCandidate({ id: NOTE_B }),
        buildCandidate({ id: NOTE_C }),
      ],
      providerTotal: 3,
      limit: 30,
      offset: 0,
    };
    const facts = new Map<string, NoteSearchFact>([
      [NOTE_B, buildFact({ noteId: NOTE_B, title: "Note B" })],
    ]);

    const service = buildService({
      meilisearch: { enabled: true },
      noteIndex: { search: vi.fn().mockResolvedValue(candidatePage) },
      searchResults: { loadFacts: vi.fn().mockResolvedValue(facts) },
    });

    const page = await service.search(baseInput({ limit: 10 }), {
      principal: PRINCIPAL,
      membershipRole: "editor",
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.noteId).toBe(NOTE_B);
    expect(page.total).toBe(1);
  });

  it("sets hasMore when more authorized candidates remain beyond the page slice", async () => {
    // Page size 2; 3 candidates all authorized.
    const candidatePage: NoteSearchCandidatePage = {
      candidates: [
        buildCandidate({ id: NOTE_A }),
        buildCandidate({ id: NOTE_B }),
        buildCandidate({ id: NOTE_C }),
      ],
      providerTotal: 3,
      limit: 8,
      offset: 0,
    };
    const facts = new Map<string, NoteSearchFact>([
      [NOTE_A, buildFact({ noteId: NOTE_A })],
      [NOTE_B, buildFact({ noteId: NOTE_B })],
      [NOTE_C, buildFact({ noteId: NOTE_C })],
    ]);

    const service = buildService({
      meilisearch: { enabled: true },
      noteIndex: { search: vi.fn().mockResolvedValue(candidatePage) },
      searchResults: { loadFacts: vi.fn().mockResolvedValue(facts) },
    });

    const page = await service.search(baseInput({ limit: 2 }), {
      principal: PRINCIPAL,
      membershipRole: "editor",
    });

    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });

  it("scans stable windows from zero so pages are duplicate-free through dense denied and stale hits", async () => {
    const ids = Array.from(
      { length: 30 },
      (_unused, index) => `90000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    const authorizedIds = ids.slice(20);
    const search = vi.fn(async ({ offset, limit }: { offset: number; limit: number }) => ({
      candidates: ids.slice(offset, offset + limit).map((id) => buildCandidate({ id })),
      providerTotal: ids.length,
      offset,
      limit,
    }));
    const loadFacts = vi.fn(
      async (candidateIds: readonly string[]) =>
        new Map(
          candidateIds
            .filter((id) => authorizedIds.includes(id))
            .map((id) => [id, buildFact({ noteId: id })]),
        ),
    );
    const service = buildService({
      meilisearch: { enabled: true },
      noteIndex: { search },
      searchResults: { loadFacts },
    });

    const first = await service.search(baseInput({ page: 1, limit: 3 }), {
      principal: PRINCIPAL,
      membershipRole: "viewer",
    });
    const second = await service.search(baseInput({ page: 2, limit: 3 }), {
      principal: PRINCIPAL,
      membershipRole: "viewer",
    });

    expect(first.items.map(({ noteId }) => noteId)).toEqual(authorizedIds.slice(0, 3));
    expect(second.items.map(({ noteId }) => noteId)).toEqual(authorizedIds.slice(3, 6));
    expect(new Set([...first.items, ...second.items].map(({ noteId }) => noteId))).toHaveLength(6);
    expect(search.mock.calls.every(([call]) => call.offset === 0 || call.offset === 25)).toBe(true);
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(true);
  });

  it("excludes candidates absent from PostgreSQL (deletion drift)", async () => {
    const candidatePage: NoteSearchCandidatePage = {
      candidates: [buildCandidate({ id: NOTE_A }), buildCandidate({ id: NOTE_DELETED_IN_PG })],
      providerTotal: 2,
      limit: 10,
      offset: 0,
    };
    // Drift candidate NOTE_DELETED_IN_PG is absent from PostgreSQL facts.
    const facts = new Map<string, NoteSearchFact>([[NOTE_A, buildFact({ noteId: NOTE_A })]]);

    const service = buildService({
      meilisearch: { enabled: true },
      noteIndex: { search: vi.fn().mockResolvedValue(candidatePage) },
      searchResults: { loadFacts: vi.fn().mockResolvedValue(facts) },
    });

    const page = await service.search(baseInput(), {
      principal: PRINCIPAL,
      membershipRole: "editor",
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.noteId).toBe(NOTE_A);
  });

  it("excludes candidates in restricted projects the user cannot read", async () => {
    const candidatePage: NoteSearchCandidatePage = {
      candidates: [buildCandidate({ id: NOTE_A }), buildCandidate({ id: NOTE_B })],
      providerTotal: 2,
      limit: 10,
      offset: 0,
    };
    // Simulate the result repository already filtering out NOTE_B for the
    // restricted-project denial (the repository omits denied notes from the
    // map). Only NOTE_A is in the returned map.
    const facts = new Map<string, NoteSearchFact>([[NOTE_A, buildFact({ noteId: NOTE_A })]]);

    const service = buildService({
      meilisearch: { enabled: true },
      noteIndex: { search: vi.fn().mockResolvedValue(candidatePage) },
      searchResults: { loadFacts: vi.fn().mockResolvedValue(facts) },
    });

    const page = await service.search(baseInput(), {
      principal: PRINCIPAL,
      membershipRole: "viewer",
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.noteId).toBe(NOTE_A);
  });

  it("includes notes that the result repository marked accessible via a direct share", async () => {
    // The result repository applies the share-grants-read extension. The
    // service just consumes whatever facts the repository returns; this test
    // confirms that the service does not second-guess that decision.
    const candidatePage: NoteSearchCandidatePage = {
      candidates: [buildCandidate({ id: NOTE_A })],
      providerTotal: 1,
      limit: 10,
      offset: 0,
    };
    const facts = new Map<string, NoteSearchFact>([
      [NOTE_A, buildFact({ noteId: NOTE_A, projectId: PROJECT_ID })],
    ]);

    const service = buildService({
      meilisearch: { enabled: true },
      noteIndex: { search: vi.fn().mockResolvedValue(candidatePage) },
      searchResults: { loadFacts: vi.fn().mockResolvedValue(facts) },
    });

    const page = await service.search(baseInput(), {
      principal: PRINCIPAL,
      membershipRole: "viewer",
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.projectId).toBe(PROJECT_ID);
  });

  it("returns a safe empty page when the provider throws", async () => {
    const service = buildService({
      meilisearch: { enabled: true },
      noteIndex: { search: vi.fn().mockRejectedValue(new Error("Meilisearch search failed")) },
      searchResults: { loadFacts: vi.fn() },
    });

    const page = await service.search(baseInput(), {
      principal: PRINCIPAL,
      membershipRole: "editor",
    });

    expect(page.items).toEqual([]);
    expect(page.availability.fallback).toBe("provider-unavailable");
  });

  it("falls back to 'Unknown author' when the author row was deleted", async () => {
    const candidatePage: NoteSearchCandidatePage = {
      candidates: [buildCandidate({ id: NOTE_A })],
      providerTotal: 1,
      limit: 10,
      offset: 0,
    };
    const facts = new Map<string, NoteSearchFact>([
      [NOTE_A, buildFact({ noteId: NOTE_A, authorName: null })],
    ]);

    const service = buildService({
      meilisearch: { enabled: true },
      noteIndex: { search: vi.fn().mockResolvedValue(candidatePage) },
      searchResults: { loadFacts: vi.fn().mockResolvedValue(facts) },
    });

    const page = await service.search(baseInput(), {
      principal: PRINCIPAL,
      membershipRole: "editor",
    });

    expect(page.items[0]?.authorName).toBe("Unknown author");
  });

  it("slices results to the requested page size", async () => {
    // 5 candidates, all authorized, page size 2.
    const candidatePage: NoteSearchCandidatePage = {
      candidates: [
        buildCandidate({ id: NOTE_A }),
        buildCandidate({ id: NOTE_B }),
        buildCandidate({ id: NOTE_C }),
        buildCandidate({ id: NOTE_DELETED_IN_PG }),
        buildCandidate({ id: PROJECT_ID }),
      ],
      providerTotal: 5,
      limit: 20,
      offset: 0,
    };
    const facts = new Map<string, NoteSearchFact>([
      [NOTE_A, buildFact({ noteId: NOTE_A })],
      [NOTE_B, buildFact({ noteId: NOTE_B })],
      [NOTE_C, buildFact({ noteId: NOTE_C })],
      [NOTE_DELETED_IN_PG, buildFact({ noteId: NOTE_DELETED_IN_PG })],
      [PROJECT_ID, buildFact({ noteId: PROJECT_ID })],
    ]);

    const service = buildService({
      meilisearch: { enabled: true },
      noteIndex: { search: vi.fn().mockResolvedValue(candidatePage) },
      searchResults: { loadFacts: vi.fn().mockResolvedValue(facts) },
    });

    const page = await service.search(baseInput({ limit: 2 }), {
      principal: PRINCIPAL,
      membershipRole: "editor",
    });

    expect(page.items).toHaveLength(2);
    expect(page.items.map((item) => item.noteId)).toEqual([NOTE_A, NOTE_B]);
    expect(page.hasMore).toBe(true);
  });

  it("does NOT log the query, snippets, or note ids", async () => {
    const info = vi.fn();
    const candidatePage: NoteSearchCandidatePage = {
      candidates: [buildCandidate({ id: NOTE_A })],
      providerTotal: 1,
      limit: 10,
      offset: 0,
    };
    const facts = new Map<string, NoteSearchFact>([[NOTE_A, buildFact()]]);

    const service = new SearchService(
      { isEnabled: () => true } as unknown as MeilisearchService,
      { search: vi.fn().mockResolvedValue(candidatePage) } as unknown as NoteIndexRepository,
      { loadFacts: vi.fn().mockResolvedValue(facts) } as unknown as SearchResultRepository,
      { info, failure: vi.fn() } as unknown as StructuredLogger,
    );

    await service.search(baseInput({ query: "super-secret-query-string" }), {
      principal: PRINCIPAL,
      membershipRole: "editor",
      requestId: "req-secret",
    });

    expect(info).toHaveBeenCalled();
    const metadata = info.mock.calls[0]?.[0] as Record<string, unknown>;
    // The query string must never appear in the log metadata.
    expect(JSON.stringify(metadata)).not.toContain("super-secret-query-string");
    // Note ids, titles, and content must never appear either.
    expect(JSON.stringify(metadata)).not.toContain(NOTE_A);
    expect(JSON.stringify(metadata)).not.toContain("Note A");
    // Safe routing fields ARE present.
    expect(metadata).toMatchObject({
      searchMode: "full-text",
      searchOutcome: "ok",
      requestId: "req-secret",
    });
  });

  it("converts ISO timestamp filters to epoch-ms before delegating to the repository", async () => {
    const search = vi.fn().mockResolvedValue({
      candidates: [],
      providerTotal: 0,
      limit: 10,
      offset: 0,
    });
    const service = buildService({
      meilisearch: { enabled: true },
      noteIndex: { search },
      searchResults: { loadFacts: vi.fn().mockResolvedValue(new Map()) },
    });

    await service.search(
      baseInput({
        filters: {
          createdFrom: Date.parse("2026-01-01T00:00:00.000Z"),
          createdTo: Date.parse("2026-02-01T00:00:00.000Z"),
        },
      }),
      { principal: PRINCIPAL, membershipRole: "editor" },
    );

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({
          createdFrom: Date.parse("2026-01-01T00:00:00.000Z"),
          createdTo: Date.parse("2026-02-01T00:00:00.000Z"),
        }),
      }),
    );
  });
});

describe("SearchService.suggest", () => {
  it("returns authorized title suggestions ordered by provider rank", async () => {
    const candidatePage: NoteSearchCandidatePage = {
      candidates: [
        buildCandidate({ id: NOTE_A }),
        buildCandidate({ id: NOTE_B }),
        buildCandidate({ id: NOTE_C }),
      ],
      providerTotal: 3,
      limit: 12,
      offset: 0,
    };
    const facts = new Map<string, NoteSearchFact>([
      [NOTE_A, buildFact({ noteId: NOTE_A, title: "Alpha", updatedAt: NOW })],
      [NOTE_C, buildFact({ noteId: NOTE_C, title: "Gamma", updatedAt: NOW })],
    ]);

    const service = buildService({
      meilisearch: { enabled: true },
      noteIndex: { search: vi.fn().mockResolvedValue(candidatePage) },
      searchResults: { loadFacts: vi.fn().mockResolvedValue(facts) },
    });

    const suggestions = await service.suggest(
      { workspaceId: WORKSPACE_ID, query: "a", limit: 8 },
      { principal: PRINCIPAL, membershipRole: "editor" },
    );

    expect(suggestions).toHaveLength(2);
    expect(suggestions.map((s) => s.title)).toEqual(["Alpha", "Gamma"]);
  });

  it("returns an empty list when Meilisearch is disabled", async () => {
    const service = buildService({
      meilisearch: { enabled: false },
      noteIndex: { search: vi.fn() },
      searchResults: { loadFacts: vi.fn() },
    });
    const suggestions = await service.suggest(
      { workspaceId: WORKSPACE_ID, query: "a", limit: 8 },
      { principal: PRINCIPAL, membershipRole: "editor" },
    );
    expect(suggestions).toEqual([]);
  });
});
