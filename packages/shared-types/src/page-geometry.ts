import type { PageSize } from "./note";

/**
 * Physical page geometry for the note page container (Part 37).
 *
 * Every value here is pure and framework-free so the arithmetic can be tested
 * without a layout engine: jsdom reports every rect as zero, so `PageContainer`
 * keeps no geometry of its own beyond the measurements it feeds in here.
 *
 * The page box is expressed in *physical CSS units* (`mm`, `in`), never in a
 * pixel constant. CSS defines `1in = 96px` and `1mm = 96/25.4px` exactly, so
 * `210mm` renders as 793.7px and `8.5in` as 816px without the layout depending
 * on a number this module invented. Driving the box off the physical unit keeps
 * the on-screen paper, the printed sheet, and the `@page` rule Part 38 adds all
 * derived from the same declared size. The pixel numbers below are therefore
 * *expectations used for verification*, not inputs.
 */

/** CSS reference pixels per inch, as defined by the CSS spec. */
export const PX_PER_INCH = 96;
/** Millimetres per CSS reference pixel (`25.4 / 96`). */
export const MM_PER_PX = 25.4 / PX_PER_INCH;
/** CSS reference pixels per millimetre. */
export const PX_PER_MM = PX_PER_INCH / 25.4;

export type PageLengthUnit = "mm" | "in";

export interface PageLength {
  readonly value: number;
  readonly unit: PageLengthUnit;
}

export interface PageDefinition {
  /** Human-readable name used in controls and announcements. */
  readonly label: string;
  readonly width: PageLength;
  readonly height: PageLength;
}

export interface PixelBox {
  readonly width: number;
  readonly height: number;
}

/**
 * The two supported sheets, in the units their standards define them in.
 *
 * A4 is metric (210mm x 297mm) and US Letter is imperial (8.5in x 11in);
 * restating either one in the other unit would bake in a rounding error.
 */
export const PAGE_SIZES: Readonly<Record<PageSize, PageDefinition>> = Object.freeze({
  a4: {
    label: "A4",
    width: { value: 210, unit: "mm" },
    height: { value: 297, unit: "mm" },
  },
  letter: {
    label: "US Letter",
    width: { value: 8.5, unit: "in" },
    height: { value: 11, unit: "in" },
  },
});

export const PAGE_SIZE_VALUES: readonly PageSize[] = Object.freeze(["a4", "letter"] as const);

/** The CSS length string for a physical page length, e.g. `"210mm"`. */
export function cssLength(length: PageLength): string {
  return `${length.value}${length.unit}`;
}

/** Exact CSS reference pixels for a physical length (unrounded). */
export function exactPx(length: PageLength): number {
  return length.unit === "in" ? length.value * PX_PER_INCH : length.value * PX_PER_MM;
}

/**
 * The whole-pixel size a browser measurement is expected to round to.
 *
 * A4 is 793.70px wide, so a measured box is never an exact integer; rounding to
 * the nearest pixel is what makes "794 x 1123" and "816 x 1056" checkable in a
 * browser. Layout itself is never driven by these numbers.
 */
export function roundedPx(length: PageLength): number {
  return Math.round(exactPx(length));
}

/** Nominal unscaled page box in CSS pixels, rounded for measurement. */
export function pageBoxPx(size: PageSize): PixelBox {
  const page = PAGE_SIZES[size];
  return { width: roundedPx(page.width), height: roundedPx(page.height) };
}

export interface MillimetreBox {
  readonly width: number;
  readonly height: number;
}

/** Page dimensions in millimetres, whatever unit the sheet is defined in. */
export function pageDimensionsMm(size: PageSize): MillimetreBox {
  const page = PAGE_SIZES[size];
  return { width: exactPx(page.width) * MM_PER_PX, height: exactPx(page.height) * MM_PER_PX };
}

export interface PageMargins {
  /** Left and right margin, in millimetres. */
  readonly x: number;
  /** Top and bottom margin, in millimetres. */
  readonly y: number;
}

/** Notted.md: 25mm top/bottom, 20mm left/right. */
export const DEFAULT_PAGE_MARGINS: PageMargins = Object.freeze({ x: 20, y: 25 });

/**
 * A margin may never consume more than this share of its page dimension.
 *
 * Beyond roughly 40% per side there is no content column left at all, so a
 * stored or typed value past the limit is treated as invalid rather than
 * rendered as an unusable page.
 */
