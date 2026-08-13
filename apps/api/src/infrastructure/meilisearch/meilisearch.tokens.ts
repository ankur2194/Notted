export const MEILISEARCH_CLIENT = Symbol("MEILISEARCH_CLIENT");

export interface MeilisearchTaskReference {
  readonly taskUid: number;
}

export interface MeilisearchTask {
  readonly uid: number;
  readonly status: "enqueued" | "processing" | "succeeded" | "failed" | "canceled" | "cancelled";
}

export interface MeilisearchDocumentsPage {
  readonly results: readonly unknown[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
}

// --------------------------------------------------------------------------- //
// Provider-neutral search shapes. The raw meilisearch SDK returns a much
// larger object; these types intentionally expose ONLY the allow-listed
// fields the application reads. Unknown fields are stripped at the service
// boundary by `MeilisearchService.search` so provider drift cannot leak into
// application code.
// --------------------------------------------------------------------------- //

/**
 * Allow-listed hit fields. `tags` is read-only because the document contract
 * freezes it. `_formatted` is the highlight-tagged twin of the same fields.
 *
 * `hasAttachments` is intentionally NOT surfaced here: per Decision #4 the
 * search API re-checks every provider hit against authoritative PostgreSQL,
 * and `hasAttachments` is sourced from the `attachments` table in
 * `SearchResultRepository` (mirroring `NoteProjectionRepository`). Keeping it
 * out of the index read path guarantees the API never labels a result from
 * stale index state.
 */
export interface MeilisearchSearchHit {
  readonly id: string;
  readonly title?: string;
  readonly content?: string;
  readonly tags?: readonly string[];
  readonly _formatted?: {
    readonly title?: string;
    readonly content?: string;
    readonly tags?: readonly string[];
  };
  /** Internal meilisearch@0.60.0 response field when showRankingScore=true. */
  readonly _rankingScore?: number;
}

/**
 * Provider-neutral search response. `estimatedTotalHits` is the Meilisearch
 * approximate total for the filter expression; it is NOT authoritative because
 * it ignores PostgreSQL-level access filtering.
 */
export interface MeilisearchSearchResponse {
  readonly hits: readonly MeilisearchSearchHit[];
  readonly estimatedTotalHits: number;
  readonly offset: number;
  readonly limit: number;
  readonly processingTimeMs: number;
}

/**
 * Search request options. The repository constructs these values from
 * already-validated, tenant-proven inputs; raw client strings never reach this
 * shape. Filter and sort expressions are built from UUID/date/enum allow-lists
 * only, so they cannot carry provider injection.
 */
export interface MeilisearchSearchOptions {
  readonly query: string;
  readonly filter: string;
  readonly sort?: readonly string[];
  readonly limit: number;
  readonly offset: number;
  readonly attributesToRetrieve: readonly string[];
  readonly attributesToHighlight: readonly string[];
  readonly highlightPreTag: string;
  readonly highlightPostTag: string;
  readonly showRankingScore: boolean;
}

export interface MeilisearchIndex {
  fetchInfo(): Promise<unknown>;
  updateSettings(settings: Readonly<Record<string, unknown>>): Promise<MeilisearchTaskReference>;
  addDocuments(documents: readonly object[]): Promise<MeilisearchTaskReference>;
  updateDocuments(documents: readonly object[]): Promise<MeilisearchTaskReference>;
  deleteDocuments(documentIds: readonly string[]): Promise<MeilisearchTaskReference>;
  deleteDocuments(options: { readonly filter: string }): Promise<MeilisearchTaskReference>;
  getDocuments(options: {
    readonly fields: readonly string[];
    readonly offset: number;
    readonly limit: number;
    readonly filter?: string;
  }): Promise<MeilisearchDocumentsPage>;
  search(query: string, options: Omit<MeilisearchSearchOptions, "query">): Promise<unknown>;
}

export interface MeilisearchClient {
  health(): Promise<{ readonly status: string }>;
  createIndex(
    uid: string,
    options: { readonly primaryKey: string },
  ): Promise<MeilisearchTaskReference>;
  /** Returns a synchronous lazy index handle in meilisearch-js 0.60. */
  index(uid: string): MeilisearchIndex;
  readonly tasks: {
    getTask(taskUid: number): Promise<MeilisearchTask>;
  };
}
