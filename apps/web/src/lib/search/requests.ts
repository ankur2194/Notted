// Part 52.4 — client search transport.
//
// Mirrors `notes/requests.ts`: validate the caller-facing input with the shared
// Zod contract, guard route ids with `validIds`, build `URLSearchParams` from
// the schema OUTPUT, and re-validate the response with `searchPageSchema` /
// `searchSuggestionSchema`. The transport (`requestJson`) is shared so failures
// collapse to the same `ApiRequestResult` vocabulary every other feature uses.

import { SEARCH_API_PATHS } from "@notted/shared-types";
import {
  searchPageSchema,
  searchQuerySchema,
  searchSuggestionQuerySchema,
  searchSuggestionSchema,
  type SearchQueryInput,
} from "@notted/shared-validators";

import type { ApiRequestResult } from "@/lib/api/request-json";
import type { SearchPage, SearchSuggestion } from "@notted/shared-types";

import { requestJson, validIds } from "@/lib/api/request-json";

export type {
  ApiRequestFailure,
  ApiRequestFailureKind,
  ApiRequestResult,
} from "@/lib/api/request-json";

/** Default and recommended page sizes for the two endpoints. */
export const SEARCH_PAGE_DEFAULT_LIMIT = 25;
export const SEARCH_SUGGESTION_DEFAULT_LIMIT = 8;

export type SearchSort = "relevance" | "createdAt" | "updatedAt";
export type SearchSortDirection = "asc" | "desc";

/**
 * Caller-facing filter selectors. `hasAttachments` stays in the query-string
 * form (`"true"`/`"false"`) so it round-trips through the URL unchanged; the
 * schema transforms it to a boolean at the API boundary.
 */
export interface SearchFilters {
  readonly projectId?: string;
  readonly authorId?: string;
  readonly createdFrom?: string;
  readonly createdTo?: string;
  readonly updatedFrom?: string;
  readonly updatedTo?: string;
  readonly hasAttachments?: "true" | "false";
}

/**
 * Search-page input minus the redundant `workspaceId` (which is the route
 * argument). The full `SearchQueryInput` is reconstructed internally so the
 * shared `.strict()` schema validates every field.
 */
export type SearchPageInput = Omit<SearchQueryInput, "workspaceId">;

export function requestSearchPage(
  workspaceId: string,
  query: SearchPageInput,
): Promise<ApiRequestResult<SearchPage>> {
  const parsed = searchQuerySchema.safeParse({ workspaceId, ...query });
  if (!validIds(workspaceId) || !parsed.success) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  // `parsed.data` is the schema OUTPUT: defaults are resolved, `page`/`limit`
  // are required numbers, and `hasAttachments` is a boolean (transformed from
  // the `"true"`/`"false"` query-string input). Re-stringify only the fields
  // the endpoint accepts; `workspaceId` lives in the path, not the query.
  const data = parsed.data;
  const params = new URLSearchParams();
  params.set("query", data.query);
  params.set("mode", data.mode);
  params.set("page", String(data.page));
  params.set("limit", String(data.limit));
  params.set("sortBy", data.sortBy);
  params.set("sortDirection", data.sortDirection);
  if (data.projectId !== undefined) params.set("projectId", data.projectId);
  if (data.authorId !== undefined) params.set("authorId", data.authorId);
  if (data.createdFrom !== undefined) params.set("createdFrom", data.createdFrom);
  if (data.createdTo !== undefined) params.set("createdTo", data.createdTo);
  if (data.updatedFrom !== undefined) params.set("updatedFrom", data.updatedFrom);
  if (data.updatedTo !== undefined) params.set("updatedTo", data.updatedTo);
  if (data.hasAttachments !== undefined) {
    params.set("hasAttachments", String(data.hasAttachments));
  }
  return requestJson(`${SEARCH_API_PATHS.collection(workspaceId)}?${params}`, {}, (value) =>
    searchPageSchema.safeParse(value),
  );
}

/**
 * Validate the suggestion array element-by-element. The shared package exports
 * a single-suggestion schema; composing it here avoids a new direct `zod` dep
 * and keeps the same `{ success; data }` shape `requestJson` expects.
 */
function parseSuggestionList(
  value: unknown,
): { success: true; data: readonly SearchSuggestion[] } | { success: false } {
  if (!Array.isArray(value)) return { success: false };
  const items: SearchSuggestion[] = [];
  for (const entry of value) {
    const parsed = searchSuggestionSchema.safeParse(entry);
    if (!parsed.success) return { success: false };
    items.push(parsed.data);
  }
  return { success: true, data: items };
}

export function requestSearchSuggestions(
  workspaceId: string,
  query: string,
  limit: number = SEARCH_SUGGESTION_DEFAULT_LIMIT,
): Promise<ApiRequestResult<readonly SearchSuggestion[]>> {
  const parsed = searchSuggestionQuerySchema.safeParse({ workspaceId, query, limit });
  if (!validIds(workspaceId) || !parsed.success) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  const params = new URLSearchParams({
    query: parsed.data.query,
    limit: String(parsed.data.limit),
  });
  return requestJson(
    `${SEARCH_API_PATHS.suggestions(workspaceId)}?${params}`,
    {},
    parseSuggestionList,
  );
}
