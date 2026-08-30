/**
 * Awareness clientID reader (Part 59) — anti-forgery, not deserialisation.
 *
 * The gateway relays awareness verbatim and never decodes it into state. This
 * module reads ONLY the clientIDs out of the frame so `relayAwareness` can check
 * that a socket is publishing under the Yjs clientID it announced, and nothing
 * else: the per-entry state bytes are skipped, never allocated, never inspected.
 *
 * HAND-ROLLED ON PURPOSE. The obvious implementation imports lib0's `decoding`,
 * but `lib0` is not resolvable from `apps/api` under pnpm's strict
 * `node_modules` layout (`apps/api/node_modules/lib0` does not exist, and the
 * package depends on `yjs` only — not on `y-protocols`, which is what pulls
 * lib0 in on the web side). Importing it would therefore be a NEW dependency for
 * roughly thirty lines of varint reading, so we read the varints ourselves.
 *
 * Wire format produced by `y-protocols/awareness#encodeAwarenessUpdate`:
 *
 *   varUint(entryCount)
 *   per entry: varUint(clientID) varUint(clock) varUint(byteLength) <byteLength bytes>
 *
 * varUint is little-endian base-128: seven payload bits per byte, high bit set
 * means "another byte follows".
 */

/**
 * A room is capped at `maxPresencePerRoom` viewers and a well-behaved client
 * sends one or a handful of entries. Sixty-four is far above any legitimate
 * frame and bounds the work an attacker can buy with one packet.
 */
const MAX_ENTRIES = 64;

/** Yjs clientIDs fit in 53 bits; five payload bytes (35 bits) covers every real one. */
const MAX_VARUINT_BYTES = 5;

/**
 * Returns the clientIDs in wire order, or `null` for ANY malformed frame —
 * truncation, an over-long varUint, an implausible entry count, a declared
 * state length that runs past the end, or bytes left over after the last
 * declared entry. It never throws: this runs inside a socket handler, and a
 * refusal must be an ack, not an unhandled rejection.
 */
export function decodeAwarenessClientIds(update: Uint8Array): readonly number[] | null {
  let offset = 0;

  /** Reads one varUint, or `null` if it is truncated or over-long. */
  const readVarUint = (): number | null => {
    let value = 0;
    let multiplier = 1;
    for (let read = 0; read < MAX_VARUINT_BYTES; read += 1) {
      const byte = update[offset];
      // Doubles as the bounds check: an index past the end reads `undefined`.
      if (byte === undefined) return null;
      offset += 1;
      value += (byte & 0b0111_1111) * multiplier;
      if ((byte & 0b1000_0000) === 0) return value;
      multiplier *= 128;
    }
    return null;
  };

  const entryCount = readVarUint();
  if (entryCount === null || entryCount > MAX_ENTRIES) return null;

  const clientIds: number[] = [];
  for (let entry = 0; entry < entryCount; entry += 1) {
    const clientId = readVarUint();
    if (clientId === null) return null;
    const clock = readVarUint();
    if (clock === null) return null;
    const stateBytes = readVarUint();
    if (stateBytes === null) return null;
    // Skip the state without touching it — the relay stays a pure relay.
    offset += stateBytes;
    if (offset > update.length) return null;
    clientIds.push(clientId);
  }
  // Trailing bytes are malformed too. The per-entry check above only catches a
  // frame that claims MORE than it carries; a frame that carries more than it
  // claims decoded happily, which contradicts the "null for ANY malformed
  // frame" contract above and means the clientIDs vouched for here describe
  // only part of what the gateway would then relay verbatim.
  if (offset !== update.length) return null;
  return clientIds;
}
