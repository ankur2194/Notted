// Part 52.2/52.3 — authorized search application service.
//
// This service owns the search use case. It:
//   1. Rejects semantic/hybrid modes with a safe `provider-unavailable`
//      availability (Parts 53/54 activate those modes; the route never 500s
//      for an unimplemented mode).
//   2. Returns a safe empty page when Meilisearch is disabled
//      (`FEATURE_SEARCH_ENABLED=false`).
//   3. For full-text: over-fetches bounded candidates, authorizes them via
//      `SearchResultRepository`, then takes the requested page slice. The API
//      `total` is the count of authorized items in THIS page; `hasMore`
//      reflects whether more authorized results existed beyond the page.
//   4. Splits Meilisearch `_formatted` strings into plain-text segments
//      wrapped with the `\u0000`/`\u0001` marker characters. The API never
//      returns HTML; the frontend bolds the marked segments.
//   5. Builds authoritative results with PostgreSQL-sourced
//      title/project/author/archive/template state. Falls back to safe labels
//      for deleted authors and nullified/deleted projects.
//
// Logging: structured logs carry only counts, latency bucket, mode, fallback,
// and request id. They NEVER carry the query, snippets, or note content.
//
// Concurrent deletion drift: if a Meilisearch hit is absent or soft-deleted in
// PostgreSQL, it is EXCLUDED from results (not thrown). Dispatching a repair
// intent would require the note-search-index producer inside a transaction;
// the read-only search path does not hold such a transaction, so we exclude
// silently and let the next note mutation converge the index. A best-effort
// drift count is logged for operator visibility.

import { Inject, Injectable, Optional } from "@nestjs/common";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { MeilisearchService } from "../infrastructure/meilisearch/meilisearch.service";

import { HybridSearchService } from "./hybrid-search.service";
import {
  HIGHLIGHT_POST_TAG,
  HIGHLIGHT_PRE_TAG,
  NoteIndexRepository,
  type NoteSearchCandidate,
} from "./note-index.repository";
import { SearchResultRepository, type NoteSearchFact } from "./search-result.repository";
import { SemanticSearchService } from "./semantic-search.service";

import type { WorkspaceRole } from "../authorization/authorization.contracts";
import type {
  AuthenticatedPrincipal,
  SearchAvailability,
  SearchHighlight,
  SearchPage,
  SearchResult,
  SearchSuggestion,
} from "@notted/shared-types";

/** Multiplier applied to the requested limit to over-fetch candidates. */
const OVERFETCH_MULTIPLIER = 4;
/** Hard cap on candidates fetched per request, regardless of limit. */
const MAX_CANDIDATES = 200;
/** Maximum number of highlight objects returned per result. */
const MAX_HIGHLIGHTS_PER_RESULT = 5;
/** Maximum snippet length surfaced in the API result. */
const MAX_SNIPPET_LENGTH = 280;
/** Maximum suggestion limit (the validator also bounds this). */
const MAX_SUGGESTION_LIMIT = 25;
/** Safe fallback label when the author row was deleted. */
const UNKNOWN_AUTHOR_LABEL = "Unknown author";

/** Application-facing search input. Already validated by the transport. */
export interface SearchServiceInput {
  readonly workspaceId: string;
  readonly query: string;
  readonly mode: "full-text" | "semantic" | "hybrid";
  readonly filters: {
    readonly projectId?: string;
    readonly authorId?: string;
    readonly hasAttachments?: boolean;
    readonly createdFrom?: number;
    readonly createdTo?: number;
    readonly updatedFrom?: number;
    readonly updatedTo?: number;
  };
  readonly sort: {
    readonly sortBy: "relevance" | "createdAt" | "updatedAt";
    readonly sortDirection: "asc" | "desc";
  };
  readonly page: number;
  readonly limit: number;
}

export interface SearchServicePrincipal {
  readonly principal: AuthenticatedPrincipal;
  readonly membershipRole: WorkspaceRole;
  readonly requestId?: string | null;
}

