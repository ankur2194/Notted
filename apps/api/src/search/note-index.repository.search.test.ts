import { describe, expect, it, vi } from "vitest";

import { parseMeilisearchConfig } from "../config/meilisearch.config";
import { MeilisearchService } from "../infrastructure/meilisearch/meilisearch.service";

import {
  NoteIndexRepository,
  HIGHLIGHT_POST_TAG,
  HIGHLIGHT_PRE_TAG,
} from "./note-index.repository";

import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { MeilisearchSearchOptions } from "../infrastructure/meilisearch/meilisearch.tokens";

const logger = {
  info: vi.fn(),
  failure: vi.fn(),
} as unknown as StructuredLogger;

const WORKSPACE_ID = "11111111-0000-4000-8000-000000000001";
const PROJECT_ID = "22222222-0000-4000-8000-000000000002";
const AUTHOR_ID = "33333333-0000-4000-8000-000000000003";
const NOTE_ID = "44444444-0000-4000-8000-000000000004";

const CREATED_FROM_MS = 1_700_000_000_000;
const CREATED_TO_MS = 1_800_000_000_000;

function meilisearchWithSearch(
  search: ReturnType<typeof vi.fn>,
  isEnabled = true,
): MeilisearchService {
  return {
    isEnabled: () => isEnabled,
    search,
  } as unknown as MeilisearchService;
}

function repository(search: ReturnType<typeof vi.fn>, isEnabled = true): NoteIndexRepository {
  return new NoteIndexRepository(
    parseMeilisearchConfig({ NODE_ENV: "test" }),
    meilisearchWithSearch(search, isEnabled),
    logger,
  );
}

function searchCallAt(mock: ReturnType<typeof vi.fn>, index: number): MeilisearchSearchOptions {
  const calls = mock.mock.calls;
  const call = calls[index];
  if (call === undefined) throw new Error(`No search call at index ${index}`);
  // The repository calls `this.meilisearch.search(indexUid, options)`; the
  // second positional argument is the options object.
  return call[1] as MeilisearchSearchOptions;
}

