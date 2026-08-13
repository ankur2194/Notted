import { z } from "zod";

import {
  explicitBooleanQuerySchema,
  isoTimestampSchema,
  paginationQuerySchema,
  uuidSchema,
} from "./common.schema";

// --------------------------------------------------------------------------- //
// Input contract
// --------------------------------------------------------------------------- //

export const searchModeSchema = z.enum(["full-text", "semantic", "hybrid"]);
export const searchSortSchema = z.enum(["relevance", "createdAt", "updatedAt"]);
export const searchSortDirectionSchema = z.enum(["asc", "desc"]);

export const searchQuerySchema = z
  .object({
    workspaceId: uuidSchema,
    query: z.string().trim().min(1).max(500),
    mode: searchModeSchema.default("full-text"),
    projectId: uuidSchema.optional(),
    authorId: uuidSchema.optional(),
    createdFrom: isoTimestampSchema.optional(),
    createdTo: isoTimestampSchema.optional(),
    updatedFrom: isoTimestampSchema.optional(),
    updatedTo: isoTimestampSchema.optional(),
    hasAttachments: explicitBooleanQuerySchema.optional(),
    page: paginationQuerySchema.shape.page,
    limit: paginationQuerySchema.shape.limit,
    sortBy: searchSortSchema.default("relevance"),
    // Relevance sort ignores direction (ranking rules dominate); accepting
    // the value here keeps the contract uniform for the client and frontend.
    sortDirection: searchSortDirectionSchema.default("desc"),
  })
  .strict()
  .refine(
    ({ createdFrom, createdTo }) =>
      createdFrom === undefined ||
      createdTo === undefined ||
      Date.parse(createdFrom) <= Date.parse(createdTo),
    {
      message: "createdFrom must be earlier than or equal to createdTo",
      path: ["createdTo"],
    },
  )
  .refine(
    ({ updatedFrom, updatedTo }) =>
      updatedFrom === undefined ||
      updatedTo === undefined ||
      Date.parse(updatedFrom) <= Date.parse(updatedTo),
    {
      message: "updatedFrom must be earlier than or equal to updatedTo",
      path: ["updatedTo"],
    },
  );
export type SearchQueryInput = z.input<typeof searchQuerySchema>;

/**
 * Suggestions endpoint input. The query is bounded tighter than the main
 * search box because suggestions are typed character-by-character and only the
 * title/prefix token is matched.
 */
export const searchSuggestionQuerySchema = z
  .object({
    workspaceId: uuidSchema,
    query: z.string().trim().min(1).max(100),
    limit: paginationQuerySchema.shape.limit.default(8),
  })
  .strict();
export type SearchSuggestionQueryInput = z.input<typeof searchSuggestionQuerySchema>;

// --------------------------------------------------------------------------- //
// Output contract
// --------------------------------------------------------------------------- //
//
// Highlights are PLAIN TEXT with match markers; the API never returns HTML or
// pre-rendered bold markup. The frontend splits on the marker characters and
// bolds the marked segments via React. The marker characters themselves
// (`\u0000` start / `\u0001` end) are control characters that cannot appear in
// any indexed note field, so the segments split cleanly without escaping.
//
// `searchPageSchema.total` is the AUTHORITATIVE returned-result count: the
// number of authorized items carried in `items`. It is NOT the raw provider
// (Meilisearch) total, because provider hits may include notes the user cannot
// read (deleted, restricted project, etc.) and the provider total would
// therefore overstate the real result set. `hasMore` reflects whether more
// authorized results existed beyond this page, computed by over-fetching the
// provider and slicing after authorization.

export const searchHighlightSchema = z
  .object({
    field: z.enum(["title", "content", "tag"]),
    snippet: z.string().max(1_000),
  })
  .strict()
  .readonly();
export type SearchHighlightOutput = z.infer<typeof searchHighlightSchema>;

export const searchResultSchema = z
  .object({
    noteId: uuidSchema,
    workspaceId: uuidSchema,
    projectId: uuidSchema.nullable(),
    authorId: uuidSchema,
    authorName: z.string(),
    projectTitle: z.string().nullable(),
    title: z.string(),
    updatedAt: isoTimestampSchema,
    createdAt: isoTimestampSchema,
    isArchived: z.boolean(),
    isTemplate: z.boolean(),
    hasAttachments: z.boolean(),
    highlights: z.array(searchHighlightSchema).max(5).readonly(),
    snippet: z.string(),
  })
  .strict()
  .readonly();
export type SearchResultOutput = z.infer<typeof searchResultSchema>;

export const searchAvailabilitySchema = z
  .object({
    textSearchAvailable: z.boolean(),
    // Which mode produced (or would have produced) results. For now only
    // `full-text` is operational; `semantic` and `hybrid` are activated in
    // Parts 53/54.
    mode: searchModeSchema,
    fallback: z.enum(["none", "text-only", "provider-unavailable"]),
  })
  .strict()
  .readonly();
export type SearchAvailabilityOutput = z.infer<typeof searchAvailabilitySchema>;

export const searchPageSchema = z
  .object({
    items: z.array(searchResultSchema).readonly(),
    page: z.number().int().min(1),
    limit: z.number().int().min(1).max(100),
    // Count of authorized items returned in `items` for this page. See module
    // note: this is NOT the raw provider total.
    total: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    availability: searchAvailabilitySchema,
  })
  .strict()
  .readonly();
export type SearchPageOutput = z.infer<typeof searchPageSchema>;

export const searchSuggestionSchema = z
  .object({
    noteId: uuidSchema,
    title: z.string(),
    updatedAt: isoTimestampSchema,
  })
  .strict()
  .readonly();
export type SearchSuggestionOutput = z.infer<typeof searchSuggestionSchema>;

// --------------------------------------------------------------------------- //
// Recent searches — BROWSER-LOCAL contract only (Part 52.4 frontend owns the
// persistence; the backend never stores or receives these values). The shape
// is shared so the frontend and any future sync surface agree on the format.
// --------------------------------------------------------------------------- //

export const recentSearchSchema = z
  .object({
    query: z.string().max(500),
    recordedAt: isoTimestampSchema,
  })
  .strict()
  .readonly();
export type RecentSearchOutput = z.infer<typeof recentSearchSchema>;

export const recentSearchesPayloadSchema = z
  .object({
    items: z.array(recentSearchSchema).max(20).readonly(),
    version: z.literal(1),
  })
  .strict()
  .readonly();
export type RecentSearchesPayloadOutput = z.infer<typeof recentSearchesPayloadSchema>;