interface SearchLogEvent {
  readonly requestId: string | null | undefined;
  readonly mode: string;
  readonly fallback: string;
  readonly outcome: string;
  readonly durationMs: number;
  readonly candidateCount: number;
  readonly authorizedCount: number;
  readonly driftCount: number;
}

function modeUnavailableAvailability(): SearchAvailability {
  return Object.freeze({
    textSearchAvailable: true,
    mode: "full-text",
    fallback: "provider-unavailable",
  });
}

function disabledAvailability(): SearchAvailability {
  return Object.freeze({
    textSearchAvailable: false,
    mode: "full-text",
    fallback: "provider-unavailable",
  });
}

function fullTextAvailability(): SearchAvailability {
  return Object.freeze({
    textSearchAvailable: true,
    mode: "full-text",
    fallback: "none",
  });
}
function semanticAvailability(): SearchAvailability {
  return Object.freeze({ textSearchAvailable: true, mode: "semantic", fallback: "none" });
}
function semanticUnavailableAvailability(): SearchAvailability {
  return Object.freeze({
    textSearchAvailable: true,
    mode: "semantic",
    fallback: "provider-unavailable",
  });
}

function emptyPage(availability: SearchAvailability, page: number, limit: number): SearchPage {
  return Object.freeze({
    items: [],
    page,
    limit,
    total: 0,
    hasMore: false,
    availability,
  });
}

function latencyBucket(durationMs: number): string {
  if (durationMs < 25) return "lt25";
  if (durationMs < 100) return "lt100";
  if (durationMs < 500) return "lt500";
  if (durationMs < 2_000) return "lt2000";
  return "gte2000";
}

@Injectable()
export class SearchService {
  constructor(
    @Inject(MeilisearchService) private readonly meilisearch: MeilisearchService,
    private readonly noteIndex: NoteIndexRepository,
    private readonly searchResults: SearchResultRepository,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
    @Optional() private readonly semantic?: SemanticSearchService,
    @Optional() private readonly hybrid?: HybridSearchService,
  ) {}

