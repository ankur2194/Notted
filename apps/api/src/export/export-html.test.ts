import { clampMargins, pageRuleCss } from "@notted/shared-types";
import { describe, expect, it } from "vitest";

import { buildStandaloneHtml, printStylesheet } from "./export-html";

import type { PageMargins } from "@notted/shared-types";

const DOCUMENT = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }],
};

describe("buildStandaloneHtml", () => {
  it("emits the minimal base typographic style block", () => {
    const html = buildStandaloneHtml({
      title: "Note",
      document: DOCUMENT,
      pageSize: "a4",
      margins: { x: 20, y: 25 },
    });

    // Distinctive to the base style block this module writes, not to print.css.
    expect(html).toContain("box-sizing: border-box");
    expect(html).toContain("font-family: -apple-system");
  });

  it("embeds the exact pageRuleCss output for a4", () => {
    const margins = { x: 20, y: 25 };
    const html = buildStandaloneHtml({
      title: "Note",
      document: DOCUMENT,
      pageSize: "a4",
      margins,
    });

    expect(html).toContain(pageRuleCss("a4", margins));
  });

  it("embeds the exact pageRuleCss output for letter", () => {
    const margins = { x: 20, y: 25 };
    const html = buildStandaloneHtml({
      title: "Note",
      document: DOCUMENT,
      pageSize: "letter",
      margins,
    });

    expect(html).toContain(pageRuleCss("letter", margins));
  });

  it("clamps a hostile out-of-range margin pair before using it anywhere", () => {
    const hostile: PageMargins = { x: 9999, y: -5 };
    const html = buildStandaloneHtml({
      title: "Note",
      document: DOCUMENT,
      pageSize: "a4",
      margins: hostile,
    });

    const clamped = clampMargins(hostile);
    expect(html).toContain(pageRuleCss("a4", hostile)); // pageRuleCss clamps internally too
    expect(html).not.toContain("margin: -5mm 9999mm");
    expect(html).toContain(`margin: ${clamped.y}mm ${clamped.x}mm`);
  });

  it("clamps NaN margins to the documented default rather than emitting NaN", () => {
    const hostile: PageMargins = { x: Number.NaN, y: Number.NaN };
    const html = buildStandaloneHtml({
      title: "Note",
      document: DOCUMENT,
      pageSize: "a4",
      margins: hostile,
    });

    const clamped = clampMargins(hostile);
    expect(html).not.toContain("NaN");
    expect(html).toContain(`margin: ${clamped.y}mm ${clamped.x}mm`);
  });

  it("embeds the exact, verbatim bytes of the shared print.css", () => {
    const html = buildStandaloneHtml({
      title: "Note",
      document: DOCUMENT,
      pageSize: "a4",
      margins: { x: 20, y: 25 },
    });

    // Selector genuinely present in packages/shared-validators/print.css.
    expect(printStylesheet()).toContain(".notted-attachment-actions");
    expect(html).toContain(".notted-attachment-actions");
    expect(html).toContain(printStylesheet());
  });

  it("emits the @page rule AFTER print.css so the sheet default cannot win the cascade", () => {
    // print.css carries its own standalone `@page { size: 210mm 297mm; ... }`.
    // `@page` has no selector, so the LAST rule wins: a US Letter export whose
    // rule was emitted before the stylesheet would silently print on A4.
    const html = buildStandaloneHtml({
      title: "Note",
      document: DOCUMENT,
      pageSize: "letter",
      margins: { x: 10, y: 12 },
    });

    const rule = pageRuleCss("letter", { x: 10, y: 12 });
    expect(html.indexOf(rule)).toBeGreaterThan(html.indexOf(printStylesheet()));
    // The A4 default from print.css is still present, and still loses.
    expect(html).toContain("210mm 297mm");
    expect(html.lastIndexOf("@page")).toBe(html.indexOf(rule));
  });

  it("HTML-escapes the title so no script tag or style break-out survives", () => {
    const hostileTitle = "</style><script>alert(1)</script>";
    const html = buildStandaloneHtml({
      title: hostileTitle,
      document: DOCUMENT,
      pageSize: "a4",
      margins: { x: 20, y: 25 },
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("</style><script>");
    expect(html).toContain("&lt;/style&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("contains no reference that could make a renderer reach the network", () => {
    const html = buildStandaloneHtml({
      title: "Note",
      document: DOCUMENT,
      pageSize: "a4",
      margins: { x: 20, y: 25 },
    });

    expect(html).not.toContain("<link");
    expect(html).not.toContain("@import");
    expect(html).not.toContain('src="http');
    // Strip HTML comments before checking for a bare "://" so a future code
    // comment mentioning a URL scheme cannot fail this on its own.
    const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
    expect(withoutComments).not.toContain("://");
  });

  it("renders exactly one <h1> title in the body (renderDocumentHtml never emits its own root heading)", () => {
    const html = buildStandaloneHtml({
      title: "Meeting Notes",
      document: DOCUMENT,
      pageSize: "a4",
      margins: { x: 20, y: 25 },
    });

    const h1Occurrences = html.split("<h1>Meeting Notes</h1>").length - 1;
    expect(h1Occurrences).toBe(1);
  });
});

describe("printStylesheet", () => {
  it("memoizes and returns the same content on repeated calls", () => {
    expect(printStylesheet()).toBe(printStylesheet());
    expect(printStylesheet().length).toBeGreaterThan(0);
  });
});
