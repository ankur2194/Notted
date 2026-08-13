// Part 52.4 — TanStack query keys for the search feature.
//
// Search is workspace-scoped and gets its own root (mirroring `tagQueryKeys` and
// `taskQueryKeys`) so invalidating a tag, task, or note cache can never reach
// into search results. The page key carries every input that changes the
// response so identical queries dedupe and stale ones invalidate independently.

import type { SearchFilters } from "./requests";
import type { SearchMode, SearchSort, SearchSortDirection } from "@notted/shared-types";

export const searchKeys = Object.freeze({
  /** Workspace-level prefix for prefix invalidation. */
  workspace: (workspaceId: string) => ["search", workspaceId] as const,
  /**
   * Full search-page key. Includes the normalized query, mode, every filter,
   * sort, page, and limit so two identical queries share one cache entry and
   * any one of them changing fetches fresh results.
   */
  page: (
    workspaceId: string,
    query: string,
    mode: SearchMode,
    filters: SearchFilters,
    sort: SearchSort,
    sortDirection: SearchSortDirection,
    page: number,
    limit: number,
  ) =>
    [
      "search",
      workspaceId,
      "page",
      {
        query,
        mode,
        ...filters,
        sort,
        sortDirection,
        page,
        limit,
      },
    ] as const,
  /** Suggestion dropdown key for the command palette's fast path. */
  suggestions: (workspaceId: string, query: string, limit: number) =>
    ["search", workspaceId, "suggestions", { query, limit }] as const,
});