  /**
   * Run an authorized search. The route guard has already authorized
   * `workspace.read` and the interceptor has established tenant scope; the
   * `workspaceId` here is the server-side proven tenant scope.
   */
  async search(input: SearchServiceInput, principal: SearchServicePrincipal): Promise<SearchPage> {
    const startedAt = Date.now();

    // 1. Reject not-yet-implemented modes safely (Parts 53/54 activate them).
    if (input.mode === "hybrid") {
      if (this.hybrid !== undefined && this.meilisearch.isEnabled())
        return this.hybrid.search(input, principal);
      this.logSearch({
        requestId: principal.requestId,
        mode: input.mode,
        fallback: "provider-unavailable",
        outcome: "mode_unavailable",
        durationMs: Date.now() - startedAt,
        candidateCount: 0,
        authorizedCount: 0,
        driftCount: 0,
      });
      return emptyPage(modeUnavailableAvailability(), input.page, input.limit);
    }
    if (input.mode === "semantic") return this.searchSemantic(input, principal, startedAt);

    // 2. Safe empty when search is disabled.
    if (!this.meilisearch.isEnabled()) {
      this.logSearch({
        requestId: principal.requestId,
        mode: input.mode,
        fallback: "provider-unavailable",
        outcome: "disabled",
        durationMs: Date.now() - startedAt,
        candidateCount: 0,
        authorizedCount: 0,
        driftCount: 0,
      });
      return emptyPage(disabledAvailability(), input.page, input.limit);
    }

    // 3. Scan stable provider windows from offset zero and paginate only after
    // authoritative authorization. Provider offsets cannot be derived from the
    // requested page because denied/stale candidates would otherwise overlap
    // pages and could make later authorized candidates unreachable.
    const pageOffset = (input.page - 1) * input.limit;
    const authorizedTarget = pageOffset + input.limit + 1;
    const windowSize = Math.min(MAX_CANDIDATES, Math.max(input.limit * OVERFETCH_MULTIPLIER, 25));
    const authorized: Array<{
      readonly candidate: NoteSearchCandidate;
      readonly fact: NoteSearchFact;
    }> = [];
    const seenIds = new Set<string>();
    let candidateCount = 0;
    let driftCount = 0;
    let providerOffset = 0;
    try {
      while (candidateCount < MAX_CANDIDATES && authorized.length < authorizedTarget) {
        const candidatePage = await this.noteIndex.search({
          workspaceId: input.workspaceId,
          query: input.query,
          filters: input.filters,
          sort: input.sort,
          offset: providerOffset,
          limit: Math.min(windowSize, MAX_CANDIDATES - candidateCount),
        });
        const candidates = candidatePage.candidates.filter(({ id }) => {
          if (seenIds.has(id)) return false;
          seenIds.add(id);
          return true;
        });
        candidateCount += candidatePage.candidates.length;
        const facts = await this.searchResults.loadFacts(
          candidates.map(({ id }) => id),
          {
            userId: principal.principal.userId,
            membershipRole: principal.membershipRole,
          },
        );
        driftCount += candidates.length - facts.size;
        for (const candidate of candidates) {
          const fact = facts.get(candidate.id);
          if (fact !== undefined) authorized.push({ candidate, fact });
        }

        const consumed = candidatePage.candidates.length;
        providerOffset += consumed;
        if (
          consumed === 0 ||
          providerOffset >= candidatePage.providerTotal ||
          consumed < candidatePage.limit
        )
          break;
      }
    } catch {
      // Provider failure: collapse to a safe empty page. The detailed error
      // was already collapsed inside `MeilisearchService.search`; we log only
      // safe counts and return no results so the UI can render the empty
      // state without surfacing provider internals.
      this.logSearch({
        requestId: principal.requestId,
        mode: input.mode,
        fallback: "provider-unavailable",
        outcome: "provider_error",
        durationMs: Date.now() - startedAt,
        candidateCount: 0,
        authorizedCount: 0,
        driftCount: 0,
      });
      return emptyPage(modeUnavailableAvailability(), input.page, input.limit);
    }

    const pageItems = authorized
      .slice(pageOffset, pageOffset + input.limit)
      .map(({ candidate, fact }) => this.buildResult(candidate, fact, input.workspaceId));
    const hasMore = authorized.length > pageOffset + input.limit;

    this.logSearch({
      requestId: principal.requestId,
      mode: input.mode,
      fallback: "none",
      outcome: "ok",
      durationMs: Date.now() - startedAt,
      candidateCount,
      authorizedCount: pageItems.length,
      driftCount,
    });

    return Object.freeze({
      items: pageItems,
      page: input.page,
      limit: input.limit,
      total: pageItems.length,
      hasMore,
      availability: fullTextAvailability(),
    });
  }

