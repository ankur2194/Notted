import { describe, expect, it } from "vitest";

import {
  animatedTargetWidth,
  blurDataUri,
  blurDataUriWithinBudget,
  boundLongestEdge,
  fitInside,
  FULL_LONGEST_EDGE_PX,
  MAX_BLUR_DATA_URI_BYTES,
  MEDIUM_WIDTH_PX,
  needsResize,
  THUMBNAIL_WIDTH_PX,
} from "./image-variants";

describe("fitInside", () => {
  it("scales down by the tightest supplied bound and preserves the aspect ratio", () => {
    expect(fitInside({ width: 1_000, height: 500 }, { width: MEDIUM_WIDTH_PX })).toEqual({
      width: 800,
      height: 400,
    });
    expect(fitInside({ width: 500, height: 1_000 }, { width: MEDIUM_WIDTH_PX })).toEqual({
      width: 500,
      height: 1_000,
    });
    // Both bounds supplied: the tighter one wins.
    expect(fitInside({ width: 4_000, height: 1_000 }, { width: 2_000, height: 2_000 })).toEqual({
      width: 2_000,
      height: 500,
    });
    expect(fitInside({ width: 1_000, height: 4_000 }, { width: 2_000, height: 2_000 })).toEqual({
      width: 500,
      height: 2_000,
    });
  });

  it("never enlarges: a 100 px source stays 100 px against every ceiling", () => {
    const source = { width: 100, height: 60 };
    for (const bound of [THUMBNAIL_WIDTH_PX, MEDIUM_WIDTH_PX, FULL_LONGEST_EDGE_PX]) {
      expect(fitInside(source, { width: bound })).toEqual(source);
    }
    expect(boundLongestEdge(source, FULL_LONGEST_EDGE_PX)).toEqual(source);
    expect(needsResize(source, boundLongestEdge(source, FULL_LONGEST_EDGE_PX))).toBe(false);
  });

  it("treats an omitted bound as unconstrained", () => {
    expect(fitInside({ width: 900, height: 300 }, { height: 100 })).toEqual({
      width: 300,
      height: 100,
    });
    expect(fitInside({ width: 900, height: 300 }, {})).toEqual({ width: 900, height: 300 });
  });

  it("keeps an extreme aspect ratio from collapsing to zero", () => {
    // 1 x 10000 bounded to a 2000 px square: the height binds, and the width
    // would round to 0 without the floor of 1.
    const bounded = boundLongestEdge({ width: 1, height: 10_000 }, FULL_LONGEST_EDGE_PX);
    expect(bounded).toEqual({ width: 1, height: 2_000 });
    expect(bounded.width).toBeGreaterThanOrEqual(1);

    const wide = boundLongestEdge({ width: 10_000, height: 1 }, FULL_LONGEST_EDGE_PX);
    expect(wide).toEqual({ width: 2_000, height: 1 });

    // A thumbnail of a 1 px-wide strip is still at least one pixel each way.
    const thumbnail = fitInside({ width: 3, height: 9_000 }, { width: THUMBNAIL_WIDTH_PX });
    expect(thumbnail).toEqual({ width: 3, height: 9_000 });
  });

  it("rejects a non-positive source rather than emitting a nonsense target", () => {
    expect(() => fitInside({ width: 0, height: 10 }, { width: 100 })).toThrowError(
      "positive source dimensions",
    );
    expect(() => fitInside({ width: 10, height: Number.NaN }, { width: 100 })).toThrowError(
      "positive source dimensions",
    );
  });
});

describe("animatedTargetWidth", () => {
  it("bounds an animation by its per-FRAME longest edge and returns only a width", () => {
    // Frame is 4000 x 1000; the width binds.
    expect(animatedTargetWidth({ width: 4_000, height: 1_000 }, FULL_LONGEST_EDGE_PX)).toBe(2_000);
    // Frame is 500 x 4000; the HEIGHT binds, and the returned width shrinks with
    // it. Passing a height alongside `animated: true` would bound the filmstrip
    // instead of the frame, which is why only a width is ever produced.
    expect(animatedTargetWidth({ width: 500, height: 4_000 }, FULL_LONGEST_EDGE_PX)).toBe(250);
    // Already inside the bound: unchanged, so the caller can skip the resize.
    expect(animatedTargetWidth({ width: 64, height: 64 }, FULL_LONGEST_EDGE_PX)).toBe(64);
  });
});

describe("blur placeholder budget", () => {
  it("builds a data URI and accepts a realistically sized placeholder", () => {
    const uri = blurDataUri(Buffer.alloc(300, 0x11), "image/webp");
    expect(uri.startsWith("data:image/webp;base64,")).toBe(true);
    expect(blurDataUriWithinBudget(uri)).toBe(true);
  });

  it("refuses anything over the hard bound so a listing cannot be inflated", () => {
    const oversized = blurDataUri(Buffer.alloc(MAX_BLUR_DATA_URI_BYTES, 0x22), "image/webp");
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(MAX_BLUR_DATA_URI_BYTES);
    expect(blurDataUriWithinBudget(oversized)).toBe(false);
  });
});
