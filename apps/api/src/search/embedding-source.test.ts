import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalEmbeddingSource, normalizeEmbeddingText } from "./embedding-source";

describe("canonical embedding source", () => {
  it("normalizes Unicode, newlines and whitespace deterministically", () => {
    expect(normalizeEmbeddingText("  Cafe\u0301\r\n\tline  \n\n\n next ")).toBe(
      "Café\nline\n\nnext",
    );
  });
  it("truncates by Unicode code point and hashes exactly sent UTF-8 text", () => {
    const source = canonicalEmbeddingSource("A", "😀BC", 4);
    expect(source).toMatchObject({ text: "A\n\n😀", truncated: true });
    expect(source.contentHash).toBe(createHash("sha256").update(source.text).digest("hex"));
  });
});