  private async searchSemantic(
    input: SearchServiceInput,
    principal: SearchServicePrincipal,
    startedAt: number,
  ): Promise<SearchPage> {
    if (this.semantic === undefined || !this.semantic.isAvailable())
      return emptyPage(semanticUnavailableAvailability(), input.page, input.limit);
    const pageOffset = (input.page - 1) * input.limit;
    const authorizedTarget = pageOffset + input.limit + 1;
    const windowSize = Math.min(MAX_CANDIDATES, Math.max(input.limit * OVERFETCH_MULTIPLIER, 25));
    const authorized: NoteSearchFact[] = [];
    const seenIds = new Set<string>();
    let candidateCount = 0;
    let driftCount = 0;
    let providerOffset = 0;
    try {
      while (candidateCount < MAX_CANDIDATES && authorized.length < authorizedTarget) {
        const ids = await this.semantic.candidates({
          query: input.query,
          filters: input.filters,
          offset: providerOffset,
          limit: Math.min(windowSize, MAX_CANDIDATES - candidateCount),
        });
        const uniqueIds = ids.filter((id) => {
          if (seenIds.has(id)) return false;
          seenIds.add(id);
          return true;
        });
        candidateCount += ids.length;
        const facts = await this.searchResults.loadFacts(uniqueIds, {
          userId: principal.principal.userId,
          membershipRole: principal.membershipRole,
        });
        driftCount += uniqueIds.length - facts.size;
        for (const id of uniqueIds) {
          const fact = facts.get(id);
          if (fact !== undefined) authorized.push(fact);
        }
        providerOffset += ids.length;
        if (ids.length === 0 || ids.length < windowSize) break;
      }
    } catch {
      this.logSearch({
        requestId: principal.requestId,
        mode: "semantic",
        fallback: "provider-unavailable",
        outcome: "provider_error",
        durationMs: Date.now() - startedAt,
        candidateCount: 0,
        authorizedCount: 0,
        driftCount: 0,
      });
      return emptyPage(semanticUnavailableAvailability(), input.page, input.limit);
    }
    const items = authorized
      .slice(pageOffset, pageOffset + input.limit)
      .map((fact) => this.buildSemanticResult(fact, input.workspaceId));
    this.logSearch({
      requestId: principal.requestId,
      mode: "semantic",
      fallback: "none",
      outcome: "ok",
      durationMs: Date.now() - startedAt,
      candidateCount,
      authorizedCount: items.length,
      driftCount,
    });
    return Object.freeze({
      items,
      page: input.page,
      limit: input.limit,
      total: items.length,
      hasMore: authorized.length > pageOffset + input.limit,
      availability: semanticAvailability(),
    });
  }

  private buildSemanticResult(fact: NoteSearchFact, workspaceId: string): SearchResult {
    return Object.freeze({
      noteId: fact.noteId,
      workspaceId,
      projectId: fact.projectId,
      authorId: fact.createdById,
      authorName: fact.authorName ?? UNKNOWN_AUTHOR_LABEL,
      projectTitle: fact.projectTitle,
      title: fact.title,
      updatedAt: fact.updatedAt.toISOString(),
      createdAt: fact.createdAt.toISOString(),
      isArchived: fact.isArchived,
      isTemplate: fact.isTemplate,
      hasAttachments: fact.hasAttachments,
      highlights: [],
      snippet: "",
    });
  }

  /**
   * Authorized title/prefix suggestions for the Cmd/Ctrl+K experience.
   * Same disabled/mode handling as {@link search}; the suggestion list is
   * narrower (noteId + title + updatedAt).
   */
  async suggest(
    input: {
      readonly workspaceId: string;
      readonly query: string;
      readonly limit: number;
    },
    principal: SearchServicePrincipal,
  ): Promise<readonly SearchSuggestion[]> {
    if (!this.meilisearch.isEnabled()) return [];
    const limit = Math.min(MAX_SUGGESTION_LIMIT, Math.max(1, input.limit));
    let candidates: readonly NoteSearchCandidate[];
    try {
      const candidatePage = await this.noteIndex.search({
        workspaceId: input.workspaceId,
        query: input.query,
        filters: {},
        sort: { sortBy: "relevance", sortDirection: "desc" },
        offset: 0,
        // Over-fetch for authorization the same way the main search does, so
        // a few restricted notes do not empty out the suggestion list.
        limit: Math.min(MAX_CANDIDATES, limit * OVERFETCH_MULTIPLIER),
      });
      candidates = candidatePage.candidates;
    } catch {
      return [];
    }
    const facts = await this.searchResults.loadFacts(
      candidates.map((candidate) => candidate.id),
      {
        userId: principal.principal.userId,
        membershipRole: principal.membershipRole,
      },
    );
    const suggestions: SearchSuggestion[] = [];
    for (const candidate of candidates) {
      const fact = facts.get(candidate.id);
      if (fact === undefined) continue;
      suggestions.push(
        Object.freeze({
          noteId: fact.noteId,
          title: fact.title,
          updatedAt: fact.updatedAt.toISOString(),
        }),
      );
      if (suggestions.length >= limit) break;
    }
    return suggestions;
  }

