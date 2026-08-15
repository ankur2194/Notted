/**
 * Presence colours (Part 59) — the server half of the shared palette.
 *
 * The eight slots live in `apps/web/src/styles/globals.css` as
 * `--notted-presence-0..7`; this module only issues the INDEX, never a CSS
 * value, so the server never has to know how the palette is rendered.
 *
 * DESIGN NOTE — deliberate deviation from the approved design. The design said
 * the server should derive the slot from `sha256(userId)[0] % 8`. We use Part
 * 58's existing web hash instead, byte for byte (see the twin in
 * `apps/web/src/lib/collaboration/user-color.ts`, which exposes
 * `presenceColorIndex` with this exact body).
 *
 * Why: the editor caret has to colour ITSELF at mount time, before the presence
 * announce round trip returns, and computing sha256 in a browser is async
 * (SubtleCrypto). Sharing one cheap deterministic hash makes the server-issued
 * index and the locally-computed index identical BY CONSTRUCTION — a stronger
 * anti-drift guarantee than a server-only sha256 the client cannot reproduce.
 * This is not a security primitive: the colour is decorative, and every caret
 * also carries a text label or is listed by name, so a collision is a cosmetic
 * event and never an identity claim.
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
