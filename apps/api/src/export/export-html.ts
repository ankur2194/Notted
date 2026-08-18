// Part 63 — the standalone HTML builder.
//
// SINGLE SOURCE OF TRUTH for both the `html` export and the `pdf` export: the
// PDF renderer feeds this exact string to Puppeteer's `page.setContent`, so
// the two formats can never drift apart. Do not build a second HTML path
// elsewhere for the PDF renderer to call — call `buildStandaloneHtml` here.
//
// Pure module function on purpose: no DI, no NestJS decorators, no I/O at
// import time. `input.document` is untrusted persisted TipTap JSON and is
// handed to `renderDocumentHtml`, which already walks it defensively.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { PAGE_SIZES, clampMargins, cssLength, pageRuleCss } from "@notted/shared-types";
import { renderDocumentHtml } from "@notted/shared-validators";

import type { PageMargins, PageSize } from "@notted/shared-types";

const requireFrom = createRequire(__filename);

let cachedPrintStylesheet: string | null = null;

/**
 * The verbatim contents of `@notted/shared-validators/print.css`, read once
 * and memoized. Resolved through the package's `exports` map (never a raw
 * relative path into another package) and read from disk lazily on first use
 * rather than at import time, so importing this module never touches the
 * filesystem by itself.
 */
export function printStylesheet(): string {
  if (cachedPrintStylesheet === null) {
    const resolved = requireFrom.resolve("@notted/shared-validators/print.css");
    cachedPrintStylesheet = readFileSync(resolved, "utf8");
  }
  return cachedPrintStylesheet;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Minimal typographic base so a standalone `.html` export is readable on
 * screen. `print.css` is almost entirely inside `@media print`, so without
 * this block an opened export would render as unstyled black-on-white system
 * text with no content column. Deliberately NOT the app's design system: a
 * system font stack, readable line-height, a centred column sized off the
 * same page geometry the `@page` rule uses, and sane spacing for the tags
 * `renderDocumentHtml` actually emits.
 */
function baseStyle(size: PageSize, margins: PageMargins): string {
  return `
    html { box-sizing: border-box; }
    *, *::before, *::after { box-sizing: inherit; }
    body {
      margin: 0 auto;
      /* Full sheet width, not the content width: box-sizing is border-box, so
         the padding below is subtracted from this and the on-screen column ends
         up exactly as wide as the printed one. Using the content width here
         would subtract the margins twice. */
      max-width: ${cssLength(PAGE_SIZES[size].width)};
      padding: ${margins.y}mm ${margins.x}mm;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial,
        sans-serif;
      line-height: 1.6;
      color: #1a1a1a;
      background: #fff;
    }
    h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.5em 0 0.5em; }
    h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
    p { margin: 0 0 1em; }
    ul, ol { margin: 0 0 1em; padding-left: 1.5em; }
    blockquote {
      margin: 0 0 1em;
      padding-left: 1em;
      border-left: 3px solid #d0d0d0;
      color: #4a4a4a;
    }
    pre {
      margin: 0 0 1em;
      padding: 0.75em 1em;
      overflow-x: auto;
      background: #f5f5f5;
      border-radius: 4px;
    }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    table { border-collapse: collapse; margin: 0 0 1em; width: 100%; }
    th, td { border: 1px solid #d0d0d0; padding: 0.4em 0.6em; text-align: left; }
    img { max-width: 100%; height: auto; }
  `;
}

/**
 * Build one self-contained HTML document from a note's title, document JSON
 * and page geometry. The returned string has no external references of any
 * kind (no `<link>`, no `@import`, no remote image or font, no `<script>`),
 * which is what keeps this safe to hand straight to Puppeteer's
 * `page.setContent` without any SSRF surface: `renderDocumentHtml` never
 * emits an `src` attribute or a URL, so nothing in the body can reach the
 * network either.
 *
 * ponytail: header/footer text (`ExportOptions.headerText`/`footerText`) is
 * deliberately not rendered into this document. An `.html` export has no
 * page boundaries, so a running header/footer isn't expressible in it, and
 * rendering it into the body would double it in the PDF export, where
 * Puppeteer's `headerTemplate`/`footerTemplate` already supply it outside
 * document flow. If a later part wants headers/footers inside the HTML
 * export itself, add it there explicitly rather than here.
 */
export function buildStandaloneHtml(input: {
  readonly title: string;
  readonly document: unknown;
  readonly pageSize: PageSize;
  readonly margins: PageMargins;
}): string {
  const margins = clampMargins(input.margins);
  const title = escapeHtml(input.title);
  // ORDER IS LOAD-BEARING, AND `pageRuleCss` MUST COME LAST.
  //
  // `print.css` ships its OWN default `@page { size: 210mm 297mm; margin: 25mm
  // 20mm; }` because it has to be usable standalone. `@page` has no selector,
  // so two `@page` rules simply cascade and the later one wins. Emitting
  // `pageRuleCss` before the stylesheet would therefore let that A4 default
  // silently override every US Letter export and every non-default margin —
  // the exact failure the "matches the editor's print output" criterion exists
  // to catch. The editor has the same ordering: `PagePrintStyle` injects its
  // rule into the DOM *after* the imported stylesheet.
  const style = [
    baseStyle(input.pageSize, margins),
    printStylesheet(),
    pageRuleCss(input.pageSize, margins),
  ].join("\n");

  return (
    "<!doctype html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${title}</title>\n` +
    `<style>${style}</style>\n` +
    "</head>\n" +
    "<body>\n" +
    `<h1>${title}</h1>\n` +
    renderDocumentHtml(input.document) +
    "\n</body>\n" +
    "</html>\n"
  );
}
