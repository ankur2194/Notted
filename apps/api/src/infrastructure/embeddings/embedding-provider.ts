export const EMBEDDING_PROVIDER = Symbol("EMBEDDING_PROVIDER");
export const EMBEDDING_DIMENSIONS = 1536 as const;

/** Vectors at or below this Euclidean norm do not define cosine similarity. */
export const MIN_EMBEDDING_VECTOR_NORM = 1e-12;

export function isUsableEmbeddingVector(vector: readonly number[]): boolean {
  return (
    vector.length === EMBEDDING_DIMENSIONS &&
    vector.every(Number.isFinite) &&
    Math.hypot(...vector) > MIN_EMBEDDING_VECTOR_NORM
  );
}

export type EmbeddingAvailability = "available" | "disabled";

export interface EmbeddingResult {
  readonly vector: readonly number[];
  readonly model: string;
  readonly dimensions: typeof EMBEDDING_DIMENSIONS;
}

export interface EmbeddingProvider {
  availability(): EmbeddingAvailability;
  model(): string;
  dimensions(): typeof EMBEDDING_DIMENSIONS;
  embed(source: string, signal?: AbortSignal): Promise<EmbeddingResult>;
}

/** Safe collapsed provider failure. It intentionally carries no response body or provider error. */
export class EmbeddingProviderError extends Error {
  readonly code = "embedding_provider_unavailable";
  constructor() {
    super("Embedding provider unavailable");
    this.name = "EmbeddingProviderError";
  }
}
