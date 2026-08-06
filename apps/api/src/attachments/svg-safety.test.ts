import { describe, expect, it } from "vitest";

import {
  HOSTILE_SVGS,
  SAFE_SVG,
  SVG_WITH_DATA_IMAGE,
  oversizedSvg,
  pathologicalSvg,
} from "../../test/image-fixtures";

import { scanSvgSource } from "./svg-safety";

const LIMIT = 2 * 1_024 * 1_024;

describe("scanSvgSource", () => {
  it("accepts a document whose only references stay inside itself", () => {
    expect(scanSvgSource(Buffer.from(SAFE_SVG, "utf8"), LIMIT)).toEqual({ safe: true });
  });

  it("accepts an inline PNG data reference, which librsvg decodes without any I/O", () => {
    expect(scanSvgSource(Buffer.from(SVG_WITH_DATA_IMAGE, "utf8"), LIMIT)).toEqual({ safe: true });
  });

  it.each([
    ["script", HOSTILE_SVGS.script, "script_element"],
    ["foreignObject", HOSTILE_SVGS.foreignObject, "foreign_object"],
    // Namespace-prefixed spellings of the same two elements.
    ["svg:script", HOSTILE_SVGS.prefixedScript, "script_element"],
    ["s:foreignObject", HOSTILE_SVGS.prefixedForeignObject, "foreign_object"],
    ["entity declaration", HOSTILE_SVGS.entity, "entity_declaration"],
    ["external <image href>", HOSTILE_SVGS.externalImage, "external_reference"],
    ["external <use href>", HOSTILE_SVGS.externalUse, "external_reference"],
    ["file: xlink:href", HOSTILE_SVGS.fileXlink, "external_reference"],
    ["nested svg data: xlink:href", HOSTILE_SVGS.svgDataXlink, "external_reference"],
  ])("refuses %s", (_label, source, reason) => {
    expect(scanSvgSource(Buffer.from(source, "utf8"), LIMIT)).toEqual({ safe: false, reason });
  });

  it.each([
    ["onload", `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" onload="alert(1)"/>`],
    [
      "onclick on a child",
      `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect onclick="x()"/></svg>`,
    ],
  ])("refuses an inline %s handler", (_label, source) => {
    // Inert on this path — librsvg rasterizes and never executes script, and no
    // variant is served as `image/svg+xml`. Refused so the answer does not
    // depend on both of those staying true, and so this scan cannot be
    // repurposed as a "safe to serve as SVG" gate, which it is not.
    expect(scanSvgSource(Buffer.from(source, "utf8"), LIMIT)).toEqual({
      safe: false,
      reason: "event_handler",
    });
  });

  it("accepts a namespace-prefixed root element rather than calling it not_svg", () => {
    const source = `<svg:svg xmlns:svg="http://www.w3.org/2000/svg" width="1" height="1"><svg:rect width="1" height="1"/></svg:svg>`;
    expect(scanSvgSource(Buffer.from(source, "utf8"), LIMIT)).toEqual({ safe: true });
  });

  it("refuses a DOCTYPE internal subset even without a literal <!ENTITY", () => {
    const source = `<?xml version="1.0"?><!DOCTYPE svg [ ]><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>`;
    expect(scanSvgSource(Buffer.from(source, "utf8"), LIMIT)).toEqual({
      safe: false,
      reason: "entity_declaration",
    });
  });

  it("refuses a relative reference: the policy is an allow-list, not a scheme blocklist", () => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><use href="../other.svg#x"/></svg>`;
    expect(scanSvgSource(Buffer.from(source, "utf8"), LIMIT)).toEqual({
      safe: false,
      reason: "external_reference",
    });
  });

  it("refuses an oversized source on bytes alone, before any scanning happens", () => {
    const source = oversizedSvg(3 * 1_024 * 1_024);
    expect(source.byteLength).toBeGreaterThan(LIMIT);
    expect(scanSvgSource(source, LIMIT)).toEqual({ safe: false, reason: "too_large" });
  });

  it("refuses a non-SVG payload that reached the scanner", () => {
    expect(scanSvgSource(Buffer.from("<html><body>hi</body></html>", "utf8"), LIMIT)).toEqual({
      safe: false,
      reason: "not_svg",
    });
  });

  it("stays linear on a pathological source (no catastrophic backtracking)", () => {
    const source = pathologicalSvg(20_000);
    const started = Date.now();
    const result = scanSvgSource(source, LIMIT);
    const elapsed = Date.now() - started;

    // A verdict is reached at all...
    expect(typeof result.safe).toBe("boolean");
    // ...and it is reached in linear time. A prescan that can be made to
    // backtrack IS the denial of service it was added to prevent.
    expect(elapsed).toBeLessThan(1_000);
  });

  it("is stateless across calls despite using a global-flagged regex", () => {
    const safe = Buffer.from(SAFE_SVG, "utf8");
    const hostile = Buffer.from(HOSTILE_SVGS.externalUse, "utf8");

    expect(scanSvgSource(safe, LIMIT).safe).toBe(true);
    expect(scanSvgSource(hostile, LIMIT).safe).toBe(false);
    // A shared `lastIndex` left behind by the previous scan would make this
    // second pass silently skip the hostile reference.
    expect(scanSvgSource(hostile, LIMIT).safe).toBe(false);
    expect(scanSvgSource(safe, LIMIT).safe).toBe(true);
  });
});