describe("NoteIndexRepository.search", () => {
  it("builds a workspace-only filter when no optional filters are provided", async () => {
    const search = vi.fn().mockResolvedValue({
      hits: [],
      estimatedTotalHits: 0,
      offset: 0,
      limit: 25,
      processingTimeMs: 1,
    });
    const repository_ = repository(search);

    await repository_.search({
      workspaceId: WORKSPACE_ID,
      query: "release notes",
      filters: {},
      sort: { sortBy: "relevance", sortDirection: "desc" },
      offset: 0,
      limit: 25,
    });

    const options = searchCallAt(search, 0);
    expect(options.filter).toBe(`workspaceId = "${WORKSPACE_ID}"`);
    expect(options.sort).toBeUndefined();
    expect(options.query).toBe("release notes");
    expect(options.offset).toBe(0);
    expect(options.limit).toBe(25);
    expect(options.attributesToRetrieve).toEqual(["id", "title", "content", "tags"]);
    expect(options.attributesToHighlight).toEqual(["title", "content", "tags"]);
    expect(options.highlightPreTag).toBe(HIGHLIGHT_PRE_TAG);
    expect(options.highlightPostTag).toBe(HIGHLIGHT_POST_TAG);
    expect(options.showRankingScore).toBe(true);
  });

  it("emits projectId, authorId, hasAttachments, and timestamp ranges in the canonical order", async () => {
    const search = vi.fn().mockResolvedValue({
      hits: [],
      estimatedTotalHits: 0,
      offset: 0,
      limit: 10,
      processingTimeMs: 0,
    });
    const repository_ = repository(search);

    await repository_.search({
      workspaceId: WORKSPACE_ID,
      query: "x",
      filters: {
        projectId: PROJECT_ID,
        authorId: AUTHOR_ID,
        hasAttachments: true,
        createdFrom: CREATED_FROM_MS,
        createdTo: CREATED_TO_MS,
        updatedFrom: CREATED_FROM_MS,
        updatedTo: CREATED_TO_MS,
      },
      sort: { sortBy: "relevance", sortDirection: "desc" },
      offset: 5,
      limit: 10,
    });

    const options = searchCallAt(search, 0);
    expect(options.filter).toBe(
      [
        `workspaceId = "${WORKSPACE_ID}"`,
        `projectId = "${PROJECT_ID}"`,
        `authorId = "${AUTHOR_ID}"`,
        `hasAttachments = true`,
        `createdAt >= ${CREATED_FROM_MS}`,
        `createdAt <= ${CREATED_TO_MS}`,
        `updatedAt >= ${CREATED_FROM_MS}`,
        `updatedAt <= ${CREATED_TO_MS}`,
      ].join(" AND "),
    );
  });

  it("emits hasAttachments false literally", async () => {
    const search = vi.fn().mockResolvedValue({
      hits: [],
      estimatedTotalHits: 0,
      offset: 0,
      limit: 25,
      processingTimeMs: 0,
    });
    const repository_ = repository(search);

    await repository_.search({
      workspaceId: WORKSPACE_ID,
      query: "x",
      filters: { hasAttachments: false },
      sort: { sortBy: "relevance", sortDirection: "desc" },
      offset: 0,
      limit: 25,
    });

    expect(searchCallAt(search, 0).filter).toContain("hasAttachments = false");
  });

  it("maps createdAt/updatedAt sort to a single-element sort array with direction", async () => {
    const search = vi.fn().mockResolvedValue({
      hits: [],
      estimatedTotalHits: 0,
      offset: 0,
      limit: 25,
      processingTimeMs: 0,
    });
    const repository_ = repository(search);

    await repository_.search({
      workspaceId: WORKSPACE_ID,
      query: "x",
      filters: {},
      sort: { sortBy: "createdAt", sortDirection: "asc" },
      offset: 0,
      limit: 25,
    });
    await repository_.search({
      workspaceId: WORKSPACE_ID,
      query: "x",
      filters: {},
      sort: { sortBy: "updatedAt", sortDirection: "desc" },
      offset: 0,
      limit: 25,
    });

    expect(searchCallAt(search, 0).sort).toEqual(["createdAt:asc"]);
    expect(searchCallAt(search, 1).sort).toEqual(["updatedAt:desc"]);
  });

  it("rejects a non-UUID workspaceId before calling the provider", async () => {
    const search = vi.fn();
    const repository_ = repository(search);
    await expect(
      repository_.search({
        workspaceId: `${WORKSPACE_ID}" OR true`,
        query: "x",
        filters: {},
        sort: { sortBy: "relevance", sortDirection: "desc" },
        offset: 0,
        limit: 25,
      }),
    ).rejects.toThrow();
    expect(search).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID projectId filter value", async () => {
    const search = vi.fn();
    const repository_ = repository(search);
    await expect(
      repository_.search({
        workspaceId: WORKSPACE_ID,
        query: "x",
        filters: { projectId: "not-a-uuid" },
        sort: { sortBy: "relevance", sortDirection: "desc" },
        offset: 0,
        limit: 25,
      }),
    ).rejects.toThrow();
    expect(search).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range limit", async () => {
    const search = vi.fn();
    const repository_ = repository(search);
    await expect(
      repository_.search({
        workspaceId: WORKSPACE_ID,
        query: "x",
        filters: {},
        sort: { sortBy: "relevance", sortDirection: "desc" },
        offset: 0,
        limit: 1_000,
      }),
    ).rejects.toThrow();
    expect(search).not.toHaveBeenCalled();
  });

  it("maps provider hits into the candidate page and surfaces the ranking score internally", async () => {
    const search = vi.fn().mockResolvedValue({
      hits: [
        {
          id: NOTE_ID,
          title: "Release notes",
          content: "Ships today",
          tags: ["product"],
          _formatted: {
            title: `${HIGHLIGHT_PRE_TAG}Release${HIGHLIGHT_POST_TAG} notes`,
            content: `Ships ${HIGHLIGHT_PRE_TAG}today${HIGHLIGHT_POST_TAG}`,
            tags: ["product"],
          },
          _rankingScore: 0.875,
        },
      ],
      estimatedTotalHits: 41,
      offset: 0,
      limit: 25,
      processingTimeMs: 3,
    });
    const repository_ = repository(search);

    const page = await repository_.search({
      workspaceId: WORKSPACE_ID,
      query: "release",
      filters: {},
      sort: { sortBy: "relevance", sortDirection: "desc" },
      offset: 0,
      limit: 25,
    });

    expect(page.providerTotal).toBe(41);
    expect(page.limit).toBe(25);
    expect(page.offset).toBe(0);
    expect(page.candidates).toHaveLength(1);
    const candidate = page.candidates[0];
    expect(candidate?.id).toBe(NOTE_ID);
    expect(candidate?.title).toBe("Release notes");
    expect(candidate?.contentSnippet).toBe("Ships today");
    expect(candidate?.tags).toEqual(["product"]);
    expect(candidate?.formattedTitle).toBe(
      `${HIGHLIGHT_PRE_TAG}Release${HIGHLIGHT_POST_TAG} notes`,
    );
    expect(candidate?.formattedContent).toBe(
      `Ships ${HIGHLIGHT_PRE_TAG}today${HIGHLIGHT_POST_TAG}`,
    );
    expect(candidate?.formattedTags).toEqual(["product"]);
    expect(candidate?.rankingScore).toBe(0.875);
  });

  it("still returns a page when the provider omits optional fields", async () => {
    const search = vi.fn().mockResolvedValue({
      hits: [
        {
          id: NOTE_ID,
        },
      ],
      estimatedTotalHits: 1,
      offset: 0,
      limit: 25,
      processingTimeMs: 0,
    });
    const repository_ = repository(search);

    const page = await repository_.search({
      workspaceId: WORKSPACE_ID,
      query: "x",
      filters: {},
      sort: { sortBy: "relevance", sortDirection: "desc" },
      offset: 0,
      limit: 25,
    });

    expect(page.candidates[0]?.title).toBe("");
    expect(page.candidates[0]?.formattedTitle).toBe("");
    expect(page.candidates[0]?.formattedTags).toEqual([]);
    expect(page.candidates[0]?.rankingScore).toBeNull();
  });

  it("forwards truncated long content snippets defensively", async () => {
    const longContent = "x".repeat(2_000);
    const search = vi.fn().mockResolvedValue({
      hits: [{ id: NOTE_ID, content: longContent }],
      estimatedTotalHits: 1,
      offset: 0,
      limit: 25,
      processingTimeMs: 0,
    });
    const repository_ = repository(search);

    const page = await repository_.search({
      workspaceId: WORKSPACE_ID,
      query: "x",
      filters: {},
      sort: { sortBy: "relevance", sortDirection: "desc" },
      offset: 0,
      limit: 25,
    });

    expect(page.candidates[0]?.contentSnippet.length).toBe(1_000);
  });

  it("is a no-op safe call path that still throws when the provider errors (error collapsing is in MeilisearchService)", async () => {
    // The repository delegates to MeilisearchService.search which collapses
    // errors. We assert here that the repository does NOT catch/swallow the
    // error itself: a thrown error propagates to the caller, where the search
    // service maps it to a safe empty result.
    const search = vi.fn().mockRejectedValue(new Error("Meilisearch search failed"));
    const repository_ = repository(search);

    await expect(
      repository_.search({
        workspaceId: WORKSPACE_ID,
        query: "x",
        filters: {},
        sort: { sortBy: "relevance", sortDirection: "desc" },
        offset: 0,
        limit: 25,
      }),
    ).rejects.toThrow("Meilisearch search failed");
  });
});
