import { describe, expect, it } from "vitest";

import { decodeAwarenessClientIds } from "./awareness-client-ids";

/**
 * VERIFIED: `apps/api` depends on `yjs` alone — not on `y-protocols` — and
 * neither `y-protocols` nor `lib0` resolves from this package under pnpm's
 * strict `node_modules` layout. Building fixtures with
 * `encodeAwarenessUpdate` would therefore mean adding a dependency, so the
 * fixtures are hand-encoded here against the documented wire format instead.
 * These encoders are the mirror image of the reader, so a format drift shows up
 * as a failing decode rather than as a silently accepted frame.
 */
function varUint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0b0111_1111) {
    bytes.push(0b1000_0000 | (remaining & 0b0111_1111));
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return bytes;
}

/** varUint(entryCount) then per entry varUint(clientID) varUint(clock) varString(state). */
function awarenessUpdate(
  entries: readonly (readonly [clientId: number, clock: number, state: readonly number[]])[],
): Uint8Array {
  const bytes: number[] = [...varUint(entries.length)];
  for (const [clientId, clock, state] of entries) {
    bytes.push(...varUint(clientId), ...varUint(clock), ...varUint(state.length), ...state);
  }
  return new Uint8Array(bytes);
}

describe("decodeAwarenessClientIds", () => {
  it("reads a single client entry", () => {
    expect(decodeAwarenessClientIds(awarenessUpdate([[42, 1, [123, 34, 125]]]))).toEqual([42]);
  });

  it("reads every client of a multi-entry frame, in wire order", () => {
    const update = awarenessUpdate([
      [7, 3, [1, 2]],
      [4_294_967_295, 9, []],
      [128, 0, [9, 9, 9, 9]],
    ]);
    expect(decodeAwarenessClientIds(update)).toEqual([7, 4_294_967_295, 128]);
  });

  it("survives a state payload that itself looks like a varUint header", () => {
    // The state bytes are SKIPPED, never parsed. A payload full of continuation
    // bits must not shift the reader onto the next entry.
    const update = awarenessUpdate([
      [11, 1, [0xff, 0xff, 0xff, 0xff]],
      [12, 1, [0x80]],
    ]);
    expect(decodeAwarenessClientIds(update)).toEqual([11, 12]);
  });

  it("returns null for an empty buffer", () => {
    expect(decodeAwarenessClientIds(new Uint8Array())).toBeNull();
  });

  it("returns null for a truncated frame rather than throwing", () => {
    const update = awarenessUpdate([[42, 1, [1, 2, 3, 4]]]);
    for (let length = 1; length < update.length; length += 1) {
      expect(decodeAwarenessClientIds(update.slice(0, length))).toBeNull();
    }
  });

  it("returns null when the declared state length runs past the end", () => {
    // Announces eight state bytes and supplies two.
    const update = new Uint8Array([
      ...varUint(1),
      ...varUint(5),
      ...varUint(0),
      ...varUint(8),
      1,
      2,
    ]);
    expect(decodeAwarenessClientIds(update)).toBeNull();
  });

  it("returns null for an entry count far larger than the payload", () => {
    expect(decodeAwarenessClientIds(new Uint8Array([...varUint(1_000), 1, 0, 0]))).toBeNull();
    // Even a plausible-looking count with no entries behind it is refused.
    expect(decodeAwarenessClientIds(new Uint8Array([...varUint(9)]))).toBeNull();
  });

  it("returns null for a varUint longer than five bytes", () => {
    const overlong = new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]);
    expect(decodeAwarenessClientIds(overlong)).toBeNull();
  });

  /*
   * The per-entry length check only catches a frame that claims MORE than it
   * carries. A frame that carries more than it claims decoded happily, so the
   * clientIDs returned here described only the leading part of a payload the
   * gateway then relays verbatim — and the contract on this function says
   * `null` for ANY malformed frame.
   */
  it("returns null for trailing bytes after the last declared entry", () => {
    const exact = awarenessUpdate([[42, 1, [123, 34, 125]]]);
    expect(decodeAwarenessClientIds(exact)).toEqual([42]);
    expect(decodeAwarenessClientIds(new Uint8Array([...exact, 0]))).toBeNull();
    expect(decodeAwarenessClientIds(new Uint8Array([...exact, 1, 2, 3]))).toBeNull();

    // A second entry the count does not declare is the same defect, and is the
    // shape that actually smuggles presence past the forgery check.
    const undeclared = new Uint8Array([
      ...varUint(1),
      ...varUint(42),
      ...varUint(1),
      ...varUint(0),
      ...varUint(99),
      ...varUint(1),
      ...varUint(0),
    ]);
    expect(decodeAwarenessClientIds(undeclared)).toBeNull();
  });
});