export const MARGIN_LIMIT_RATIO = 0.4;

function marginLimit(axis: "width" | "height"): number {
  const smallest = Math.min(...PAGE_SIZE_VALUES.map((size) => pageDimensionsMm(size)[axis]));
  return Math.floor(smallest * MARGIN_LIMIT_RATIO);
}

/**
 * Largest margin that still leaves a content column on *every* supported sheet.
 *
 * Margins are a single global preference while the page size is per note, so
 * the limit is the strictest of the two sheets: 84mm horizontally (A4 is the
 * narrower) and 111mm vertically (US Letter is the shorter).
 */
export const MAX_PAGE_MARGINS: PageMargins = Object.freeze({
  x: marginLimit("width"),
  y: marginLimit("height"),
});

export const MIN_PAGE_MARGIN_MM = 0;

/** Whether a single margin value is usable as-is. */
export function isValidMargin(value: unknown, axis: keyof PageMargins): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_PAGE_MARGIN_MM &&
    value <= MAX_PAGE_MARGINS[axis]
  );
}

/** Force a margin pair into the usable range, rounded to whole millimetres. */
export function clampMargins(margins: PageMargins): PageMargins {
  const clamp = (value: number, axis: keyof PageMargins): number => {
    if (!Number.isFinite(value)) return DEFAULT_PAGE_MARGINS[axis];
    return Math.min(MAX_PAGE_MARGINS[axis], Math.max(MIN_PAGE_MARGIN_MM, Math.round(value)));
  };
  return { x: clamp(margins.x, "x"), y: clamp(margins.y, "y") };
}

/**
 * Width of the writable column, as a CSS length.
 *
 * `calc()` is used unconditionally because US Letter is declared in inches
 * while margins are in millimetres; letting the browser mix the units avoids
 * converting either one by hand.
 */
export function pageContentWidthCss(size: PageSize, margins: PageMargins): string {
  return `calc(${cssLength(PAGE_SIZES[size].width)} - ${margins.x * 2}mm)`;
}

/** Width of the writable column in CSS pixels, rounded for measurement. */
export function pageContentWidthPx(size: PageSize, margins: PageMargins): number {
  return Math.round(exactPx(PAGE_SIZES[size].width) - margins.x * 2 * PX_PER_MM);
}

/**
 * Height of one printed page's writable column, in CSS pixels.
 *
 * This is the unit visual pagination steps by: the on-screen paper is one
 * continuous column with a single top and bottom margin, and printing slices
 * that column into chunks of exactly this height.
 */
export function pageContentHeightPx(size: PageSize, margins: PageMargins): number {
  return Math.round(exactPx(PAGE_SIZES[size].height) - margins.y * 2 * PX_PER_MM);
}

/**
 * The custom properties the paper element publishes.
 *
 * `--notted-page-content-width` is a **public token**: it is the exact width of
 * the writable column, and any later part that must not let content escape the
 * page — Part 43 clamps embedded image widths to it — reads it from here rather
 * than recomputing the arithmetic. Custom properties inherit, so every
 * descendant of the paper element can use it.
 */
export function pageCustomProperties(
  size: PageSize,
  margins: PageMargins,
): Readonly<Record<string, string>> {
  const page = PAGE_SIZES[size];
  return {
    "--notted-page-width": cssLength(page.width),
    "--notted-page-height": cssLength(page.height),
    "--notted-page-margin-x": `${margins.x}mm`,
    "--notted-page-margin-y": `${margins.y}mm`,
    "--notted-page-content-width": pageContentWidthCss(size, margins),
  };
}

/** The discrete zoom levels Notted.md specifies, as scale factors. */
export const ZOOM_LEVELS: readonly number[] = Object.freeze([0.5, 0.75, 1, 1.25, 1.5]);

export type ZoomFitMode = "fit-width" | "fit-page";
/** Either a fixed scale factor or a mode resolved against the viewport. */
export type ZoomSelection = number | ZoomFitMode;

export const ZOOM_FIT_MODES: readonly ZoomFitMode[] = Object.freeze(["fit-width", "fit-page"]);

export const DEFAULT_ZOOM: ZoomSelection = 1;

/**
 * Bounds for any resolved scale. A fit mode in a very narrow or very wide
 * container must still produce a legible, finite page rather than a sliver or a
 * wall.
 */
export const MIN_ZOOM_SCALE = 0.25;
export const MAX_ZOOM_SCALE = 3;

