"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import type { ApiRequestFailureKind } from "@/lib/api/request-json";
import type { RecentSearch, SearchSuggestion } from "@notted/shared-types";
import type { KeyboardEvent, ReactNode } from "react";

import { DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { renderHighlightSegments } from "@/lib/search/highlights";
import { searchKeys } from "@/lib/search/query-keys";
import {
  clearRecentSearches,
  readRecentSearches,
  recordRecentSearch,
} from "@/lib/search/recent-searches";
import { requestSearchSuggestions, SEARCH_SUGGESTION_DEFAULT_LIMIT } from "@/lib/search/requests";

/**
 * Debounce window for the suggestion fetch. Typed keystrokes never enter a
 * global store: the raw query lives only in this component's state, and the
 * network call fires once per pause rather than once per keystroke.
 */
const DEBOUNCE_MS = 200;
/** How many suggestions to request for the dropdown fast path. */
const SUGGESTION_LIMIT = SEARCH_SUGGESTION_DEFAULT_LIMIT;
/** Largest list the palette ever renders; defensive against a wider response. */
const SUGGESTION_RENDER_LIMIT = 8;
/** Mirrors `searchQuerySchema.query`'s upper bound for recent-search recording. */
const RECENT_QUERY_MAX_LENGTH = 500;

/**
 * Carries the stable failure vocabulary so the UI can distinguish a temporary
 * outage ("temporarily unavailable") from a denial. Never carries content.
 */
class SearchRequestError extends Error {
  constructor(readonly kind: ApiRequestFailureKind) {
    super("search request failed");
    this.name = "SearchRequestError";
  }
}

function browserStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

/** Normalize a raw query the same way recent-searches does, for recording. */
function normalizeForRecent(query: string): string {
  const normalized = query.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > RECENT_QUERY_MAX_LENGTH) return "";
  return normalized;
}

/**
 * Render plain-text segments produced by `renderHighlightSegments`. Matched
 * spans become `<mark>`; plain spans render as-is. Never emits HTML.
 */
