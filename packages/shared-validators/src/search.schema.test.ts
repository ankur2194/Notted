import { describe, expect, it } from "vitest";

import {
  recentSearchesPayloadSchema,
  recentSearchSchema,
  searchAvailabilitySchema,
  searchHighlightSchema,
  searchPageSchema,
  searchQuerySchema,
  searchResultSchema,
  searchSuggestionQuerySchema,
  searchSuggestionSchema,
} from "./search.schema";

const WORKSPACE_ID = "11111111-0000-4000-8000-000000000001";
const NOTE_ID = "22222222-0000-4000-8000-000000000002";
const PROJECT_ID = "33333333-0000-4000-8000-000000000003";
const AUTHOR_ID = "44444444-0000-4000-8000-000000000004";

describe("searchQuerySchema", () => {
  it("applies defaults for mode, sort, and pagination", () => {
    const parsed = searchQuerySchema.parse({
      workspaceId: WORKSPACE_ID,
      query: "release notes",
    });
    expect(parsed.mode).toBe("full-text");
    expect(parsed.sortBy).toBe("relevance");
    expect(parsed.sortDirection).toBe("desc");
    expect(parsed.page).toBe(1);
    expect(parsed.limit).toBe(25);
  });

  it("accepts updatedFrom/updatedTo and sortDirection", () => {
    const parsed = searchQuerySchema.parse({
      workspaceId: WORKSPACE_ID,
      query: "x",
      updatedFrom: "2026-01-01T00:00:00.000Z",
      updatedTo: "2026-02-01T00:00:00.000Z",
      sortBy: "updatedAt",
      sortDirection: "asc",
    });
    expect(parsed.updatedFrom).toBe("2026-01-01T00:00:00.000Z");
    expect(parsed.sortDirection).toBe("asc");
  });

  it("rejects createdTo earlier than createdFrom", () => {
    const result = searchQuerySchema.safeParse({
      workspaceId: WORKSPACE_ID,
      query: "x",
      createdFrom: "2026-02-01T00:00:00.000Z",
      createdTo: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects updatedTo earlier than updatedFrom", () => {
    const result = searchQuerySchema.safeParse({
      workspaceId: WORKSPACE_ID,
      query: "x",
      updatedFrom: "2026-02-01T00:00:00.000Z",
      updatedTo: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const result = searchQuerySchema.safeParse({
      workspaceId: WORKSPACE_ID,
      query: "x",
      unexpected: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty query", () => {
    const result = searchQuerySchema.safeParse({
      workspaceId: WORKSPACE_ID,
      query: "   ",
    });
    expect(result.success).toBe(false);
  });
});

describe("searchSuggestionQuerySchema", () => {
  it("applies the default limit and validates the query length", () => {
    const parsed = searchSuggestionQuerySchema.parse({
      workspaceId: WORKSPACE_ID,
      query: "rel",
    });
    expect(parsed.limit).toBe(8);
  });

  it("rejects a query longer than 100 characters", () => {
    const result = searchSuggestionQuerySchema.safeParse({
      workspaceId: WORKSPACE_ID,
      query: "x".repeat(101),
    });
    expect(result.success).toBe(false);
  });
});

describe("output schemas", () => {
  it("validates a search highlight shape", () => {
    expect(searchHighlightSchema.parse({ field: "title", snippet: "Release" })).toEqual({
      field: "title",
      snippet: "Release",
    });
    expect(searchHighlightSchema.safeParse({ field: "body", snippet: "x" }).success).toBe(false);
  });

  it("validates a full search result", () => {
    const result = searchResultSchema.parse({
      noteId: NOTE_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      authorId: AUTHOR_ID,
      authorName: "Author",
      projectTitle: "Project",
      title: "Release notes",
      updatedAt: "2026-08-01T00:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
      isArchived: false,
      isTemplate: false,
      hasAttachments: true,
      highlights: [{ field: "content", snippet: "Ships \u0000today\u0001" }],
      snippet: "Ships \u0000today\u0001",
    });
    expect(result.noteId).toBe(NOTE_ID);
  });

  it("caps highlights at 5 per result", () => {
    const highlights = Array.from({ length: 6 }, () => ({
      field: "title" as const,
      snippet: "x",
    }));
    const parsed = searchResultSchema.safeParse({
      noteId: NOTE_ID,
      workspaceId: WORKSPACE_ID,
      projectId: null,
      authorId: AUTHOR_ID,
      authorName: "Author",
      projectTitle: null,
      title: "Title",
      updatedAt: "2026-08-01T00:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
      isArchived: false,
      isTemplate: false,
      hasAttachments: false,
      highlights,
      snippet: "x",
    });
    expect(parsed.success).toBe(false);
  });

  it("validates an availability object", () => {
    expect(
      searchAvailabilitySchema.parse({
        textSearchAvailable: true,
        mode: "full-text",
        fallback: "none",
      }),
    ).toEqual({
      textSearchAvailable: true,
      mode: "full-text",
      fallback: "none",
    });
    expect(
      searchAvailabilitySchema.safeParse({
        textSearchAvailable: true,
        mode: "full-text",
        fallback: "unexpected",
      }).success,
    ).toBe(false);
  });

  it("validates a search page with empty items and an availability block", () => {
    const parsed = searchPageSchema.parse({
      items: [],
      page: 1,
      limit: 25,
      total: 0,
      hasMore: false,
      availability: {
        textSearchAvailable: false,
        mode: "full-text",
        fallback: "provider-unavailable",
      },
    });
    expect(parsed.availability.fallback).toBe("provider-unavailable");
  });

  it("validates a suggestion", () => {
    expect(
      searchSuggestionSchema.parse({
        noteId: NOTE_ID,
        title: "Title",
        updatedAt: "2026-08-01T00:00:00.000Z",
      }),
    ).toEqual({
      noteId: NOTE_ID,
      title: "Title",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
  });
});

describe("recent searches contract (browser-local only)", () => {
  it("validates a recent search entry", () => {
    expect(
      recentSearchSchema.parse({
        query: "release notes",
        recordedAt: "2026-08-01T00:00:00.000Z",
      }),
    ).toEqual({ query: "release notes", recordedAt: "2026-08-01T00:00:00.000Z" });
  });

  it("accepts a payload of up to 20 recent searches with version 1", () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      query: `q${index}`,
      recordedAt: "2026-08-01T00:00:00.000Z",
    }));
    const parsed = recentSearchesPayloadSchema.parse({ items, version: 1 });
    expect(parsed.items).toHaveLength(20);
    expect(parsed.version).toBe(1);
  });

  it("rejects more than 20 recent searches", () => {
    const items = Array.from({ length: 21 }, (_, index) => ({
      query: `q${index}`,
      recordedAt: "2026-08-01T00:00:00.000Z",
    }));
    expect(recentSearchesPayloadSchema.safeParse({ items, version: 1 }).success).toBe(false);
  });

  it("rejects a payload whose version is not exactly 1", () => {
    expect(recentSearchesPayloadSchema.safeParse({ items: [], version: 2 }).success).toBe(false);
  });
});
