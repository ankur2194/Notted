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
