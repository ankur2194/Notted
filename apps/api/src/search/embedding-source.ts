import { createHash } from "node:crypto";

export const EMBEDDING_SOURCE_SEPARATOR = "\n\n";

export interface CanonicalEmbeddingSource {
  readonly text: string;
  readonly contentHash: string;
  readonly truncated: boolean;
}

/** NFC, LF newlines, collapsed horizontal whitespace, trimmed lines and blank runs. */
export function normalizeEmbeddingText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t\f\v\p{Zs}]+/gu, " ").trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function canonicalEmbeddingSource(
  title: string,
  contentPlain: string | null,
  maxCharacters: number,
): CanonicalEmbeddingSource {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1)
    throw new Error("invalid_embedding_source_limit");
  const joined = [normalizeEmbeddingText(title), normalizeEmbeddingText(contentPlain ?? "")]
    .filter((part) => part.length > 0)
    .join(EMBEDDING_SOURCE_SEPARATOR);
  const codePoints = [...joined];
  const text = codePoints.slice(0, maxCharacters).join("");
  return Object.freeze({
    text,
    contentHash: createHash("sha256").update(text, "utf8").digest("hex"),
    truncated: codePoints.length > maxCharacters,
  });
}