/**
 * Padding between the scroll viewport's edge and the paper, in CSS pixels.
 *
 * It must stay equal to the `padding` of `.notted-page-viewport` in
 * `globals.css`: fit modes subtract it from the measured `clientWidth` /
 * `clientHeight`, which include padding.
 */
export const PAGE_VIEWPORT_PADDING_PX = 32;

export function isZoomFitMode(value: unknown): value is ZoomFitMode {
  return value === "fit-width" || value === "fit-page";
}

/** Whether a value is one of the discrete levels or a fit mode. */
export function isZoomSelection(value: unknown): value is ZoomSelection {
  return isZoomFitMode(value) || (typeof value === "number" && ZOOM_LEVELS.includes(value));
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_ZOOM_SCALE, Math.max(MIN_ZOOM_SCALE, scale));
}

/**
 * Turn a zoom selection plus a measured viewport into a numeric scale.
 *
 * An unmeasured viewport — server render, first paint, or jsdom, where every
 * box is zero and `ResizeObserver` does not exist — resolves to 1 instead of
 * dividing by zero. The container therefore degrades to the fixed levels
 * wherever measurement is unavailable, and never renders a NaN transform.
 */
export function resolveZoomScale(
  selection: ZoomSelection,
  viewport: PixelBox,
  size: PageSize,
): number {
  if (typeof selection === "number") return clampScale(selection);
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return 1;
  }

  const page = pageBoxPx(size);
  const availableWidth = viewport.width - PAGE_VIEWPORT_PADDING_PX * 2;
  const widthScale = availableWidth / page.width;
  if (selection === "fit-width") return round(clampScale(widthScale), 4);

  const availableHeight = viewport.height - PAGE_VIEWPORT_PADDING_PX * 2;
  const heightScale = availableHeight / page.height;
  return round(clampScale(Math.min(widthScale, heightScale)), 4);
}

/**
 * The layout size the wrapper around the paper must take.
 *
 * `transform: scale()` is a paint-time operation: it never changes the space
 * the element reserves. Without sizing the wrapper to the scaled box, a zoomed
 * page either overflows its scroll extents (clipping the bottom and sides) or
 * leaves dead space below it. `box` is the paper's *unscaled* layout box —
 * `offsetWidth`/`offsetHeight`, which ignore transforms — so a page that has
 * grown past one sheet is accounted for.
 */
export function scaledPageBox(box: PixelBox, scale: number): PixelBox {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const width = Number.isFinite(box.width) && box.width > 0 ? box.width : 0;
  const height = Number.isFinite(box.height) && box.height > 0 ? box.height : 0;
  return { width: Math.round(width * factor), height: Math.round(height * factor) };
}

/**
 * Where a scroll offset must move so the same content stays under the caret
 * after a zoom change. Applied per axis.
 */
export function preservedScrollOffset(offset: number, before: number, after: number): number {
  if (!Number.isFinite(offset) || offset <= 0) return 0;
  if (!Number.isFinite(before) || before <= 0) return offset;
  if (!Number.isFinite(after) || after <= 0) return offset;
  return Math.round(offset * (after / before));
}

