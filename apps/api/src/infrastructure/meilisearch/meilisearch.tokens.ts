export const MEILISEARCH_CLIENT = Symbol("MEILISEARCH_CLIENT");

export interface MeilisearchClient {
  health(): Promise<{ readonly status: string }>;
}
