/**
 * Image resize arithmetic (Part 43), deliberately pure and DOM-free.
 *
 * jsdom reports every rect as zero and implements neither `ResizeObserver` nor
 * pointer capture, so none of this could be proven through the node view. The
 * same split `page-geometry.ts` uses applies: the numbers live here and are
 * tested directly, and the node view only feeds measurements in and writes the
 * result out.
 *
 * Nothing here reads or writes the document. The caller commits exactly once,
 * on pointer-up, through `updateAttributes` so a whole drag is one undo step.
 */

import { NOTE_DOCUMENT_LIMITS } from "@notted/shared-validators";

/**
 * Smallest committed width.
 *
 * Below roughly this size a figure stops being an image and becomes an
 * unrecognisable smudge that is also too small to grab a handle on again, which
 * would leave the author no way back other than undo.
 */
export const IMAGE_MIN_WIDTH_PX = 48;

/** One press of the keyboard resize binding. */
export const IMAGE_RESIZE_STEP_PX = 32;

/** The four corner handles. Corners only: an edge handle cannot preserve ratio. */
export const IMAGE_RESIZE_HANDLES = Object.freeze(["nw", "ne", "sw", "se"] as const);
export type ImageResizeHandle = (typeof IMAGE_RESIZE_HANDLES)[number];

export const IMAGE_RESIZE_HANDLE_LABELS: Readonly<Record<ImageResizeHandle, string>> =
  Object.freeze({
    nw: "Resize image from the top left",
    ne: "Resize image from the top right",
    sw: "Resize image from the bottom left",
    se: "Resize image from the bottom right",
  });

export interface ImageResizeBounds {
  readonly minWidth: number;
  readonly maxWidth: number;
}

export interface ImageSize {
  readonly width: number;
  readonly height: number | null;
}

/**
 * Resolve the bounds a committed width must satisfy.
 *
 * `contentWidthPx` is measured from the `--notted-page-content-width` custom
 * property published by `page-geometry.ts` — the exact width of the writable
 * column. It is deliberately *not* recomputed from page size and margins here:
 * two independent derivations of the same number drift.
 *
 * `null` means the property could not be measured (jsdom, an editor rendered
 * outside `PageContainer`, or an export context). The fallback is the contract's
 * own `maxImageDimension`, which is the widest value the document may store at
 * all — a figure then stays inside the page purely through CSS `max-width`, and
 * nothing is clamped to a number this module guessed.
 */
export function resolveImageResizeBounds(contentWidthPx: number | null): ImageResizeBounds {
  const ceiling =
    contentWidthPx === null || !Number.isFinite(contentWidthPx) || contentWidthPx <= 0
      ? NOTE_DOCUMENT_LIMITS.maxImageDimension
      : Math.min(Math.round(contentWidthPx), NOTE_DOCUMENT_LIMITS.maxImageDimension);
  // A page narrower than the minimum is pathological, but the bounds must still
  // be orderable or every clamp below would invert.
  return { minWidth: Math.min(IMAGE_MIN_WIDTH_PX, ceiling), maxWidth: ceiling };
}

export function clampImageWidth(width: number, bounds: ImageResizeBounds): number {
  if (!Number.isFinite(width)) return bounds.minWidth;
  return Math.min(bounds.maxWidth, Math.max(bounds.minWidth, Math.round(width)));
}

/** Heights are bounded only by the contract; the page scrolls vertically. */
export function clampImageHeight(height: number): number {
  if (!Number.isFinite(height)) return 1;
  return Math.min(NOTE_DOCUMENT_LIMITS.maxImageDimension, Math.max(1, Math.round(height)));
}

/**
 * Which way a corner handle grows the box.
 *
 * A west handle grows the figure as the pointer moves *left* (a negative delta),
 * a north handle as it moves *up*. Getting this wrong makes two of the four
 * corners resize backwards, which is why it is a named table rather than a sign
 * buried in the drag handler.
 */
