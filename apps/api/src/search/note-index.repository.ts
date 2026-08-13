import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { MEILISEARCH_CONFIG, type MeilisearchConfig } from "../config/meilisearch.config";
import { MeilisearchService } from "../infrastructure/meilisearch/meilisearch.service";

import {
  NOTE_INDEX_PRIMARY_KEY,
  NOTE_INDEX_SETTINGS,
  noteIndexDocumentSchema,
  noteIndexUid,
  type NoteIndexDocument,
} from "./note-index.document";

import type {
  MeilisearchSearchHit,
  MeilisearchSearchResponse,
} from "../infrastructure/meilisearch/meilisearch.tokens";

const documentIdSchema = z.string().uuid();
const pageRequestSchema = z
  .object({
    offset: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(1_000),
  })
  .strict();
const documentIdPageSchema = z
  .object({
    results: z.array(z.object({ id: documentIdSchema }).strict()).readonly(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict();
const documentReferencePageSchema = z
  .object({
    results: z
      .array(z.object({ id: documentIdSchema, workspaceId: documentIdSchema }).strict())
      .readonly(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict();

export interface NoteIndexDocumentIdPage {
  readonly ids: readonly string[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
}

export interface NoteIndexDocumentReferencePage {
  readonly documents: readonly { readonly id: string; readonly workspaceId: string }[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
}

// --------------------------------------------------------------------------- //
// Part 52.1 — typed search support.
// --------------------------------------------------------------------------- //
//
// The repository accepts ALREADY-VALIDATED, tenant-proven inputs: a parsed
// UUID `workspaceId`, a bounded `query` string, UUID-validated filter values,
// and enum-validated sort/page parameters. UUID parsing is the escaping
// boundary for every identifier that reaches the Meilisearch filter expression
// (see `documentIdSchema`). Timestamps are passed as epoch-ms numbers because
// that is Meilisearch's expected numeric form for timestamp filter ranges;
// the caller converts from ISO strings before invoking.
//
// Sortable attributes are validated against the index settings allow-list
// (`NOTE_INDEX_SETTINGS.sortableAttributes`). Relevance sort omits the `sort`
// array so Meilisearch applies its ranking rules; `createdAt`/`updatedAt`
// produce a single-element sort array.
//
// Highlight markers (`HIGHLIGHT_PRE_TAG`/`HIGHLIGHT_POST_TAG`) are control
// characters (`\u0000`/`\u0001`) that cannot appear in indexed note text and
// therefore need no escaping. The application splits formatted strings on
// these markers to produce plain-text segments + match markers; the API never
// returns HTML.

/** Sortable attribute names accepted by the search sort mapping. */
const SORTABLE_ATTRIBUTES = new Set<string>(NOTE_INDEX_SETTINGS.sortableAttributes);

/** Maximum query string length the repository will forward to the provider. */
const MAX_QUERY_LENGTH = 500;
/** Maximum page size the repository will request from the provider in one call. */
const MAX_PROVIDER_LIMIT = 200;

const searchQueryTextSchema = z.string().trim().min(1).max(MAX_QUERY_LENGTH);
const searchPageSchema = z
  .object({
    offset: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(MAX_PROVIDER_LIMIT),
  })
  .strict();
const searchFilterValueSchema = z.object({
  workspaceId: documentIdSchema,
  projectId: documentIdSchema.optional(),
  authorId: documentIdSchema.optional(),
  hasAttachments: z.boolean().optional(),
  createdFrom: z.number().int().nonnegative().safe().optional(),
  createdTo: z.number().int().nonnegative().safe().optional(),
  updatedFrom: z.number().int().nonnegative().safe().optional(),
  updatedTo: z.number().int().nonnegative().safe().optional(),
});
const searchSortInputSchema = z.object({
  sortBy: z.enum(["relevance", "createdAt", "updatedAt"]),
  sortDirection: z.enum(["asc", "desc"]),
});

/**
 * Provider-neutral candidate. The application authorizes each candidate
 * against authoritative PostgreSQL before surfacing it to the API. The
 * `rankingScore` (provider-normalized relevance) is exposed for Part 54
 * hybrid ranking; it is NOT part of the API output contract.
 *
 * `hasAttachments` is deliberately NOT carried on the candidate: it is a
 * derived boolean that the search-result repository re-reads from the
 * authoritative `attachments` table (Decision #4) so result labels never
 * reflect stale index state.
 */
export interface NoteSearchCandidate {
  readonly id: string;
  readonly title: string;
  readonly contentSnippet: string;
  readonly tags: readonly string[];
  readonly formattedTitle: string;
  readonly formattedContent: string;
  readonly formattedTags: readonly string[];
  readonly rankingScore: number | null;
}

/**
 * Provider-neutral candidate page. `providerTotal` is the raw Meilisearch
 * `estimatedTotalHits` for the filter expression; it is NOT authoritative
 * because it ignores access filtering. The application over-fetches and slices
 * after authorization to produce the API page.
 */
export interface NoteSearchCandidatePage {
  readonly candidates: readonly NoteSearchCandidate[];
  readonly providerTotal: number;
  readonly limit: number;
  readonly offset: number;
}

/** Inputs to {@link NoteIndexRepository.search}. Already validated upstream. */
export interface NoteSearchRepositoryInput {
  readonly workspaceId: string;
  readonly query: string;
  readonly filters: {
    readonly projectId?: string;
    readonly authorId?: string;
    readonly hasAttachments?: boolean;
    readonly createdFrom?: number;
    readonly createdTo?: number;
    readonly updatedFrom?: number;
    readonly updatedTo?: number;
  };
  readonly sort: z.infer<typeof searchSortInputSchema>;
  readonly offset: number;
  readonly limit: number;
}

/** Highlight marker characters used to wrap matched terms in `_formatted`. */
export const HIGHLIGHT_PRE_TAG = "\u0000";
export const HIGHLIGHT_POST_TAG = "\u0001";

const SEARCH_ATTRIBUTES_TO_RETRIEVE = Object.freeze(["id", "title", "content", "tags"]);
const SEARCH_ATTRIBUTES_TO_HIGHLIGHT = Object.freeze(["title", "content", "tags"]);

@Injectable()
export class NoteIndexRepository implements OnModuleInit {
  readonly indexUid: string;

  constructor(
    @Inject(MEILISEARCH_CONFIG) config: MeilisearchConfig,
    @Inject(MeilisearchService) private readonly meilisearch: MeilisearchService,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {
    this.indexUid = noteIndexUid(config.indexPrefix);
  }

  async onModuleInit(): Promise<void> {
    if (!this.meilisearch.isEnabled()) {
      return;
    }
    try {
      await this.ensureIndex();
    } catch {
      this.logger.failure(
        { dependency: "meilisearch", status: "down", durationMs: 0, reason: "index_setup" },
        "Search index setup failed",
      );
    }
  }

  async ensureIndex(): Promise<void> {
    await this.meilisearch.ensureIndex(this.indexUid, NOTE_INDEX_PRIMARY_KEY);
    await this.meilisearch.updateIndexSettings(this.indexUid, NOTE_INDEX_SETTINGS);
  }

  async addDocuments(documents: readonly NoteIndexDocument[]): Promise<void> {
    await this.meilisearch.addDocuments(this.indexUid, parseDocuments(documents));
  }

  async updateDocuments(documents: readonly NoteIndexDocument[]): Promise<void> {
    await this.meilisearch.updateDocuments(this.indexUid, parseDocuments(documents));
  }

  async deleteDocuments(documentIds: readonly string[]): Promise<void> {
    const parsedIds = parseDocumentIds(documentIds);
    if (parsedIds.length === 0) {
      return;
    }
    await this.meilisearch.deleteDocuments(this.indexUid, parsedIds);
  }

  async deleteWorkspaceDocuments(workspaceId: string): Promise<void> {
    const parsedWorkspaceId = parseDocumentId(workspaceId);
    await this.meilisearch.deleteDocumentsByFilter(
      this.indexUid,
      `workspaceId = "${parsedWorkspaceId}"`,
    );
  }

  async deleteWorkspaceDocumentsByIds(
    workspaceId: string,
    documentIds: readonly string[],
  ): Promise<void> {
    const parsedWorkspaceId = parseDocumentId(workspaceId);
    const parsedIds = parseDocumentIds(documentIds);
    if (parsedIds.length === 0) return;
    const idList = parsedIds.map((id) => JSON.stringify(id)).join(", ");
    await this.meilisearch.deleteDocumentsByFilter(
      this.indexUid,
      `workspaceId = "${parsedWorkspaceId}" AND id IN [${idList}]`,
    );
  }

  async listDocumentIds(options: {
    readonly offset: number;
    readonly limit: number;
  }): Promise<NoteIndexDocumentIdPage> {
    const parsedOptions = parsePageRequest(options);
    const rawPage = await this.meilisearch.getDocumentsPage(this.indexUid, {
      ...parsedOptions,
      fields: ["id"],
    });
    const page = parseDocumentIdPage(rawPage);
    return {
      ids: page.results.map(({ id }) => id),
      offset: page.offset,
      limit: page.limit,
      total: page.total,
    };
  }

  async listWorkspaceDocumentIds(
    workspaceId: string,
    options: { readonly offset: number; readonly limit: number },
  ): Promise<NoteIndexDocumentIdPage> {
    const parsedWorkspaceId = parseDocumentId(workspaceId);
    const parsedOptions = parsePageRequest(options);
    const rawPage = await this.meilisearch.getDocumentsPage(this.indexUid, {
      ...parsedOptions,
      fields: ["id"],
      // UUID parsing is the escaping boundary: only canonical UUID characters
      // can reach the Meilisearch filter expression.
      filter: `workspaceId = "${parsedWorkspaceId}"`,
    });
    const page = parseDocumentIdPage(rawPage);
    return {
      ids: page.results.map(({ id }) => id),
      offset: page.offset,
      limit: page.limit,
      total: page.total,
    };
  }

  async listDocumentWorkspaceReferences(options: {
    readonly offset: number;
    readonly limit: number;
  }): Promise<NoteIndexDocumentReferencePage> {
    const parsedOptions = parsePageRequest(options);
    const rawPage = await this.meilisearch.getDocumentsPage(this.indexUid, {
      ...parsedOptions,
      fields: ["id", "workspaceId"],
    });
    const page = parseDocumentReferencePage(rawPage);
    return {
      documents: page.results,
      offset: page.offset,
      limit: page.limit,
      total: page.total,
    };
  }

  /**
   * Part 52.1 — run a tenant-scoped full-text search against the note index
   * and return a provider-neutral candidate page.
   *
   * Inputs are already validated and tenant-proven; this method builds the
   * Meilisearch filter expression from allow-listed values only (UUID parsing
   * is the escaping boundary). Sortable attribute names are validated against
   * the index settings allow-list. Highlights use the fixed control-character
   * markers {@link HIGHLIGHT_PRE_TAG}/{@link HIGHLIGHT_POST_TAG} so the
   * application can split formatted text into plain-text segments without any
   * HTML escaping concern.
   *
   * `showRankingScore: true` is forwarded so Part 54 hybrid ranking has the
   * normalized provider score; it is exposed on {@link NoteSearchCandidate}
   * but NOT on the API output contract.
   */
  async search(input: NoteSearchRepositoryInput): Promise<NoteSearchCandidatePage> {
    const parsedQuery = searchQueryTextSchema.parse(input.query);
    const parsedPage = searchPageSchema.parse({ offset: input.offset, limit: input.limit });
    const parsedFilters = searchFilterValueSchema.parse({
      workspaceId: input.workspaceId,
      ...input.filters,
    });
    const parsedSort = searchSortInputSchema.parse(input.sort);

    const filter = buildSearchFilterExpression(parsedFilters);
    const sort = buildSearchSortArray(parsedSort);
    const response = await this.meilisearch.search(this.indexUid, {
      query: parsedQuery,
      filter,
      ...(sort === undefined ? {} : { sort }),
      limit: parsedPage.limit,
      offset: parsedPage.offset,
      attributesToRetrieve: SEARCH_ATTRIBUTES_TO_RETRIEVE,
      attributesToHighlight: SEARCH_ATTRIBUTES_TO_HIGHLIGHT,
      highlightPreTag: HIGHLIGHT_PRE_TAG,
      highlightPostTag: HIGHLIGHT_POST_TAG,
      showRankingScore: true,
    });
    return mapSearchResponse(response);
  }
}

function parseDocuments(documents: readonly NoteIndexDocument[]): readonly NoteIndexDocument[] {
  const result = z.array(noteIndexDocumentSchema).min(1).max(1_000).safeParse(documents);
  if (!result.success) {
    throw new Error("Invalid note index documents");
  }
  return result.data;
}

function parseDocumentIds(documentIds: readonly string[]): readonly string[] {
  const result = z.array(documentIdSchema).max(1_000).safeParse(documentIds);
  if (!result.success) {
    throw new Error("Invalid note index document IDs");
  }
  return result.data;
}

function parseDocumentId(documentId: string): string {
  const result = documentIdSchema.safeParse(documentId);
  if (!result.success) {
    throw new Error("Invalid note index document ID");
  }
  return result.data;
}

function parsePageRequest(options: { readonly offset: number; readonly limit: number }) {
  const result = pageRequestSchema.safeParse(options);
  if (!result.success) {
    throw new Error("Invalid note index page request");
  }
  return result.data;
}

function parseDocumentIdPage(page: unknown) {
  const result = documentIdPageSchema.safeParse(page);
  if (!result.success) {
    throw new Error("Invalid note index document ID page");
  }
  return result.data;
}

function parseDocumentReferencePage(page: unknown) {
  const result = documentReferencePageSchema.safeParse(page);
  if (!result.success) {
    throw new Error("Invalid note index document reference page");
  }
  return result.data;
}

// --------------------------------------------------------------------------- //
// Part 52.1 search helpers
// --------------------------------------------------------------------------- //
//
// Filter expressions are constructed ONLY from validated UUIDs, finite
// non-negative epoch-ms numbers, and finite booleans. The expression syntax
// uses Meilisearch's `key = "value"` and `key <op> number` forms. UUID
// parsing above (`searchFilterValueSchema`) is the escaping boundary: only
// canonical UUID characters can reach these strings, so filter injection via
// crafted identifiers is impossible.

type SearchFilterValues = z.infer<typeof searchFilterValueSchema>;

function buildSearchFilterExpression(values: SearchFilterValues): string {
  const parts: string[] = [`workspaceId = "${values.workspaceId}"`];
  if (values.projectId !== undefined) {
    parts.push(`projectId = "${values.projectId}"`);
  }
  if (values.authorId !== undefined) {
    parts.push(`authorId = "${values.authorId}"`);
  }
  if (values.hasAttachments !== undefined) {
    parts.push(`hasAttachments = ${values.hasAttachments ? "true" : "false"}`);
  }
  appendTimestampRange(parts, "createdAt", values.createdFrom, values.createdTo);
  appendTimestampRange(parts, "updatedAt", values.updatedFrom, values.updatedTo);
  return parts.join(" AND ");
}

function appendTimestampRange(
  parts: string[],
  attributeName: string,
  from: number | undefined,
  to: number | undefined,
): void {
  if (!SORTABLE_ATTRIBUTES.has(attributeName)) {
    // Defense-in-depth: timestamp attributes are also sortable per the index
    // settings; if the allow-list ever drifts, fail loud rather than emit a
    // filter Meilisearch would reject anyway.
    throw new Error(`Timestamp filter on non-sortable attribute: ${attributeName}`);
  }
  if (from !== undefined) {
    parts.push(`${attributeName} >= ${Math.trunc(from)}`);
  }
  if (to !== undefined) {
    parts.push(`${attributeName} <= ${Math.trunc(to)}`);
  }
}

function buildSearchSortArray(
  sort: z.infer<typeof searchSortInputSchema>,
): readonly string[] | undefined {
  if (sort.sortBy === "relevance") {
    // Relevance relies on the index ranking rules; omitting `sort` keeps
    // ranking deterministic.
    return undefined;
  }
  if (!SORTABLE_ATTRIBUTES.has(sort.sortBy)) {
    throw new Error(`Sort on non-sortable attribute: ${sort.sortBy}`);
  }
  return [`${sort.sortBy}:${sort.sortDirection}`];
}

/**
 * Map the provider-neutral response into the application candidate page. Hit
 * fields are coerced to safe defaults when absent (a deleted-document drift
 * candidate may surface empty `_formatted` strings). `rankingScore` is read
 * from the raw hit at this layer so the rest of the application never sees the
 * provider-specific underscore-prefixed field names.
 */
function mapSearchResponse(response: MeilisearchSearchResponse): NoteSearchCandidatePage {
  return Object.freeze({
    candidates: response.hits.map(mapSearchCandidate),
    providerTotal: response.estimatedTotalHits,
    limit: response.limit,
    offset: response.offset,
  });
}

function mapSearchCandidate(hit: MeilisearchSearchHit): NoteSearchCandidate {
  const tags = hit.tags ?? [];
  const formatted = hit._formatted ?? {};
  const rankingScore = readRankingScore(hit);
  return Object.freeze({
    id: hit.id,
    title: hit.title ?? "",
    contentSnippet: pickSnippet(hit.content),
    tags,
    formattedTitle: formatted.title ?? "",
    formattedContent: formatted.content ?? "",
    formattedTags: formatted.tags ?? [],
    rankingScore,
  });
}

/**
 * Meilisearch truncates the returned `content` field for display when
 * `attributesToHighlight` is set; we treat that as the snippet and bound it
 * defensively. The search service further trims this value before sending it
 * to the API.
 */
function pickSnippet(content: string | undefined): string {
  if (content === undefined) return "";
  return content.length > 1_000 ? content.slice(0, 1_000) : content;
}

/**
 * The provider exposes a normalized relevance score on each hit when
 * `showRankingScore: true` is requested. The service-boundary parser
 * (`parseSearchHit`) intentionally does NOT surface this field (it is
 * provider-specific and not part of the API contract); we read it here via a
 * narrow cast so Part 54 hybrid ranking can consume it internally.
 */
function readRankingScore(hit: MeilisearchSearchHit): number | null {
  const value = hit._rankingScore;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
