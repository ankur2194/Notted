import { Inject, Injectable } from "@nestjs/common";

import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from "../infrastructure/embeddings/embedding-provider";

import {
  SemanticSearchRepository,
  type SemanticCandidate,
  type SemanticFilters,
} from "./semantic-search.repository";

@Injectable()
export class SemanticSearchService {
  constructor(
    @Inject(EMBEDDING_PROVIDER) private readonly provider: EmbeddingProvider,
    private readonly repository: SemanticSearchRepository,
  ) {}
  isAvailable(): boolean {
    return this.provider.availability() === "available";
  }
  async candidates(input: {
    readonly query: string;
    readonly filters: SemanticFilters;
    readonly offset: number;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly string[]> {
    return (await this.rankedCandidates(input)).map(({ id }) => id);
  }
  async rankedCandidates(input: {
    readonly query: string;
    readonly filters: SemanticFilters;
    readonly offset: number;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly SemanticCandidate[]> {
    const query = await this.provider.embed(input.query, input.signal);
    return this.repository.search({
      vector: query.vector,
      model: query.model,
      dimensions: query.dimensions,
      filters: input.filters,
      offset: input.offset,
      limit: input.limit,
    });
  }
}
