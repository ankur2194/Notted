// Part 41: the variant vocabulary and its dimension arithmetic.
//
// Deliberately DEPENDENCY-FREE. Nothing here imports sharp, so the rules can be
// unit-tested without a decoder and the same numbers can be quoted in
// documentation, in the client pre-flight, and in review.
//
// IMPORTANT — these functions are a PLANNING estimate, not an oracle. The
// dimensions actually persisted come from sharp's own `info.width`/`info.height`
// after encoding, because libvips does not use one uniform rounding rule: a
// PNG source resizes with round-to-nearest, while a JPEG source may first
// shrink-on-load by a power of two inside libjpeg and land a pixel away. Using
// sharp's reported output as the record of truth means the stored dimensions can
// never disagree with the stored bytes; `fitInside` is what decides *whether*
// and *roughly how far* to resize.
//
// `Notted.md` specifies thumbnail 200 / medium 800 / full "original". This module
// refines the last one: `full` is a BOUNDED, metadata-stripped re-encode, and
// `original` keeps the true uploaded bytes for retention and reprocessing.
// A literal "full = original" would ship EXIF/GPS to every viewer and let a
// 60 MP photograph be `<img>`-ed directly. `original` is not addressable through
// the `?variant=` enum, so the refinement costs nothing at the wire.

/** Longest-edge ceiling for the `full` rendition. */
export const FULL_LONGEST_EDGE_PX = 2_000;
/** Width ceiling for the `medium` rendition. */
export const MEDIUM_WIDTH_PX = 800;
/** Width ceiling for the `thumbnail` rendition. */
export const THUMBNAIL_WIDTH_PX = 200;
/** Width of the inline blur placeholder. */
export const BLUR_WIDTH_PX = 16;

export const FULL_JPEG_QUALITY = 82;
export const FULL_WEBP_QUALITY = 82;
export const MEDIUM_WEBP_QUALITY = 80;
export const THUMBNAIL_WEBP_QUALITY = 70;
export const BLUR_WEBP_QUALITY = 40;

/**
 * Hard ceiling for `variants.blur.dataUri`, enforced here, in the shared Zod
 * schema, and at the point of generation.
 *
 * A 16 px WebP measures 150–400 bytes in practice (44 bytes for a flat test
 * image). If an encoder ever exceeds this, the placeholder is DROPPED and the
 * upload still succeeds — a decorative blur must never be able to fail an
 * upload, and must never be able to inject a megabyte string into every
 * `AttachmentSummary` in a note's listing.
 */
export const MAX_BLUR_DATA_URI_BYTES = 2_048;

export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

export interface FitBounds {
  readonly width?: number;
  readonly height?: number;
}

function isPositiveInteger(value: number): boolean {
  return Number.isFinite(value) && value >= 1;
}

/**
 * sharp's `fit: "inside"` + `withoutEnlargement: true` arithmetic: scale down by
 * the tightest supplied bound, never scale up, never distort, never round to
 * zero. An omitted bound is unconstrained.
 */
export function fitInside(source: Dimensions, bounds: FitBounds): Dimensions {
  if (!isPositiveInteger(source.width) || !isPositiveInteger(source.height)) {
    throw new Error("fitInside requires positive source dimensions");
  }
  const horizontal =
    bounds.width === undefined || !isPositiveInteger(bounds.width)
      ? Number.POSITIVE_INFINITY
      : bounds.width / source.width;
  const vertical =
    bounds.height === undefined || !isPositiveInteger(bounds.height)
      ? Number.POSITIVE_INFINITY
      : bounds.height / source.height;
  // `withoutEnlargement`: 1 is the ceiling, so a 100 px source stays 100 px.
  const scale = Math.min(horizontal, vertical, 1);
  if (scale === 1) return Object.freeze({ width: source.width, height: source.height });
  return Object.freeze({
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  });
}

/** `fitInside` expressed as a single longest-edge ceiling (used by `full`). */
export function boundLongestEdge(source: Dimensions, longestEdge: number): Dimensions {
  return fitInside(source, { width: longestEdge, height: longestEdge });
}

/**
 * Whether a rendition needs a resize step at all. `full` still re-encodes when
 * this is false — that is what strips the metadata — but skipping the resize
 * avoids a pointless resample of an already-small image.
 */
export function needsResize(source: Dimensions, target: Dimensions): boolean {
  return target.width !== source.width || target.height !== source.height;
}

/**
 * Target width for an ANIMATED source bounded by its longest edge.
 *
 * Animated images are read as a vertical filmstrip: `metadata.height` is
 * `pageHeight * pages`, so the caller must supply the per-FRAME height. Only a
 * width is returned because passing a height alongside `animated: true` bounds
 * the strip rather than the frame, which silently drops most of the animation.
 */
export function animatedTargetWidth(frame: Dimensions, longestEdge: number): number {
  const bounded = boundLongestEdge(frame, longestEdge);
  return bounded.width;
}

/** Build the `data:` URI for the blur placeholder. Never enters a document. */
export function blurDataUri(body: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${body.toString("base64")}`;
}

/** True when the placeholder is small enough to ride along with the metadata. */
export function blurDataUriWithinBudget(dataUri: string): boolean {
  return Buffer.byteLength(dataUri, "utf8") <= MAX_BLUR_DATA_URI_BYTES;
}