function HighlightedText({ snippet }: { readonly snippet: string }): ReactNode {
  const segments = renderHighlightSegments(snippet);
  if (segments.length === 0) return null;
  return (
    <>
      {segments.map((segment, index) =>
        segment.matched ? (
          <mark key={index} className="rounded-sm bg-primary/20 text-foreground">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

export function GlobalSearchDialog({
  workspaceId,
  open,
  onOpenChange,
}: {
  readonly workspaceId: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebancedQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recents, setRecents] = useState<readonly RecentSearch[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Listbox/combobox wiring. `useId` keeps ids stable across hydration.
  const reactId = useId();
  const listboxId = `${reactId}-listbox`;
  const optionId = (index: number): string => `${reactId}-option-${index}`;

  // Debounce the typed query. Only the debounced value drives the network.
  useEffect(() => {
    if (!open) return;
    const handle = window.setTimeout(() => setDebancedQuery(query), DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query, open]);

  // Reset state on close and load recents on open. Reading storage in an effect
  // keeps SSR and the first paint free of localStorage access.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebancedQuery("");
      setActiveIndex(0);
      return;
    }
    setRecents(workspaceId === null ? [] : readRecentSearches(workspaceId, browserStorage()));
  }, [open, workspaceId]);

  // Move focus into the input reliably once the palette mounts. Radix renders
  // the content after `open` flips, so a rAF lands after the paint.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const suggestionsQuery = useQuery({
    queryKey: searchKeys.suggestions(workspaceId ?? "", debouncedQuery, SUGGESTION_LIMIT),
    queryFn: async (): Promise<readonly SearchSuggestion[]> => {
      if (workspaceId === null) return [];
      const result = await requestSearchSuggestions(workspaceId, debouncedQuery, SUGGESTION_LIMIT);
      if (!result.ok) throw new SearchRequestError(result.kind);
      return result.data;
    },
    enabled: workspaceId !== null && debouncedQuery.trim().length > 0,
  });

  const suggestions = (suggestionsQuery.data ?? []).slice(0, SUGGESTION_RENDER_LIMIT);
  const showSuggestions = workspaceId !== null && debouncedQuery.trim().length > 0;
  const requestError =
    suggestionsQuery.error instanceof SearchRequestError ? suggestionsQuery.error : null;
  const isUnavailable =
    requestError !== null &&
    (requestError.kind === "unavailable" || requestError.kind === "forbidden-or-not-found");

  // Keep the active option inside the rendered list as suggestions arrive.
  useEffect(() => {
    setActiveIndex(0);
  }, [debouncedQuery]);

  const safeActiveIndex =
    suggestions.length === 0 ? -1 : Math.min(activeIndex, suggestions.length - 1);

  function navigateToQuery(rawQuery: string): void {
    if (workspaceId === null) return;
    const trimmed = rawQuery.trim();
    if (trimmed.length === 0) return;
    const normalized = normalizeForRecent(rawQuery);
    if (normalized.length > 0) {
      setRecents(recordRecentSearch(workspaceId, normalized, browserStorage()));
    }
    onOpenChange(false);
    // Navigate with the trimmed query; the backend trims again, and recording
    // uses the whitespace-collapsed form so recents stay unique.
    router.push(`/workspaces/${workspaceId}/search?query=${encodeURIComponent(trimmed)}`);
  }

  function navigateToNote(noteId: string, rawQuery: string): void {
    if (workspaceId === null) return;
    const normalized = normalizeForRecent(rawQuery);
    if (normalized.length > 0) {
      setRecents(recordRecentSearch(workspaceId, normalized, browserStorage()));
    }
    onOpenChange(false);
    router.push(`/workspaces/${workspaceId}/notes/${noteId}`);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      if (suggestions.length === 0) return;
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % suggestions.length);
      return;
    }
    if (event.key === "ArrowUp") {
      if (suggestions.length === 0) return;
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const trimmed = query.trim();
      if (workspaceId === null || trimmed.length === 0) return;
      const active = safeActiveIndex >= 0 ? suggestions[safeActiveIndex] : undefined;
      if (active !== undefined) navigateToNote(active.noteId, trimmed);
      else navigateToQuery(trimmed);
    }
  }

  function fillRecent(value: string): void {
    setQuery(value);
    setDebancedQuery(value);
    inputRef.current?.focus();
  }

  function clearRecents(): void {
    if (workspaceId === null) return;
    clearRecentSearches(workspaceId, browserStorage());
    setRecents([]);
  }

  const listExpanded = showSuggestions && suggestions.length > 0;
  const statusText = statusMessage({
    showSuggestions,
    loading: suggestionsQuery.isLoading,
    fetching: suggestionsQuery.isFetching,
    count: suggestions.length,
    error: requestError,
    unavailable: isUnavailable,
  });

  return (
    <DialogContent className="left-1/2 top-[10vh] max-h-[80vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-0 gap-0 p-0">
      <DialogTitle className="sr-only">Search notes</DialogTitle>
      <DialogDescription className="sr-only">
        Search notes in this workspace and open a result, or see every result on the full search
        page.
      </DialogDescription>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Search aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={workspaceId === null}
          aria-label="Search notes"
          role="combobox"
          aria-expanded={listExpanded}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={safeActiveIndex >= 0 ? optionId(safeActiveIndex) : undefined}
          aria-busy={suggestionsQuery.isFetching}
          placeholder={
            workspaceId === null ? "Select a workspace first" : "Search notes by title or content"
          }
          className="min-h-11 flex-1 bg-transparent pr-10 text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
        />
        {suggestionsQuery.isFetching && workspaceId !== null && debouncedQuery.trim().length > 0 ? (
          <Loader2
            aria-hidden="true"
            className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
          />
        ) : null}
      </div>

      <div className="max-h-[60vh] overflow-y-auto overscroll-contain p-2">
        {workspaceId === null ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground" role="status">
            Select a workspace first to search its notes.
          </p>
        ) : !showSuggestions ? (
          <Recents recents={recents} onPick={fillRecent} onClear={clearRecents} />
        ) : isUnavailable ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground" role="status">
            Search is temporarily unavailable. Try again in a moment.
          </p>
        ) : requestError !== null ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground" role="alert">
            We could not complete this search. Check your connection and try again.
          </p>
        ) : suggestionsQuery.isLoading ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground" role="status">
            Searching…
          </p>
        ) : suggestions.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground" role="status">
            No notes match &ldquo;{debouncedQuery}&rdquo;.
          </p>
        ) : (
          <ul id={listboxId} role="listbox" aria-label="Suggested notes" className="space-y-1">
            {suggestions.map((suggestion, index) => (
              <li key={suggestion.noteId} role="presentation">
                <button
                  type="button"
                  role="option"
                  id={optionId(index)}
                  aria-selected={index === safeActiveIndex}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => navigateToNote(suggestion.noteId, query)}
                  className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    index === safeActiveIndex ? "bg-accent" : "hover:bg-accent/60"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">
                    <HighlightedText snippet={suggestion.title} />
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatDate(suggestion.updatedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {showSuggestions && !isUnavailable && requestError === null && query.trim().length > 0 ? (
          <div className="mt-1 border-t pt-1">
            <button
              type="button"
              onClick={() => navigateToQuery(query)}
              className="min-h-11 w-full rounded-md px-3 py-2 text-left text-sm text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              See all results for &ldquo;{query.trim()}&rdquo;
            </button>
          </div>
        ) : null}
      </div>

      {statusText === "" ? null : (
        <p className="sr-only" role="status" aria-live="polite">
          {statusText}
        </p>
      )}
    </DialogContent>
  );
}

/**
 * Recent-searches block. Renders only when the query is empty so it never
 * competes with live suggestions.
 */
function Recents({
  recents,
  onPick,
  onClear,
}: {
  readonly recents: readonly RecentSearch[];
  readonly onPick: (value: string) => void;
  readonly onClear: () => void;
}) {
  if (recents.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-sm text-muted-foreground" role="status">
        Start typing to search, or press Enter to see every result.
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-3 py-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Recent searches
        </p>
        <button
          type="button"
          onClick={onClear}
          className="min-h-9 rounded px-2 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Clear recent searches
        </button>
      </div>
      <ul className="space-y-1">
        {recents.map((recent) => (
          <li key={`${recent.query}-${recent.recordedAt}`}>
            <button
              type="button"
              onClick={() => onPick(recent.query)}
              className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm outline-none hover:bg-accent/60 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{recent.query}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatDate(recent.recordedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function statusMessage(state: {
  readonly showSuggestions: boolean;
  readonly loading: boolean;
  readonly fetching: boolean;
  readonly count: number;
  readonly error: SearchRequestError | null;
  readonly unavailable: boolean;
}): string {
  // The visible inline messages already expose their own role="status"/"alert",
  // so this sr-only region announces only the one state they do not cover: the
  // suggestion count when results are present. Returning "" otherwise keeps a
  // single live-region source per state and avoids a double announcement.
  if (!state.showSuggestions) return "";
  if (state.unavailable || state.error !== null || state.loading) return "";
  if (state.count === 0) return "";
  if (state.fetching) return `Loading suggestions, ${state.count} shown.`;
  return `${state.count} suggestion${state.count === 1 ? "" : "s"}`;
}

/**
 * Format an ISO timestamp as a short, stable date. The palette renders
 * client-side only (the dialog mounts on open), so locale formatting cannot
 * cause a hydration mismatch.
 */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}
