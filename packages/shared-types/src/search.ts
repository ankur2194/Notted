import type { IsoTimestamp, NoteId, ProjectId, UserId, WorkspaceId } from "./common";

// --------------------------------------------------------------------------- //
// API path contract — mirrors the NOTE_API_PATHS pattern in `./note.ts`.
// --------------------------------------------------------------------------- //

export const SEARCH_API_PATHS = Object.freeze({
  collection: (workspaceId: WorkspaceId) => `/api/v1/workspaces/${workspaceId}/search`,
  suggestions: (workspaceId: WorkspaceId) => `/api/v1/workspaces/${workspaceId}/search/suggestions`,
} as const);

// --------------------------------------------------------------------------- //
// Search mode and output contracts (mirror the Zod schemas in
// `@notted/shared-validators/src/search.schema.ts`).
// --------------------------------------------------------------------------- //

export type SearchMode = "full-text" | "semantic" | "hybrid";

export type SearchSort = "relevance" | "createdAt" | "updatedAt";
export type SearchSortDirection = "asc" | "desc";

/**
 * Plain-text highlight segment for a single field. `snippet` is NEVER HTML:
 * it carries plain text plus the `\u0000`/`\u0001` marker characters around
 * matched terms. The frontend renders bold by splitting on the markers.
 */
export interface SearchHighlight {
  readonly field: "title" | "content" | "tag";
  readonly snippet: string;
}

/**
 * A single authorized search result. Every field is sourced from
 * authoritative PostgreSQL state (not the search provider). `isArchived` and
 * `isTemplate` are labels only: archived and template notes remain SEARCHABLE
 * per the Part 51 index policy; they are surfaced to the client so the UI can
 * badge them.
 */
export interface SearchResult {
  readonly noteId: NoteId;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId | null;
  readonly authorId: UserId;
  readonly authorName: string;
  readonly projectTitle: string | null;
  readonly title: string;
  readonly updatedAt: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
  readonly isArchived: boolean;
  readonly isTemplate: boolean;
  readonly hasAttachments: boolean;
  readonly highlights: readonly SearchHighlight[];
  readonly snippet: string;
}

/** Backward-compatible summary name retained for existing public barrel consumers. */
export type SearchResultSummary = SearchResult;

/**
 * Search availability flags. Used by the client to decide how to render empty
 * states ("search is disabled", "semantic mode not yet available", etc.).
 */
export interface SearchAvailability {
  readonly textSearchAvailable: boolean;
  /** Which mode produced (or would have produced) the results. */
  readonly mode: SearchMode;
  readonly fallback: "none" | "text-only" | "provider-unavailable";
}

/**
 * A search response page. `total` is the count of authorized items returned in
 * `items` for THIS page (NOT the raw provider total, which can over-count
 * because of access filtering). `hasMore` reflects whether at least one more
 * authorized result existed beyond this page.
 */
export interface SearchPage {
  readonly items: readonly SearchResult[];
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
  readonly availability: SearchAvailability;
}

/** Title/prefix suggestion for the Cmd/Ctrl+K experience. */
export interface SearchSuggestion {
  readonly noteId: NoteId;
  readonly title: string;
  readonly updatedAt: IsoTimestamp;
}

// --------------------------------------------------------------------------- //
// Recent searches — BROWSER-LOCAL contract. The backend never persists or
// transports these values; this type is shared so the frontend localStorage
// shape is stable and a future sync surface could consume the same format.
// --------------------------------------------------------------------------- //

export interface RecentSearch {
  readonly query: string;
  readonly recordedAt: IsoTimestamp;
}

export interface RecentSearchesPayload {
  readonly items: readonly RecentSearch[];
  readonly version: 1;
}
