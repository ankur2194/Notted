import { Inject, Injectable, Optional } from "@nestjs/common";

import { StructuredLogger } from "../common/logging/structured-logger.service";

import { HybridRankingService } from "./hybrid-ranking.service";
import { NoteIndexRepository } from "./note-index.repository";
import { SearchResultRepository, type NoteSearchFact } from "./search-result.repository";
import { SemanticSearchService } from "./semantic-search.service";

import type { NoteSearchCandidate } from "./note-index.repository";
import type { SearchServiceInput, SearchServicePrincipal } from "./search.service";
import type { SearchPage, SearchResult } from "@notted/shared-types";

export const HYBRID_SEARCH_CLOCK = Symbol("HYBRID_SEARCH_CLOCK");
export type HybridSearchClock = () => number;
export const HYBRID_CANDIDATE_MULTIPLIER = 4;
export const HYBRID_MAX_CANDIDATES = 200;

function bucket(ms: number): string {
  if (ms < 25) return "lt25";
  if (ms < 100) return "lt100";
  if (ms < 500) return "lt500";
  if (ms < 2_000) return "lt2000";
  return "gte2000";
}

@Injectable()
export class HybridSearchService {
  private readonly now: HybridSearchClock;

  constructor(
    private readonly noteIndex: NoteIndexRepository,
    private readonly semantic: SemanticSearchService,
    private readonly results: SearchResultRepository,
    private readonly ranker: HybridRankingService,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
    @Optional() @Inject(HYBRID_SEARCH_CLOCK) clock?: HybridSearchClock,
  ) {
    this.now = clock ?? Date.now;
  }

  async search(input: SearchServiceInput, principal: SearchServicePrincipal): Promise<SearchPage> {
    const started = this.now();
    // Retrieve the same bounded top window for every page, then paginate only
    // after the two sources are normalized, merged, authorized, and sorted.
    // Applying a provider offset before hybrid ranking changes each page's
    // normalization population and can duplicate or reorder results.
    const pageOffset = (input.page - 1) * input.limit;
    const depth = Math.min(
      HYBRID_MAX_CANDIDATES,
      Math.max(input.limit * HYBRID_CANDIDATE_MULTIPLIER, pageOffset + input.limit + 1),
    );
    const semanticAvailable = this.semantic.isAvailable();
    const lexicalStarted = this.now();
    const lexicalPromise = this.noteIndex.search({ ...input, offset: 0, limit: depth });
    const semanticStarted = this.now();
    const semanticPromise = semanticAvailable
      ? this.semantic.rankedCandidates({
          query: input.query,
          filters: input.filters,
          offset: 0,
          limit: depth,
        })
      : Promise.resolve([]);
    const [lexicalSettled, semanticSettled] = await Promise.allSettled([
      lexicalPromise,
      semanticPromise,
    ]);
    const lexicalMs = this.now() - lexicalStarted;
    const semanticMs = semanticAvailable ? this.now() - semanticStarted : 0;

    // Lexical is the safe baseline. We deliberately do not return semantic-only
    // results when it fails, so an index outage cannot masquerade as success.
    if (lexicalSettled.status === "rejected") {
      return this.unavailable(
        input,
        principal,
        started,
        lexicalMs,
        semanticMs,
        semanticSettled.status === "rejected",
      );
    }
    const lexical = lexicalSettled.value.candidates;
    const semanticOutage = semanticAvailable && semanticSettled.status === "rejected";
    const semantic = semanticSettled.status === "fulfilled" ? semanticSettled.value : [];
    const merged = this.ranker.merge(
      lexical.map((candidate, rank) => ({
        id: candidate.id,
        rawScore: candidate.rankingScore,
        rank,
      })),
      semantic,
    );
    const candidateIds = merged.map(({ id }) => id);
    const authorizationStarted = this.now();
    const facts = await this.results.loadFacts(candidateIds, {
      userId: principal.principal.userId,
      membershipRole: principal.membershipRole,
    });
    const authorizationMs = this.now() - authorizationStarted;
    const rankingStarted = this.now();
    const ranked = this.ranker.finalize(
      merged,
      new Map([...facts].map(([id, fact]) => [id, { id, updatedAt: fact.updatedAt }])),
    );
    const rankingMs = this.now() - rankingStarted;
    const lexicalById = new Map(lexical.map((candidate) => [candidate.id, candidate]));
    // Thread the authorized fact through the slice so the result builder never
    // needs a non-null assertion: only candidates whose fact loaded AND whose
    // `hasAttachments` matches the request survive the type guard below.
    const authorized = ranked
      .map(({ id }) => ({ id, fact: facts.get(id) }))
      .filter(
        (entry): entry is { readonly id: string; readonly fact: NoteSearchFact } =>
          entry.fact !== undefined &&
          (input.filters.hasAttachments === undefined ||
            entry.fact.hasAttachments === input.filters.hasAttachments),
      );
    const items = authorized
      .slice(pageOffset, pageOffset + input.limit)
      .map(({ id, fact }) => this.result(fact, lexicalById.get(id), input.workspaceId));
    const fallback = semanticAvailable && !semanticOutage ? "none" : "text-only";
    this.log({
      input,
      principal,
      fallback,
      started,
      lexicalMs,
      semanticMs,
      authorizationMs,
      rankingMs,
      lexicalCount: lexical.length,
      semanticCount: semantic.length,
      candidateCount: merged.length,
      resultCount: items.length,
      semanticOutage,
      lexicalOutage: false,
    });
    return Object.freeze({
      items,
      page: input.page,
      limit: input.limit,
      total: items.length,
      hasMore: authorized.length > pageOffset + input.limit,
      availability: {
        textSearchAvailable: true,
        mode: fallback === "none" ? ("hybrid" as const) : ("full-text" as const),
        fallback: fallback === "none" ? ("none" as const) : ("text-only" as const),
      },
    });
  }

