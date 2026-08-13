import { describe, expect, it } from "vitest";

import { parseAiConfig } from "./ai.config";

describe("embedding config", () => {
  it("defaults to an optional disabled 1536-dimensional provider", () => {
    expect(parseAiConfig({}).embeddings).toMatchObject({
      enabled: false,
      dimensions: 1536,
      model: "text-embedding-3-small",
      maxSourceCharacters: 24000,
      requestTimeoutMs: 30000,
    });
  });
  it("requires a key only when enabled and rejects schema-incompatible dimensions", () => {
    expect(() => parseAiConfig({ FEATURE_EMBEDDINGS_ENABLED: "true" })).toThrow(
      "EMBEDDING_API_KEY",
    );
    expect(() => parseAiConfig({ EMBEDDING_DIMENSIONS: "768" })).toThrow("exactly 1536");
  });
});