function nearestZoomIndex(scale: number): number {
  if (!Number.isFinite(scale)) return ZOOM_LEVELS.indexOf(1);
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  ZOOM_LEVELS.forEach((level, index) => {
    const distance = Math.abs(level - scale);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

/**
 * The level one step from the current *resolved* scale.
 *
 * Stepping is defined against the resolved scale rather than the selection so
 * that leaving a fit mode lands on the nearest fixed level instead of jumping.
 */
export function zoomLevelStep(scale: number, direction: 1 | -1): number {
  const index = nearestZoomIndex(scale);
  const nextIndex = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, index + direction));
  return ZOOM_LEVELS[nextIndex] ?? 1;
}

/** Whether a step in that direction would actually change the level. */
export function canStepZoom(scale: number, direction: 1 | -1): boolean {
  const index = nearestZoomIndex(scale);
  return direction === 1 ? index < ZOOM_LEVELS.length - 1 : index > 0;
}

/** How a zoom selection is announced and labelled. */
export function zoomLabel(selection: ZoomSelection): string {
  if (selection === "fit-width") return "Fit to width";
  if (selection === "fit-page") return "Fit to page";
  return `${Math.round(selection * 100)}%`;
}

/** How a page size is announced and labelled. */
export function pageSizeLabel(size: PageSize): string {
  return PAGE_SIZES[size].label;
}

/* -------------------------------------------------------------------------- */
/* Part 38: visual pagination                                                  */
/* -------------------------------------------------------------------------- */

/** Where a printed page boundary falls, and why. */
export type PageBoundaryKind = "explicit" | "implicit";

export interface PageBoundary {
  /** Distance from the top of the content column, in whole CSS pixels. */
  readonly offset: number;
  /** `explicit` for a stored `pageBreak` node; `implicit` for a full page. */
  readonly kind: PageBoundaryKind;
  /** 1-based number of the page that ends at this boundary. */
  readonly page: number;
}

export interface PageBoundaryInput {
  /** Measured height of the flowed content column, in CSS pixels. */
  readonly contentHeight: number;
  /** Printable height of one page's content column (`pageContentHeightPx`). */
  readonly pageContentHeight: number;
  /**
   * Offsets of explicit `pageBreak` nodes from the top of the same content
   * column, in CSS pixels. Read from the DOM; never derived from the document.
   */
  readonly explicitBreaks: readonly number[];
}

/**
 * Guard against a pathological measurement (a near-zero page height, or a
 * content column measured while a font was still loading) turning into an
 * unbounded loop that would paint thousands of guides.
 */
export const MAX_PAGE_BOUNDARIES = 200;

/**
 * Where the dashed page-boundary guides go.
 *
 * **Purely derived, never destructive.** The stored TipTap document has no idea
 * a boundary exists: the only inputs are two measured heights and the measured
 * positions of the explicit break nodes that *are* stored, and the only output
 * is a list of offsets to paint into an `aria-hidden`, pointer-events-none
 * overlay. Nothing here can reorder, split, or insert content — that separation
 * is the whole point of Part 37's "visual pagination is not stored content".
 *
 * The model is the on-screen paper's: one continuous column, sliced every
 * `pageContentHeight` pixels, with an explicit break ending its page early. A
 * boundary is only reported when content actually continues past it, so a note
 * shorter than one page shows no guides at all.
 */
export function pageBoundaryOffsets(input: PageBoundaryInput): readonly PageBoundary[] {
  const { contentHeight, pageContentHeight } = input;
  if (!Number.isFinite(pageContentHeight) || pageContentHeight <= 0) return [];
  if (!Number.isFinite(contentHeight) || contentHeight <= 0) return [];

  const explicit = [
    ...new Set(input.explicitBreaks.filter((offset) => Number.isFinite(offset) && offset > 0)),
  ].sort((left, right) => left - right);

  const boundaries: PageBoundary[] = [];
  let cursor = 0;
  let index = 0;

  while (boundaries.length < MAX_PAGE_BOUNDARIES) {
    // Explicit breaks at or above the cursor have already ended a page.
    while (index < explicit.length && (explicit[index] ?? 0) <= cursor) index += 1;

    const limit = cursor + pageContentHeight;
    const next = index < explicit.length ? (explicit[index] ?? null) : null;
    const isExplicit = next !== null && next <= limit;
    const offset = isExplicit ? next : limit;

    // Nothing flows past this offset, so there is no boundary to indicate.
    if (offset >= contentHeight) break;

    boundaries.push({
      offset: Math.round(offset),
      kind: isExplicit ? "explicit" : "implicit",
      page: boundaries.length + 1,
    });
    if (isExplicit) index += 1;
    cursor = offset;
  }

  return boundaries;
}

/**
 * The `@page` rule for the current sheet and margins.
 *
 * `@page` cannot be selected by a class, so it has to be emitted as a rule for
 * the page currently being viewed (see `PagePrintStyle`). Every interpolated
 * value comes from the validated `PAGE_SIZES` table or from `clampMargins`,
 * which returns whole millimetres inside `MAX_PAGE_MARGINS` — no caller-supplied
 * string ever reaches the stylesheet.
 *
 * Part 63 (PDF/HTML export) builds the same rule from the same function so a
 * server-rendered export paginates exactly like the editor did.
 */
export function pageRuleCss(size: PageSize, margins: PageMargins): string {
  const page = PAGE_SIZES[size] ?? PAGE_SIZES.a4;
  const safe = clampMargins(margins);
  return (
    `@page { size: ${cssLength(page.width)} ${cssLength(page.height)}; ` +
    `margin: ${safe.y}mm ${safe.x}mm; }`
  );
}