  private unavailable(
    input: SearchServiceInput,
    principal: SearchServicePrincipal,
    started: number,
    lexicalMs: number,
    semanticMs: number,
    semanticOutage: boolean,
  ): SearchPage {
    this.log({
      input,
      principal,
      fallback: "provider-unavailable",
      started,
      lexicalMs,
      semanticMs,
      authorizationMs: 0,
      rankingMs: 0,
      lexicalCount: 0,
      semanticCount: 0,
      candidateCount: 0,
      resultCount: 0,
      semanticOutage,
      lexicalOutage: true,
    });
    return Object.freeze({
      items: [],
      page: input.page,
      limit: input.limit,
      total: 0,
      hasMore: false,
      availability: {
        textSearchAvailable: false,
        mode: "full-text" as const,
        fallback: "provider-unavailable" as const,
      },
    });
  }

  private result(
    fact: NoteSearchFact,
    lexical: NoteSearchCandidate | undefined,
    workspaceId: string,
  ): SearchResult {
    const highlights =
      lexical === undefined
        ? []
        : [
            ...(lexical.formattedTitle
              ? [{ field: "title" as const, snippet: lexical.formattedTitle.slice(0, 280) }]
              : []),
            ...(lexical.formattedContent
              ? [{ field: "content" as const, snippet: lexical.formattedContent.slice(0, 280) }]
              : []),
          ].slice(0, 5);
    return Object.freeze({
      noteId: fact.noteId,
      workspaceId,
      projectId: fact.projectId,
      authorId: fact.createdById,
      authorName: fact.authorName ?? "Unknown author",
      projectTitle: fact.projectTitle,
      title: fact.title,
      updatedAt: fact.updatedAt.toISOString(),
      createdAt: fact.createdAt.toISOString(),
      isArchived: fact.isArchived,
      isTemplate: fact.isTemplate,
      hasAttachments: fact.hasAttachments,
      highlights,
      snippet:
        lexical?.formattedContent.slice(0, 280) ?? lexical?.contentSnippet.slice(0, 280) ?? "",
    });
  }

  private log(event: {
    input: SearchServiceInput;
    principal: SearchServicePrincipal;
    fallback: string;
    started: number;
    lexicalMs: number;
    semanticMs: number;
    authorizationMs: number;
    rankingMs: number;
    lexicalCount: number;
    semanticCount: number;
    candidateCount: number;
    resultCount: number;
    semanticOutage: boolean;
    lexicalOutage: boolean;
  }): void {
    this.logger.info(
      {
        searchMode: "hybrid",
        searchFallback: event.fallback,
        searchTotalLatencyBucket: bucket(this.now() - event.started),
        searchLexicalLatencyBucket: bucket(event.lexicalMs),
        searchSemanticLatencyBucket: bucket(event.semanticMs),
        searchAuthorizationLatencyBucket: bucket(event.authorizationMs),
        searchRankingLatencyBucket: bucket(event.rankingMs),
        searchLexicalCandidateCount: event.lexicalCount,
        searchSemanticCandidateCount: event.semanticCount,
        searchCandidateCount: event.candidateCount,
        searchResultCount: event.resultCount,
        searchSemanticOutage: event.semanticOutage,
        searchLexicalOutage: event.lexicalOutage,
        ...(event.principal.requestId == null ? {} : { requestId: event.principal.requestId }),
      },
      "Hybrid search executed",
    );
  }
}