  // ----------------------------------------------------------------------- //
  // Internals
  // ----------------------------------------------------------------------- //

  private buildResult(
    candidate: NoteSearchCandidate,
    fact: NoteSearchFact,
    workspaceId: string,
  ): SearchResult {
    return Object.freeze({
      noteId: fact.noteId,
      workspaceId,
      projectId: fact.projectId,
      authorId: fact.createdById,
      authorName: fact.authorName ?? UNKNOWN_AUTHOR_LABEL,
      projectTitle: fact.projectTitle,
      title: fact.title,
      updatedAt: fact.updatedAt.toISOString(),
      createdAt: fact.createdAt.toISOString(),
      isArchived: fact.isArchived,
      isTemplate: fact.isTemplate,
      hasAttachments: fact.hasAttachments,
      highlights: this.buildHighlights(candidate),
      snippet: this.buildSnippet(candidate),
    });
  }

  /**
   * Build highlight objects from the candidate's `_formatted` strings. The
   * `\u0000`/`\u0001` markers remain in the snippet; the frontend splits on
   * them to render bold segments. We cap to the API limit after preserving
   * the field order (title → content → first matching tag).
   */
  private buildHighlights(candidate: NoteSearchCandidate): readonly SearchHighlight[] {
    const out: SearchHighlight[] = [];
    if (candidate.formattedTitle.length > 0) {
      out.push(
        Object.freeze({ field: "title", snippet: this.trimSnippet(candidate.formattedTitle) }),
      );
    }
    if (candidate.formattedContent.length > 0) {
      out.push(
        Object.freeze({ field: "content", snippet: this.trimSnippet(candidate.formattedContent) }),
      );
    }
    for (const tag of candidate.formattedTags) {
      if (tag.includes(HIGHLIGHT_PRE_TAG) || tag.includes(HIGHLIGHT_POST_TAG)) {
        out.push(Object.freeze({ field: "tag", snippet: this.trimSnippet(tag) }));
        break;
      }
    }
    return Object.freeze(out.slice(0, MAX_HIGHLIGHTS_PER_RESULT));
  }

  private buildSnippet(candidate: NoteSearchCandidate): string {
    // Prefer the formatted content (already highlight-marked and provider
    // truncated). Fall back to the plain contentSnippet, then the title.
    if (candidate.formattedContent.length > 0) {
      return this.trimSnippet(candidate.formattedContent);
    }
    if (candidate.contentSnippet.length > 0) {
      return this.trimSnippet(candidate.contentSnippet);
    }
    return this.trimSnippet(candidate.formattedTitle);
  }

  private trimSnippet(value: string): string {
    return value.length > MAX_SNIPPET_LENGTH ? value.slice(0, MAX_SNIPPET_LENGTH) : value;
  }

  private logSearch(event: SearchLogEvent): void {
    this.logger.info(
      {
        // Only safe counts and routing metadata. The query, snippets, note
        // ids, titles, and content are NEVER logged.
        searchMode: event.mode,
        searchFallback: event.fallback,
        searchOutcome: event.outcome,
        searchLatencyBucket: latencyBucket(event.durationMs),
        searchCandidateCount: event.candidateCount,
        searchAuthorizedCount: event.authorizedCount,
        searchDriftCount: event.driftCount,
        ...(event.requestId === undefined || event.requestId === null
          ? {}
          : { requestId: event.requestId }),
      },
      "Search executed",
    );
  }
}

/**
 * Re-export the highlight marker characters so consumers (tests, frontend
 * type packs, future services) can split formatted snippets without importing
 * repository internals. The marker pair is stable for the lifetime of the v1
 * index contract.
 */
export const SEARCH_HIGHLIGHT_PRE_TAG = HIGHLIGHT_PRE_TAG;
export const SEARCH_HIGHLIGHT_POST_TAG = HIGHLIGHT_POST_TAG;
