"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import {
  SearchFilters,
  type SearchFilterValues,
  MemberFilterOption,
  ProjectFilterOption,
} from "./SearchFilters";
import { SearchResults, type SearchResultsStatus } from "./SearchResults";

import type { ApiRequestFailureKind } from "@/lib/api/request-json";
import type { SearchMode, SearchSort, SearchSortDirection } from "@notted/shared-types";

import { searchKeys } from "@/lib/search/query-keys";
import {
  requestSearchPage,
  SEARCH_PAGE_DEFAULT_LIMIT,
  type SearchFilters as RequestFilters,
  type SearchPageInput,
} from "@/lib/search/requests";

/** Local debounce for the full-page query input (discrete from the palette). */
const QUERY_DEBOUNCE_MS = 300;

class SearchPageError extends Error {
  constructor(readonly kind: ApiRequestFailureKind) {
    super("search page request failed");
    this.name = "SearchPageError";
  }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Convert a `YYYY-MM-DD` filter date to an inclusive start-of-day ISO timestamp. */
function toIsoStart(date: string): string | undefined {
  return DATE_PATTERN.test(date) ? `${date}T00:00:00.000Z` : undefined;
}

/** Convert a `YYYY-MM-DD` filter date to an inclusive end-of-day ISO timestamp. */
function toIsoEnd(date: string): string | undefined {
  return DATE_PATTERN.test(date) ? `${date}T23:59:59.999Z` : undefined;
}

function parseSortBy(value: string | null): SearchSort {
  return value === "createdAt" || value === "updatedAt" ? value : "relevance";
}

function parseSortDirection(value: string | null): SearchSortDirection {
  return value === "asc" ? "asc" : "desc";
}

function parsePage(value: string | null): number {
  const parsed = Number(value ?? "1");
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

function parseMode(value: string | null): SearchMode {
  return value === "semantic" || value === "hybrid" ? value : "full-text";
}

export function SearchContainer({
  workspaceId,
  projects,
  members,
}: {
  readonly workspaceId: string;
  readonly projects: readonly ProjectFilterOption[];
  readonly members: readonly MemberFilterOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const urlQuery = searchParams.get("query") ?? "";
  const [draftQuery, setDraftQuery] = useState(urlQuery);

  // Local input debounces into the URL so each pause — not each keystroke —
  // becomes one search request.
  useEffect(() => {
    if (draftQuery === urlQuery) return;
    const handle = window.setTimeout(() => {
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      if (draftQuery.trim() === "") params.delete("query");
      else params.set("query", draftQuery);
      params.delete("page");
      router.push(`${pathname}?${params.toString()}`);
    }, QUERY_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [draftQuery, urlQuery, searchParams, router, pathname]);

  // External navigation (command palette, recents, bookmarks) changes the URL
  // query; mirror it into the input without re-entering the debounce loop.
  useEffect(() => {
    setDraftQuery(urlQuery);
  }, [urlQuery]);

  const filterValues: SearchFilterValues = {
    projectId: searchParams.get("projectId") ?? "",
    authorId: searchParams.get("authorId") ?? "",
    createdFrom: searchParams.get("createdFrom") ?? "",
    createdTo: searchParams.get("createdTo") ?? "",
    updatedFrom: searchParams.get("updatedFrom") ?? "",
    updatedTo: searchParams.get("updatedTo") ?? "",
    hasAttachments:
      searchParams.get("hasAttachments") === "true" ||
      searchParams.get("hasAttachments") === "false"
        ? (searchParams.get("hasAttachments") as "true" | "false")
        : "",
    sortBy: parseSortBy(searchParams.get("sortBy")),
    sortDirection: parseSortDirection(searchParams.get("sortDirection")),
  };
  const pageNum = parsePage(searchParams.get("page"));
  const mode = parseMode(searchParams.get("mode"));
  const limit = SEARCH_PAGE_DEFAULT_LIMIT;

  const requestFilters: RequestFilters = {
    projectId: filterValues.projectId || undefined,
    authorId: filterValues.authorId || undefined,
    createdFrom: toIsoStart(filterValues.createdFrom),
    createdTo: toIsoEnd(filterValues.createdTo),
    updatedFrom: toIsoStart(filterValues.updatedFrom),
    updatedTo: toIsoEnd(filterValues.updatedTo),
    hasAttachments: filterValues.hasAttachments === "" ? undefined : filterValues.hasAttachments,
  };

  const searchInput: SearchPageInput = {
    query: urlQuery,
    mode,
    sortBy: filterValues.sortBy,
    sortDirection: filterValues.sortDirection,
    page: pageNum,
    limit,
    ...requestFilters,
  };

  const pageQuery = useQuery({
    queryKey: searchKeys.page(
      workspaceId,
      urlQuery,
      mode,
      requestFilters,
      filterValues.sortBy,
      filterValues.sortDirection,
      pageNum,
      limit,
    ),
    queryFn: async () => {
      const result = await requestSearchPage(workspaceId, searchInput);
      if (!result.ok) throw new SearchPageError(result.kind);
      return result.data;
    },
    enabled: urlQuery.trim().length > 0,
  });

  const hasMore = pageQuery.data?.hasMore ?? false;

  function updateParams(next: Record<string, string | undefined>, resetPage = true): void {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined || value === "") params.delete(key);
      else params.set(key, value);
    }
    if (resetPage && !("page" in next)) params.delete("page");
    router.push(`${pathname}?${params.toString()}`);
  }

  function handleFilterChange(next: Partial<SearchFilterValues>): void {
    updateParams(next as Record<string, string | undefined>);
  }

  function clearFilters(): void {
    updateParams({
      projectId: undefined,
      authorId: undefined,
      createdFrom: undefined,
      createdTo: undefined,
      updatedFrom: undefined,
      updatedTo: undefined,
      hasAttachments: undefined,
      sortBy: undefined,
      sortDirection: undefined,
    });
  }

  let status: SearchResultsStatus;
  if (urlQuery.trim().length === 0) {
    status = { kind: "no-query" };
  } else if (pageQuery.isLoading) {
    status = { kind: "loading" };
  } else if (pageQuery.isError) {
    const failureKind: ApiRequestFailureKind =
      pageQuery.error instanceof SearchPageError ? pageQuery.error.kind : "unavailable";
    status = {
      kind: "error",
      failureKind,
      onRetry: () => {
        void pageQuery.refetch();
      },
    };
  } else if (pageQuery.data !== undefined) {
    status = {
      kind: "ready",
      page: {
        items: pageQuery.data.items,
        total: pageQuery.data.total,
        hasMore: pageQuery.data.hasMore,
        availability: pageQuery.data.availability,
      },
    };
  } else {
    status = { kind: "loading" };
  }

  const showPagination = status.kind === "ready" && (hasMore || pageNum > 1);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <label className="text-sm font-medium" htmlFor="search-page-query">
          Search this workspace
        </label>
        <input
          id="search-page-query"
          type="text"
          value={draftQuery}
          onChange={(event) => setDraftQuery(event.target.value)}
          placeholder="Search notes by title or content"
          className="min-h-11 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Search mode</legend>
        <div className="flex flex-wrap gap-4">
          {(["full-text", "semantic", "hybrid"] as const).map((value) => (
            <label key={value} className="inline-flex min-h-11 items-center gap-2 text-sm">
              <input
                type="radio"
                name="search-mode"
                value={value}
                checked={mode === value}
                onChange={() => updateParams({ mode: value === "full-text" ? undefined : value })}
              />
              {value === "full-text" ? "Full text" : value === "semantic" ? "Semantic" : "Hybrid"}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Semantic and hybrid search may fall back when the optional embedding provider is
          unavailable.
        </p>
      </fieldset>

      <SearchFilters
        values={filterValues}
        projects={projects}
        members={members}
        onChange={handleFilterChange}
        onClear={clearFilters}
      />

      <SearchResults status={status} query={urlQuery} />

      {showPagination ? (
        <nav
          className="flex items-center justify-between gap-2"
          aria-label="Search results pagination"
        >
          <button
            type="button"
            disabled={pageNum <= 1}
            onClick={() => updateParams({ page: String(pageNum - 1) }, false)}
            className="inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            Previous page
          </button>
          <span className="text-sm text-muted-foreground" aria-live="polite">
            Page {pageNum}
          </span>
          <button
            type="button"
            disabled={!hasMore}
            onClick={() => updateParams({ page: String(pageNum + 1) }, false)}
            className="inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            Next page
          </button>
        </nav>
      ) : null}
    </div>
  );
}
