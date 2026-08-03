/**
 * Value comparison used to decide whether an incoming document is genuinely
 * different from what the editor already holds. Object key order differs
 * between the shared contract and ProseMirror's serializer, so a naive
 * `JSON.stringify` comparison would report false differences and clobber the
 * user's cursor on every render.
 */

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of entries) normalized[key] = stableValue(item);
  return normalized;
}

/** Key-order-independent JSON projection of a document value. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value)) ?? "";
}

export function areDocumentsEquivalent(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}
