"use client";

import { Archive, FileText, Link2, Paperclip } from "lucide-react";
import Link from "next/link";

import type { ApiRequestFailureKind } from "@/lib/api/request-json";
import type { SearchAvailability, SearchHighlight, SearchResult } from "@notted/shared-types";
import type { ReactNode } from "react";

import { renderHighlightSegments } from "@/lib/search/highlights";

/**
 * The states the result list can be in. `unavailable` is separated from
 * `error` because the backend signals a provider outage via
 * `availability.fallback === "provider-unavailable"` (Parts 53/54 not
 * operational yet): the request succeeds but carries no items, and the message
 * must say "temporarily unavailable" rather than "no matches".
 */
export type SearchResultsStatus =
  | { readonly kind: "loading" }
  | {
      readonly kind: "error";
      readonly failureKind: ApiRequestFailureKind;
      readonly onRetry: () => void;
    }
  | { readonly kind: "ready"; readonly page: SearchPageData }
  | { readonly kind: "no-query" };

interface SearchPageData {
  readonly items: readonly SearchResult[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly availability: SearchAvailability;
}

/** Pick the `title` highlight snippet when present, else fall back to the title. */
function titleSnippet(result: SearchResult): string {
  const match = result.highlights.find(
    (highlight: SearchHighlight): boolean => highlight.field === "title",
  );
  return match === undefined ? result.title : match.snippet;
}

/**
 * Render plain-text highlight segments. Matched spans become `<mark>`; plain
 * spans render as-is. Never emits HTML and never uses `dangerouslySetInnerHTML`.
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

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/**
 * One search result. Archived and template notes remain searchable by design
 * (Part 51 index policy): they are badged so the reader can tell them apart
 * from ordinary notes before opening.
 */
function ResultRow({ result }: { readonly result: SearchResult }) {
  return (
    <li>
      <Link
        href={`/workspaces/${result.workspaceId}/notes/${result.noteId}`}
        className="block rounded-lg border bg-card p-4 outline-none transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">
            <HighlightedText snippet={titleSnippet(result)} />
          </h3>
          {result.isArchived ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              <Archive aria-hidden="true" className="size-3" />
              Archived
            </span>
          ) : null}
          {result.isTemplate ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              <FileText aria-hidden="true" className="size-3" />
              Template
            </span>
          ) : null}
          {result.hasAttachments ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Paperclip aria-hidden="true" className="size-3" />
              <span className="sr-only">Has attachments</span>
            </span>
          ) : null}
        </div>
        {result.snippet.length > 0 ? (
          <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
            <HighlightedText snippet={result.snippet} />
          </p>
        ) : null}
        <dl className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <dt className="sr-only">Author</dt>
            <dd>{result.authorName}</dd>
          </div>
          {result.projectTitle !== null ? (
            <div className="flex items-center gap-1">
              <dt className="sr-only">Project</dt>
              <dd className="inline-flex items-center gap-1">
                <Link2 aria-hidden="true" className="size-3" />
                {result.projectTitle}
              </dd>
            </div>
          ) : null}
          <div className="flex items-center gap-1">
            <dt className="sr-only">Last updated</dt>
            <dd>
              <time dateTime={result.updatedAt}>{formatDateTime(result.updatedAt)}</time>
            </dd>
          </div>
        </dl>
      </Link>
    </li>
  );
}

function LoadingRows(): ReactNode {
  return (
    <ul aria-label="Loading results" className="space-y-3">
      {Array.from({ length: 3 }, (_unused, index) => (
        <li key={index} className="rounded-lg border bg-card p-4" aria-hidden="true">
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          <div className="mt-3 h-3 w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
          <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        </li>
      ))}
    </ul>
  );
}

export function SearchResults({
  status,
  query,
}: {
  readonly status: SearchResultsStatus;
  readonly query: string;
}) {
  if (status.kind === "no-query") {
    return (
      <p
        className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground"
        role="status"
      >
        Enter a search term to find notes across this workspace.
      </p>
    );
  }

  if (status.kind === "loading") {
    return (
      <div aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading search results.</span>
        <LoadingRows />
      </div>
    );
  }

  if (status.kind === "error") {
    const retryable =
      status.failureKind === "unavailable" || status.failureKind === "forbidden-or-not-found";
    const message =
      status.failureKind === "unavailable"
        ? "Search could not reach Notted. Check your connection and try again."
        : status.failureKind === "forbidden-or-not-found"
          ? "Search is unavailable for this workspace."
          : "Search could not be completed.";
    return (
      <div
        className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive"
        role="alert"
      >
        <p className="font-medium">Search failed</p>
        <p className="mt-1">{message}</p>
        {retryable ? (
          <button
            type="button"
            onClick={status.onRetry}
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Retry
          </button>
        ) : null}
      </div>
    );
  }

  const { page } = status;

  // A disabled or unavailable provider is a capability state, not "no match".
  if (page.availability.fallback === "provider-unavailable") {
    return (
      <div
        className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground"
        role="status"
      >
        <p className="font-medium text-foreground">Search is temporarily unavailable</p>
        <p className="mt-1">
          {page.availability.mode === "semantic"
            ? "Semantic search could not run right now. Choose full text or try again in a moment."
            : "Full-text search could not run right now. Try again in a moment."}
        </p>
      </div>
    );
  }

  if (page.items.length === 0) {
    return (
      <p
        className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground"
        role="status"
      >
        {query.trim().length === 0
          ? "Enter a search term to find notes across this workspace."
          : `No notes match “${query.trim()}”.`}
      </p>
    );
  }

  return (
    <div>
      {page.availability.fallback === "text-only" ? (
        <p
          className="mb-3 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground"
          role="status"
        >
          Semantic matching is temporarily unavailable. Showing full-text results instead.
        </p>
      ) : null}
      <p className="mb-3 text-sm text-muted-foreground" aria-live="polite">
        {page.total} {page.total === 1 ? "note" : "notes"}
        {page.hasMore ? " (showing the first page)" : ""}
      </p>
      <ul className="space-y-3">
        {page.items.map((result) => (
          <ResultRow key={result.noteId} result={result} />
        ))}
      </ul>
    </div>
  );
}
