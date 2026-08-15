/**
 * Presence colours (Part 58, narrowed to an index lookup in Part 59).
 *
 * One slot per user. The eight values live in `styles/globals.css` as
 * `--notted-presence-0..7`; each one is documented there with its measured
 * contrast ratio against paper white.
 *
 * Two producers, one algorithm. The API mints the authoritative `colorIndex`
 * for every entry in the presence roster (`apps/api/src/realtime/presence-color.ts`,
 * whose hash body is byte-identical to `presenceColorIndex` below). The editor
 * additionally computes the index locally for its *own* caret, because the caret
 * has to paint the moment the document binds — long before the announce round
 * trip returns a roster. The two never disagree: they run the same function over
 * the same user id. Changing the hash here without changing the API twin would
 * make a writer a different colour to themselves than to everyone else.
 */
export const PRESENCE_COLOR_COUNT = 8;

/**
 * A small stable string hash. Not cryptographic and not meant to be: it only
 * has to spread ids across eight buckets and give the same answer everywhere.
 * The modulus keeps the accumulator well inside the safe integer range.
 */
export function presenceColorIndex(userId: string): number {
  let hash = 0;

  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash * 31 + userId.charCodeAt(index)) % 1_000_003;
  }

  return hash % PRESENCE_COLOR_COUNT;
}

/**
 * The CSS custom property for a slot.
 *
 * The index arrives over a socket for every viewer but the local one, so it is
 * clamped rather than trusted: a fractional, negative, out-of-range or `NaN`
 * value still resolves to a real palette entry instead of emitting
 * `var(--notted-presence-undefined)`, which would paint nothing at all.
 */
export function presenceColorVar(index: number): string {
  const slot = Number.isFinite(index) ? Math.abs(Math.trunc(index)) % PRESENCE_COLOR_COUNT : 0;

  return `var(--notted-presence-${slot})`;
}

/** The local session's own colour, computed without a round trip. */
export function presenceColorForUser(userId: string): string {
  return presenceColorVar(presenceColorIndex(userId));
}
