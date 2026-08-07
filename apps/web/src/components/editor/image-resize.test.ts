import { NOTE_DOCUMENT_LIMITS } from "@notted/shared-validators";
import { describe, expect, it } from "vitest";

import {
  IMAGE_MIN_WIDTH_PX,
  IMAGE_RESIZE_HANDLES,
  IMAGE_RESIZE_STEP_PX,
  clampImageHeight,
  clampImageWidth,
  displayImageWidth,
  resizeImage,
  resolveImageResizeBounds,
  stepImageWidth,
  type ImageResizeBounds,
} from "./image-resize";

/**
 * The whole point of keeping this arithmetic pure: jsdom reports every rect as
 * zero and implements no `ResizeObserver`, so a node-view test could never say
 * anything about the numbers. These do.
 */

const BOUNDS: ImageResizeBounds = { minWidth: IMAGE_MIN_WIDTH_PX, maxWidth: 660 };

describe("resolveImageResizeBounds", () => {
  it("clamps to the measured printable column", () => {
    expect(resolveImageResizeBounds(660)).toEqual({ minWidth: IMAGE_MIN_WIDTH_PX, maxWidth: 660 });
  });

  it("falls back to the contract bound when the page cannot be measured", () => {
    // jsdom, a standalone editor, and an export context all land here. The
    // fallback is the widest value the document may store at all, so nothing is
    // clamped to a number this module invented.
    for (const unmeasurable of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveImageResizeBounds(unmeasurable).maxWidth).toBe(
        NOTE_DOCUMENT_LIMITS.maxImageDimension,
      );
    }
  });

  it("never lets the page bound exceed what the contract accepts", () => {
    expect(resolveImageResizeBounds(NOTE_DOCUMENT_LIMITS.maxImageDimension + 5_000).maxWidth).toBe(
      NOTE_DOCUMENT_LIMITS.maxImageDimension,
    );
  });

  it("keeps the bounds orderable on a page narrower than the minimum", () => {
    const bounds = resolveImageResizeBounds(20);
    expect(bounds.minWidth).toBeLessThanOrEqual(bounds.maxWidth);
  });
});

describe("clamping", () => {
  it("bounds a width between the minimum and the printable column", () => {
    expect(clampImageWidth(10, BOUNDS)).toBe(IMAGE_MIN_WIDTH_PX);
    expect(clampImageWidth(5_000, BOUNDS)).toBe(660);
    expect(clampImageWidth(320.4, BOUNDS)).toBe(320);
  });

  it("bounds a height by the contract only, because pages scroll", () => {
    expect(clampImageHeight(0)).toBe(1);
    expect(clampImageHeight(NOTE_DOCUMENT_LIMITS.maxImageDimension + 1)).toBe(
      NOTE_DOCUMENT_LIMITS.maxImageDimension,
    );
  });

  it("clamps a stored width on READ without rewriting the document", () => {
    // A Part 42 image stores its intrinsic size, which is routinely wider than
    // the page. It must be drawn inside the column, and the document must not be
    // edited to make that happen.
    expect(displayImageWidth(4_000, BOUNDS)).toBe(660);
    expect(displayImageWidth(320, BOUNDS)).toBe(320);
    expect(displayImageWidth(null, BOUNDS)).toBeNull();
    expect(displayImageWidth(0, BOUNDS)).toBeNull();
  });
});

describe("resizeImage", () => {
  const start = { startWidth: 400, startHeight: 200 } as const;

  it("grows and shrinks from every corner in the direction the pointer moves", () => {
    const expectations: Record<(typeof IMAGE_RESIZE_HANDLES)[number], number> = {
      se: 500,
      ne: 500,
      sw: 300,
      nw: 300,
    };
    for (const handle of IMAGE_RESIZE_HANDLES) {
      const result = resizeImage({
        handle,
        ...start,
        deltaX: 100,
        deltaY: 0,
        freeform: false,
        bounds: BOUNDS,
      });
      expect(result.width, handle).toBe(expectations[handle]);
    }
  });

  it("keeps the aspect ratio by default", () => {
    const result = resizeImage({
      handle: "se",
      ...start,
      deltaX: 100,
      deltaY: 500,
      freeform: false,
      bounds: BOUNDS,
    });
    // The vertical travel is deliberately ignored when the ratio is locked: a
    // ratio-locked corner drag has exactly one degree of freedom.
    expect(result).toEqual({ width: 500, height: 250 });
  });

  it("lets Shift drive each axis independently", () => {
    const result = resizeImage({
      handle: "se",
      ...start,
      deltaX: 100,
      deltaY: -50,
      freeform: true,
      bounds: BOUNDS,
    });
    expect(result).toEqual({ width: 500, height: 150 });
  });

  it("resizes a north handle upward and a west handle leftward in freeform", () => {
    expect(
      resizeImage({
        handle: "nw",
        ...start,
        deltaX: -60,
        deltaY: -40,
        freeform: true,
        bounds: BOUNDS,
      }),
    ).toEqual({ width: 460, height: 240 });
  });

  it("clamps a drag to the printable column and to the minimum", () => {
    expect(
      resizeImage({
        handle: "se",
        ...start,
        deltaX: 10_000,
        deltaY: 0,
        freeform: false,
        bounds: BOUNDS,
      }),
    ).toEqual({ width: 660, height: 330 });
    expect(
      resizeImage({
        handle: "se",
        ...start,
        deltaX: -10_000,
        deltaY: 0,
        freeform: false,
        bounds: BOUNDS,
      }),
    ).toEqual({ width: IMAGE_MIN_WIDTH_PX, height: 24 });
  });

  it("resizes width only when nothing has ever measured the height", () => {
    expect(
      resizeImage({
        handle: "se",
        startWidth: 400,
        startHeight: null,
        deltaX: 100,
        deltaY: 100,
        freeform: false,
        bounds: BOUNDS,
      }),
    ).toEqual({ width: 500, height: null });
  });
});

describe("stepImageWidth", () => {
  it("moves one keyboard step and keeps the ratio", () => {
    expect(stepImageWidth({ width: 400, height: 200 }, IMAGE_RESIZE_STEP_PX, BOUNDS)).toEqual({
      width: 432,
      height: 216,
    });
    expect(stepImageWidth({ width: 400, height: 200 }, -IMAGE_RESIZE_STEP_PX, BOUNDS)).toEqual({
      width: 368,
      height: 184,
    });
  });

  it("stops at the same bounds a drag stops at", () => {
    expect(stepImageWidth({ width: 660, height: 330 }, IMAGE_RESIZE_STEP_PX, BOUNDS).width).toBe(
      660,
    );
    expect(
      stepImageWidth({ width: IMAGE_MIN_WIDTH_PX, height: 24 }, -IMAGE_RESIZE_STEP_PX, BOUNDS)
        .width,
    ).toBe(IMAGE_MIN_WIDTH_PX);
  });
});