const HANDLE_DIRECTIONS: Readonly<Record<ImageResizeHandle, { x: 1 | -1; y: 1 | -1 }>> =
  Object.freeze({
    nw: { x: -1, y: -1 },
    ne: { x: 1, y: -1 },
    sw: { x: -1, y: 1 },
    se: { x: 1, y: 1 },
  });

export interface ImageResizeInput {
  readonly handle: ImageResizeHandle;
  /** The box at pointer-down, in CSS pixels. */
  readonly startWidth: number;
  readonly startHeight: number | null;
  /** Pointer travel since pointer-down, in CSS pixels. */
  readonly deltaX: number;
  readonly deltaY: number;
  /** True while Shift is held. Sampled live, never only at pointer-down. */
  readonly freeform: boolean;
  readonly bounds: ImageResizeBounds;
}

/**
 * The box a drag has reached.
 *
 * **Locked (the default):** the horizontal travel alone drives the width and the
 * height follows from the ratio the figure started at. Using the horizontal axis
 * as the sole input is what makes the gesture predictable — mixing both axes
 * makes a diagonal drag feel like it fights the pointer, and a ratio-locked
 * corner drag has only one degree of freedom by definition.
 *
 * **Freeform (Shift held):** each axis drives its own dimension.
 *
 * A figure with no stored height (nothing has ever measured it) simply has no
 * ratio to preserve, so it resizes in width only and reports `height: null`
 * rather than inventing one.
 *
 * ## Zoom
 *
 * The deltas are raw `clientX`/`clientY` differences and **must not be divided
 * by the zoom scale** — the identical finding Part 42 recorded for the drop
 * handler (`CustomImage.ts`, Decision 7). The paper sits inside a
 * `transform: scale()`, so the handle's own rect is already reported in scaled
 * viewport space; the pointer delta and the element it is resizing therefore
 * carry the same scale, and the committed width is expressed in the paper's own
 * untransformed pixels because the frame's inline `width` is a layout value.
 * Dividing one side of that would make the figure drift away from the pointer.
 */
export function resizeImage(input: ImageResizeInput): ImageSize {
  const direction = HANDLE_DIRECTIONS[input.handle];
  const ratio =
    input.startHeight === null || input.startHeight <= 0 || input.startWidth <= 0
      ? null
      : input.startWidth / input.startHeight;

  const width = clampImageWidth(input.startWidth + input.deltaX * direction.x, input.bounds);

  if (input.freeform) {
    if (input.startHeight === null) return { width, height: null };
    return { width, height: clampImageHeight(input.startHeight + input.deltaY * direction.y) };
  }
  if (ratio === null) return { width, height: null };
  return { width, height: clampImageHeight(width / ratio) };
}

/**
 * One keyboard step, always ratio-locked.
 *
 * Keyboard resize has no second axis to offer, so there is no freeform variant:
 * an author who needs a specific height uses the pointer. The clamp is the same
 * one the drag commits through, so the two paths can never disagree about what
 * fits on the page.
 */
export function stepImageWidth(
  current: ImageSize,
  step: number,
  bounds: ImageResizeBounds,
): ImageSize {
  const ratio =
    current.height === null || current.height <= 0 || current.width <= 0
      ? null
      : current.width / current.height;
  const width = clampImageWidth(current.width + step, bounds);
  if (ratio === null) return { width, height: null };
  return { width, height: clampImageHeight(width / ratio) };
}

/**
 * The width a stored figure should actually be painted at.
 *
 * A Part 42 image stored its *intrinsic* width, which can be far wider than the
 * page. Clamping on read keeps such a figure inside the column without rewriting
 * anything: the document is only changed when an author resizes it.
 */
export function displayImageWidth(
  storedWidth: number | null,
  bounds: ImageResizeBounds,
): number | null {
  if (storedWidth === null || !Number.isFinite(storedWidth) || storedWidth <= 0) return null;
  return Math.min(bounds.maxWidth, Math.round(storedWidth));
}
