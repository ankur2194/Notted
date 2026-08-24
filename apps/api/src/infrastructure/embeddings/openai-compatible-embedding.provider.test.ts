import { describe, expect, it, vi } from "vitest";

import { EmbeddingProviderError } from "./embedding-provider";
import { OpenAiCompatibleEmbeddingProvider } from "./openai-compatible-embedding.provider";

import type { AiConfig } from "../../config/ai.config";

const config = (enabled = true): AiConfig => ({
  enabled: false,
  requestTimeoutMs: 120_000,
  embeddings: {
    enabled,
    provider: "openai-compatible",
    baseUrl: "https://embedding.invalid/v1",
    apiKey: "x".repeat(20),
    model: "text-embedding-3-small",
    dimensions: 1536,
    maxSourceCharacters: 24000,
    requestTimeoutMs: 30000,
  },
});

describe("OpenAiCompatibleEmbeddingProvider", () => {
  it("is cleanly disabled without a request", async () => {
    const provider = new OpenAiCompatibleEmbeddingProvider(config(false));
    expect(provider.availability()).toBe("disabled");
    await expect(provider.embed("private query")).rejects.toBeInstanceOf(EmbeddingProviderError);
  });

  it("accepts only exactly 1536 finite values and collapses errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ index: 0, embedding: [1, ...Array(1535).fill(0)] }] }),
      }),
    );
    await expect(
      new OpenAiCompatibleEmbeddingProvider(config()).embed("source"),
    ).resolves.toMatchObject({ dimensions: 1536 });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ index: 0, embedding: [1] }] }),
      }),
    );
    await expect(
      new OpenAiCompatibleEmbeddingProvider(config()).embed("source"),
    ).rejects.toBeInstanceOf(EmbeddingProviderError);
  });

  it.each([Array(1536).fill(0), Array(1536).fill(Number.MIN_VALUE)])(
    "rejects zero and near-zero vectors that cannot define cosine similarity",
    async (embedding) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue({ ok: true, json: async () => ({ data: [{ index: 0, embedding }] }) }),
      );
      await expect(
        new OpenAiCompatibleEmbeddingProvider(config()).embed("source"),
      ).rejects.toBeInstanceOf(EmbeddingProviderError);
    },
  );
});
