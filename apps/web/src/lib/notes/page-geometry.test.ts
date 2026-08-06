import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_MARGINS,
  MAX_PAGE_BOUNDARIES,
  MAX_PAGE_MARGINS,
  MAX_ZOOM_SCALE,
  MIN_ZOOM_SCALE,
  PAGE_SIZES,
  PAGE_VIEWPORT_PADDING_PX,
  ZOOM_LEVELS,
  canStepZoom,
  clampMargins,
  cssLength,
  exactPx,
  isValidMargin,
  isZoomFitMode,
  isZoomSelection,
  pageBoundaryOffsets,
  pageBoxPx,
  pageContentHeightPx,
  pageContentWidthCss,
  pageContentWidthPx,
  pageCustomProperties,
  pageDimensionsMm,
  pageRuleCss,
  pageSizeLabel,
  preservedScrollOffset,
  resolveZoomScale,
  scaledPageBox,
  zoomLabel,
  zoomLevelStep,
} from "./page-geometry";

/** The rounding `resolveZoomScale` applies to a fit-mode result. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

describe("physical page dimensions", () => {
  it("declares each sheet in the unit its standard uses", () => {
    expect(cssLength(PAGE_SIZES.a4.width)).toBe("210mm");
    expect(cssLength(PAGE_SIZES.a4.height)).toBe("297mm");
    expect(cssLength(PAGE_SIZES.letter.width)).toBe("8.5in");
    expect(cssLength(PAGE_SIZES.letter.height)).toBe("11in");
  });

  it("measures A4 as 794 x 1123 CSS pixels at 100%", () => {
    // Notted.md: 210mm x 297mm, ~794px x 1123px at 96 DPI. The box is driven by
    // the millimetre value; these are the measurements it must produce.
    expect(pageBoxPx("a4")).toEqual({ width: 794, height: 1123 });
    expect(exactPx(PAGE_SIZES.a4.width)).toBeCloseTo(793.7007874, 6);
    expect(exactPx(PAGE_SIZES.a4.height)).toBeCloseTo(1122.5196850393, 6);
  });

  it("measures US Letter as 816 x 1056 CSS pixels at 100%", () => {
    expect(pageBoxPx("letter")).toEqual({ width: 816, height: 1056 });
    // Inches are exact at 96px per inch, so no rounding is involved at all.
    expect(exactPx(PAGE_SIZES.letter.width)).toBe(816);
    expect(exactPx(PAGE_SIZES.letter.height)).toBe(1056);
  });

  it("restates both sheets in millimetres without a hand-converted constant", () => {
    expect(pageDimensionsMm("a4").width).toBeCloseTo(210, 9);
    expect(pageDimensionsMm("a4").height).toBeCloseTo(297, 9);
    expect(pageDimensionsMm("letter").width).toBeCloseTo(215.9, 9);
    expect(pageDimensionsMm("letter").height).toBeCloseTo(279.4, 9);
  });

  it("labels each sheet for controls and announcements", () => {
    expect(pageSizeLabel("a4")).toBe("A4");
    expect(pageSizeLabel("letter")).toBe("US Letter");
  });
});

describe("margins and the content column", () => {
  it("defaults to the specified 20mm sides and 25mm top and bottom", () => {
    expect(DEFAULT_PAGE_MARGINS).toEqual({ x: 20, y: 25 });
  });

  it("caps a margin at the strictest sheet so a content column always remains", () => {
    // A4 is the narrower sheet (210mm) and US Letter the shorter (279.4mm).
    expect(MAX_PAGE_MARGINS).toEqual({ x: 84, y: 111 });
    expect(MAX_PAGE_MARGINS.x * 2).toBeLessThan(pageDimensionsMm("a4").width);
    expect(MAX_PAGE_MARGINS.y * 2).toBeLessThan(pageDimensionsMm("letter").height);
  });

  it("accepts only finite in-range numbers as a margin", () => {
    expect(isValidMargin(20, "x")).toBe(true);
    expect(isValidMargin(0, "x")).toBe(true);
    expect(isValidMargin(MAX_PAGE_MARGINS.x, "x")).toBe(true);
    expect(isValidMargin(MAX_PAGE_MARGINS.x + 1, "x")).toBe(false);
    expect(isValidMargin(-1, "y")).toBe(false);
    expect(isValidMargin(Number.NaN, "y")).toBe(false);
    expect(isValidMargin(Number.POSITIVE_INFINITY, "y")).toBe(false);
    expect(isValidMargin("20", "x")).toBe(false);
    expect(isValidMargin(null, "x")).toBe(false);
  });

  it("clamps an out-of-range pair and falls back for a non-numeric one", () => {
    expect(clampMargins({ x: -5, y: 10_000 })).toEqual({ x: 0, y: MAX_PAGE_MARGINS.y });
    expect(clampMargins({ x: 20.4, y: 25.6 })).toEqual({ x: 20, y: 26 });
    expect(clampMargins({ x: Number.NaN, y: Number.POSITIVE_INFINITY })).toEqual(
      DEFAULT_PAGE_MARGINS,
    );
  });

  it("expresses the content column as calc so mixed units stay exact", () => {
    expect(pageContentWidthCss("a4", DEFAULT_PAGE_MARGINS)).toBe("calc(210mm - 40mm)");
    expect(pageContentWidthCss("letter", DEFAULT_PAGE_MARGINS)).toBe("calc(8.5in - 40mm)");
    expect(pageContentWidthCss("a4", { x: 0, y: 0 })).toBe("calc(210mm - 0mm)");
  });

  it("computes the content column width in pixels for measurement", () => {
    expect(pageContentWidthPx("a4", DEFAULT_PAGE_MARGINS)).toBe(643);
    expect(pageContentWidthPx("letter", DEFAULT_PAGE_MARGINS)).toBe(665);
    expect(pageContentWidthPx("a4", { x: 0, y: 0 })).toBe(794);
  });

  it("publishes the paper custom properties, including the public content token", () => {
    expect(pageCustomProperties("a4", DEFAULT_PAGE_MARGINS)).toEqual({
      "--notted-page-width": "210mm",
      "--notted-page-height": "297mm",
      "--notted-page-margin-x": "20mm",
      "--notted-page-margin-y": "25mm",
      "--notted-page-content-width": "calc(210mm - 40mm)",
    });
    expect(pageCustomProperties("letter", { x: 10, y: 15 })).toEqual({
      "--notted-page-width": "8.5in",
      "--notted-page-height": "11in",
      "--notted-page-margin-x": "10mm",
      "--notted-page-margin-y": "15mm",
      "--notted-page-content-width": "calc(8.5in - 20mm)",
    });
  });
});

describe("zoom selection", () => {
  it("publishes exactly the specified levels and fit modes", () => {
    expect(ZOOM_LEVELS).toEqual([0.5, 0.75, 1, 1.25, 1.5]);
    expect(isZoomFitMode("fit-width")).toBe(true);
    expect(isZoomFitMode("fit-page")).toBe(true);
    expect(isZoomFitMode("fit-everything")).toBe(false);
    expect(isZoomSelection(1.25)).toBe(true);
    expect(isZoomSelection("fit-page")).toBe(true);
    expect(isZoomSelection(0.6)).toBe(false);
    expect(isZoomSelection("125")).toBe(false);
    expect(isZoomSelection(null)).toBe(false);
  });

  it("resolves every fixed level to itself", () => {
    for (const level of ZOOM_LEVELS) {
      expect(resolveZoomScale(level, { width: 1000, height: 800 }, "a4")).toBe(level);
    }
  });

  it("clamps an out-of-range numeric selection", () => {
    expect(resolveZoomScale(0.01, { width: 1000, height: 800 }, "a4")).toBe(MIN_ZOOM_SCALE);
    expect(resolveZoomScale(99, { width: 1000, height: 800 }, "a4")).toBe(MAX_ZOOM_SCALE);
    expect(resolveZoomScale(Number.NaN, { width: 1000, height: 800 }, "a4")).toBe(1);
  });

  it("fits the width of the sheet inside the padded viewport", () => {
    const available = 1000 - PAGE_VIEWPORT_PADDING_PX * 2;
    expect(resolveZoomScale("fit-width", { width: 1000, height: 800 }, "a4")).toBe(
      round4(available / 794),
    );
    expect(resolveZoomScale("fit-width", { width: 1000, height: 800 }, "letter")).toBe(
      round4(available / 816),
    );
    // Height is irrelevant to fit-width: a short viewport gives the same scale.
    expect(resolveZoomScale("fit-width", { width: 1000, height: 120 }, "a4")).toBe(
      resolveZoomScale("fit-width", { width: 1000, height: 800 }, "a4"),
    );
  });

  it("fits the whole sheet by taking the more constrained axis", () => {
    const scale = resolveZoomScale("fit-page", { width: 1000, height: 800 }, "a4");
    expect(scale).toBe(round4((800 - PAGE_VIEWPORT_PADDING_PX * 2) / 1123));
    expect(scale).toBeLessThan(resolveZoomScale("fit-width", { width: 1000, height: 800 }, "a4"));
    // A very tall viewport makes width the constraint again.
    expect(resolveZoomScale("fit-page", { width: 900, height: 4000 }, "a4")).toBe(
      resolveZoomScale("fit-width", { width: 900, height: 4000 }, "a4"),
    );
  });

  it("falls back to 100% instead of dividing by an unmeasured viewport", () => {
    // jsdom, the server render, and the first paint all report a zero box.
    expect(resolveZoomScale("fit-width", { width: 0, height: 0 }, "a4")).toBe(1);
    expect(resolveZoomScale("fit-page", { width: 0, height: 0 }, "letter")).toBe(1);
    expect(resolveZoomScale("fit-width", { width: -10, height: 500 }, "a4")).toBe(1);
    expect(resolveZoomScale("fit-page", { width: Number.NaN, height: 500 }, "a4")).toBe(1);
    expect(resolveZoomScale("fit-page", { width: 500, height: Number.NaN }, "a4")).toBe(1);
  });

  it("keeps a fit scale inside the legibility bounds", () => {
    expect(resolveZoomScale("fit-width", { width: 60, height: 60 }, "a4")).toBe(MIN_ZOOM_SCALE);
    expect(resolveZoomScale("fit-width", { width: 20_000, height: 20_000 }, "a4")).toBe(
      MAX_ZOOM_SCALE,
    );
  });

  it("steps between neighbouring levels and stops at the ends", () => {
    expect(zoomLevelStep(1, 1)).toBe(1.25);
    expect(zoomLevelStep(1, -1)).toBe(0.75);
    expect(zoomLevelStep(1.5, 1)).toBe(1.5);
    expect(zoomLevelStep(0.5, -1)).toBe(0.5);
    // Leaving a fit mode lands on the nearest fixed level rather than jumping.
    expect(zoomLevelStep(1.18, -1)).toBe(1);
    expect(zoomLevelStep(1.18, 1)).toBe(1.5);
    expect(zoomLevelStep(Number.NaN, 1)).toBe(1.25);
  });

  it("reports when a step would do nothing, so the control can say so", () => {
    expect(canStepZoom(1, 1)).toBe(true);
    expect(canStepZoom(1, -1)).toBe(true);
    expect(canStepZoom(1.5, 1)).toBe(false);
    expect(canStepZoom(0.5, -1)).toBe(false);
    expect(canStepZoom(0.5, 1)).toBe(true);
    expect(canStepZoom(1.5, -1)).toBe(true);
  });

  it("labels a selection for the control and the announcement", () => {
    expect(zoomLabel(0.5)).toBe("50%");
    expect(zoomLabel(0.75)).toBe("75%");
    expect(zoomLabel(1)).toBe("100%");
    expect(zoomLabel(1.25)).toBe("125%");
    expect(zoomLabel(1.5)).toBe("150%");
    expect(zoomLabel("fit-width")).toBe("Fit to width");
    expect(zoomLabel("fit-page")).toBe("Fit to page");
  });
});

describe("scaled layout and scroll", () => {
  it("reserves the scaled box so a zoomed sheet is neither clipped nor padded", () => {
    // `transform: scale()` does not change reserved space, so the wrapper must
    // carry the scaled size or the scroll extents are wrong.
    expect(scaledPageBox({ width: 794, height: 1123 }, 1)).toEqual({ width: 794, height: 1123 });
    expect(scaledPageBox({ width: 794, height: 1123 }, 0.5)).toEqual({ width: 397, height: 562 });
    expect(scaledPageBox({ width: 794, height: 1123 }, 1.5)).toEqual({ width: 1191, height: 1685 });
    // A note longer than one sheet reserves its measured height, not the sheet's.
    expect(scaledPageBox({ width: 794, height: 3000 }, 1.25)).toEqual({
      width: 993,
      height: 3750,
    });
  });

  it("treats an unmeasured or invalid box and scale as inert", () => {
    expect(scaledPageBox({ width: 0, height: 0 }, 1.5)).toEqual({ width: 0, height: 0 });
    expect(scaledPageBox({ width: 794, height: 1123 }, Number.NaN)).toEqual({
      width: 794,
      height: 1123,
    });
    expect(scaledPageBox({ width: 794, height: 1123 }, 0)).toEqual({ width: 794, height: 1123 });
    expect(scaledPageBox({ width: Number.NaN, height: -10 }, 2)).toEqual({ width: 0, height: 0 });
  });

  it("moves a scroll offset so the same content stays in view across a zoom change", () => {
    expect(preservedScrollOffset(200, 1, 1.5)).toBe(300);
    expect(preservedScrollOffset(300, 1.5, 1)).toBe(200);
    expect(preservedScrollOffset(0, 1, 1.5)).toBe(0);
    expect(preservedScrollOffset(201, 1, 0.5)).toBe(101);
  });

  it("leaves the offset alone when either scale is unusable", () => {
    expect(preservedScrollOffset(200, 0, 1.5)).toBe(200);
    expect(preservedScrollOffset(200, 1, 0)).toBe(200);
    expect(preservedScrollOffset(200, Number.NaN, 1.5)).toBe(200);
    expect(preservedScrollOffset(200, 1, Number.NaN)).toBe(200);
    expect(preservedScrollOffset(Number.NaN, 1, 1.5)).toBe(0);
    expect(preservedScrollOffset(-5, 1, 1.5)).toBe(0);
  });
});

describe("Part 38 printable page height", () => {
  it("subtracts both vertical margins from the declared sheet height", () => {
    // A4 is 1122.52px tall; 25mm top and bottom removes 2 x 94.49px.
    expect(pageContentHeightPx("a4", DEFAULT_PAGE_MARGINS)).toBe(934);
    // US Letter is exactly 1056px tall.
    expect(pageContentHeightPx("letter", DEFAULT_PAGE_MARGINS)).toBe(867);
    expect(pageContentHeightPx("a4", { x: 20, y: 0 })).toBe(1123);
  });
});

describe("Part 38 page boundary offsets", () => {
  const PAGE = 900;

  function offsets(
    contentHeight: number,
    explicitBreaks: readonly number[] = [],
    pageContentHeight = PAGE,
  ) {
    return pageBoundaryOffsets({ contentHeight, pageContentHeight, explicitBreaks });
  }

  it("draws nothing for an empty or unmeasured column", () => {
    expect(offsets(0)).toEqual([]);
    expect(offsets(-10)).toEqual([]);
    expect(offsets(Number.NaN)).toEqual([]);
    // jsdom and the server render report every box as zero, which must degrade
    // to "no guides" rather than to a division by zero.
    expect(offsets(1000, [], 0)).toEqual([]);
    expect(offsets(1000, [], Number.NaN)).toEqual([]);
  });

  it("draws nothing when the content fits on one page", () => {
    expect(offsets(400)).toEqual([]);
    // Exactly one full page still has nothing flowing past its bottom edge.
    expect(offsets(PAGE)).toEqual([]);
  });

  it("marks each implicit boundary once content flows past it", () => {
    expect(offsets(PAGE + 1)).toEqual([{ offset: 900, kind: "implicit", page: 1 }]);
    expect(offsets(PAGE * 3 + 10)).toEqual([
      { offset: 900, kind: "implicit", page: 1 },
      { offset: 1800, kind: "implicit", page: 2 },
      { offset: 2700, kind: "implicit", page: 3 },
    ]);
  });

  it("ends a page early at an explicit break and restarts the run from there", () => {
    expect(offsets(2000, [300])).toEqual([
      { offset: 300, kind: "explicit", page: 1 },
      { offset: 1200, kind: "implicit", page: 2 },
    ]);
  });

  it("interleaves explicit breaks with the implicit boundaries between them", () => {
    expect(offsets(3000, [300, 2000])).toEqual([
      { offset: 300, kind: "explicit", page: 1 },
      { offset: 1200, kind: "implicit", page: 2 },
      { offset: 2000, kind: "explicit", page: 3 },
      { offset: 2900, kind: "implicit", page: 4 },
    ]);
  });

  it("collapses duplicate, unusable, and consecutive explicit breaks", () => {
    expect(offsets(1500, [400, 400, 0, -20, Number.NaN, 500])).toEqual([
      { offset: 400, kind: "explicit", page: 1 },
      { offset: 500, kind: "explicit", page: 2 },
      { offset: 1400, kind: "implicit", page: 3 },
    ]);
  });

  it("ignores an explicit break that nothing follows", () => {
    expect(offsets(500, [500])).toEqual([]);
    expect(offsets(500, [600])).toEqual([]);
  });

  it("rounds to whole pixels and stays bounded for a pathological measurement", () => {
    expect(offsets(100, [], 33.4)).toEqual([
      { offset: 33, kind: "implicit", page: 1 },
      { offset: 67, kind: "implicit", page: 2 },
    ]);
    expect(offsets(1_000_000, [], 1)).toHaveLength(MAX_PAGE_BOUNDARIES);
  });
});

describe("Part 38 @page rule", () => {
  it("states the declared sheet in its own units and the current margins", () => {
    expect(pageRuleCss("a4", DEFAULT_PAGE_MARGINS)).toBe(
      "@page { size: 210mm 297mm; margin: 25mm 20mm; }",
    );
    expect(pageRuleCss("letter", { x: 12, y: 30 })).toBe(
      "@page { size: 8.5in 11in; margin: 30mm 12mm; }",
    );
  });

  it("emits only clamped whole millimetres, so nothing arbitrary reaches the stylesheet", () => {
    expect(pageRuleCss("a4", { x: 20.6, y: 24.4 })).toBe(
      "@page { size: 210mm 297mm; margin: 24mm 21mm; }",
    );
    expect(pageRuleCss("a4", { x: 9_000, y: -5 })).toBe(
      `@page { size: 210mm 297mm; margin: 0mm ${MAX_PAGE_MARGINS.x}mm; }`,
    );
    expect(pageRuleCss("a4", { x: Number.NaN, y: Number.NaN })).toBe(
      "@page { size: 210mm 297mm; margin: 25mm 20mm; }",
    );
  });
});
