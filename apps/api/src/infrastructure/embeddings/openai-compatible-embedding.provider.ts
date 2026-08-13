import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import { AI_CONFIG, type AiConfig } from "../../config/ai.config";

import {
  EMBEDDING_DIMENSIONS,
  EmbeddingProviderError,
  isUsableEmbeddingVector,
  type EmbeddingProvider,
  type EmbeddingResult,
} from "./embedding-provider";

const responseSchema = z
  .object({
    data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })).length(1),
  })
  .passthrough();

@Injectable()
export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  constructor(@Inject(AI_CONFIG) private readonly ai: AiConfig) {}

  availability(): "available" | "disabled" {
    return this.ai.embeddings.enabled ? "available" : "disabled";
  }

  model(): string {
    return this.ai.embeddings.model;
  }

  dimensions(): typeof EMBEDDING_DIMENSIONS {
    return EMBEDDING_DIMENSIONS;
  }

  async embed(source: string, signal?: AbortSignal): Promise<EmbeddingResult> {
    const config = this.ai.embeddings;
    if (!config.enabled || config.apiKey === undefined) throw new EmbeddingProviderError();
    const timeout = AbortSignal.timeout(config.requestTimeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      const response = await fetch(`${config.baseUrl}/embeddings`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ input: source, model: config.model, dimensions: config.dimensions }),
        signal: combined,
      });
      if (!response.ok) throw new EmbeddingProviderError();
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) throw new EmbeddingProviderError();
      const vector = parsed.data.data[0]?.embedding;
      if (vector === undefined || !isUsableEmbeddingVector(vector))
        throw new EmbeddingProviderError();
      return Object.freeze({
        vector: Object.freeze([...vector]),
        model: config.model,
        dimensions: EMBEDDING_DIMENSIONS,
      });
    } catch {
      throw new EmbeddingProviderError();
    }
  }
}
