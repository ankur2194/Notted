// Part 63 — the PDF export renderer against a REAL Chromium binary.
//
// GATED ON THE CHROMIUM BINARY EXISTING, not on `DATABASE_URL`: this suite
// touches no database at all. `EXPORT_CHROMIUM_PATH` (falling back to
// `/usr/bin/chromium`, which is what the `workspace-chromium` Docker target
// and ADR 0008 pin) resolves the binary; when it is absent — a plain
// developer laptop — the whole suite self-skips rather than failing on
// missing infrastructure. Inside the `workspace-chromium` container it runs
// for real.
//
// The whole point of this file is proving the composite of FOUR independent
// SSRF defenses actually holds (see the last test): `setContent` rather than
// `goto`, JavaScript disabled, request interception aborting every
// non-`data:` URL, and Chromium launched with `--host-resolver-rules=MAP *
// ~NOTFOUND` plus offline mode. None of those are asserted individually here
// — only the end-to-end guarantee a hostile document cannot make Chromium
// touch the network is asserted, because that is the guarantee that matters.
//
// Collaborators are constructed BY HAND, matching every neighbouring
// integration test in this directory (see `email-delivery.integration.test.ts`)
// and this repo's dependency policy: `@nestjs/testing` is not an installed
// dependency of `apps/api`, so `Test.createTestingModule` is not available
// here, and adding it would be a new dependency for a test file to pull in.

import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";

import { DEFAULT_PAGE_MARGINS, PAGE_SIZES, PX_PER_INCH, exactPx } from "@notted/shared-types";
import { NOTE_DOCUMENT_NODE_TYPES, renderDocumentHtml } from "@notted/shared-validators";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserPoolService } from "../src/export/browser-pool.service";
import { buildStandaloneHtml, printStylesheet } from "../src/export/export-html";
import { PdfExportService } from "../src/export/pdf-export.service";
import { puppeteerLauncherProvider } from "../src/export/puppeteer-launcher.provider";

import type { StructuredLogger } from "../src/common/logging/structured-logger.service";
import type { ExportConfig } from "../src/config/export.config";
import type { BrowserLauncher } from "../src/export/puppeteer-launcher.provider";
import type { ValueProvider } from "@nestjs/common";
import type { PageSize } from "@notted/shared-types";

const CHROMIUM_PATH = process.env.EXPORT_CHROMIUM_PATH ?? "/usr/bin/chromium";
const HAS_CHROMIUM = existsSync(CHROMIUM_PATH);

const requireFromTest = createRequire(__filename);

const SIMPLE_DOCUMENT = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello, export." }] }],
};

// `pageBreak` is the real node type: `NOTE_DOCUMENT_NODE_TYPES` in
// `packages/shared-validators/src/document.schema.ts` and
// `PAGE_BREAK_NODE_NAME` in `apps/web/src/components/editor/extensions/page-break.ts`
// both name it `"pageBreak"`, and `renderDocumentHtml` emits it as
// `<div class="notted-page-break"></div>` (`document.schema.ts` line 1413).
const TWO_PAGE_DOCUMENT = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Page one." }] },
    { type: "pageBreak" },
    { type: "paragraph", content: [{ type: "text", text: "Page two." }] },
  ],
};

const PDF_POINTS_PER_INCH = 72;

/** PDF `MediaBox` is in points (1/72in); `PAGE_SIZES` is physical mm/in. */
function expectedPageBoxPt(size: PageSize): { readonly width: number; readonly height: number } {
  const page = PAGE_SIZES[size];
  const pxToPt = (px: number): number => (px / PX_PER_INCH) * PDF_POINTS_PER_INCH;
  return { width: pxToPt(exactPx(page.width)), height: pxToPt(exactPx(page.height)) };
}

function expectApprox(actual: number, expected: number, tolerance = 1): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

/**
 * Chromium's `page.pdf()` output stores its page dictionaries inside
 * Flate-compressed object streams, not as plain text in the top-level bytes —
 * confirmed prior art in this exact repo: `apps/web/e2e/print-export.spec.ts`
 * (Part 38's own browser verification) documents needing to inflate every
 * `stream`...`endstream` block with `node:zlib` before `/MediaBox` and
 * `/Type /Page` become regex-visible at all. This mirrors that proven
 * technique rather than trusting an ungrounded assumption that the raw bytes
 * alone are enough. `node:zlib` is a builtin, so this adds no dependency.
 */
function inflatedStreams(pdf: Buffer): string {
  const parts: string[] = [];
  const begin = Buffer.from("stream");
  const end = Buffer.from("endstream");
  let index = pdf.indexOf(begin);
  while (index !== -1) {
    let start = index + begin.length;
    if (pdf[start] === 0x0d) start += 1;
    if (pdf[start] === 0x0a) start += 1;
    const stop = pdf.indexOf(end, start);
    if (stop === -1) break;
    try {
      parts.push(inflateSync(pdf.subarray(start, stop)).toString("latin1"));
    } catch {
      // Not a Flate stream (or not a stream at all); the raw source covers it.
    }
    index = pdf.indexOf(begin, stop + end.length);
  }
  return parts.join("\n");
}

/** Raw bytes plus every inflated stream, concatenated into one searchable string. */
function pdfSource(pdf: Buffer): string {
  return `${pdf.toString("latin1")}\n${inflatedStreams(pdf)}`;
}

/** Parse every `/MediaBox [ x0 y0 x1 y1 ]` out of the (possibly-inflated) PDF source. */
function mediaBoxes(source: string): Array<{ readonly width: number; readonly height: number }> {
  const matches = [
    ...source.matchAll(/\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/g),
  ];
  return matches.map((match) => ({
    width: Number(match[3]) - Number(match[1]),
    height: Number(match[4]) - Number(match[2]),
  }));
}

/**
 * Count `/Type /Page` page objects. `(?!s)` is load-bearing: it excludes the
 * `/Type /Pages` tree-root object, which is a byte-for-byte prefix of every
 * `/Type /Page` match and would otherwise inflate the count by exactly the
 * number of intermediate page-tree nodes. Falls back to the page-tree's own
 * `/Count` when no direct `/Type /Page` object is visible even after
 * inflation (an object-stream layout the naive scan cannot unpack) —
 * mirroring `print-export.spec.ts`'s `pdfPageCount` fallback exactly.
 */
function countPages(source: string): number {
  const direct = (source.match(/\/Type\s*\/Page(?!s)\b/g) ?? []).length;
  if (direct > 0) return direct;
  const counted = /\/Type\s*\/Pages(?:[^>]|>(?!>))*?\/Count\s+(\d+)/.exec(source);
  return counted === null ? 0 : Number(counted[1]);
}

/**
 * The REAL `puppeteer-core` adapter, taken straight off the provider
 * `ExportModule` registers — no fake, and no second copy of the launch logic
 * that could drift from production. `puppeteerLauncherProvider` is a Nest
 * `ValueProvider` (the launcher is stateless and dependency-free, so it needs
 * no class), and these suites bypass the container by hand exactly like every
 * neighbouring integration test does.
 */
function realLauncher(): BrowserLauncher {
  const { useValue } = puppeteerLauncherProvider as ValueProvider<BrowserLauncher>;
  if (useValue === undefined) {
    throw new Error("expected puppeteerLauncherProvider to be a Nest useValue provider");
  }
  return useValue;
}

/**
 * Matches the fake used by `browser-pool.service.test.ts`/`pdf-export.service.test.ts`
 * — only Chromium behaviour is under test here, not logging.
 *
 * `warning` is the structured member `BrowserPoolService` actually calls; `warn`
 * is the unrelated NestJS `LoggerService` one. Both are supplied because the
 * `as unknown as` cast hides a missing method until it is called at runtime.
 */
function fakeLogger(): StructuredLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    warning: () => undefined,
    failure: () => undefined,
  } as unknown as StructuredLogger;
}

describe.skipIf(!HAS_CHROMIUM)("Part 63 PDF export (real Chromium)", () => {
  let pdfExportService: PdfExportService;
  let browserPoolService: BrowserPoolService;
  let ssrfServer: Server;
  let ssrfConnectionCount = 0;
  let ssrfOrigin: string;

  beforeAll(async () => {
    const exportConfig: ExportConfig = Object.freeze({
      chromiumPath: CHROMIUM_PATH,
      renderTimeoutMs: 60_000,
      maxArtifactBytes: 26_214_400,
    });

    browserPoolService = new BrowserPoolService(realLauncher(), exportConfig, fakeLogger());
    pdfExportService = new PdfExportService(browserPoolService, exportConfig, fakeLogger());
    expect(pdfExportService.isEnabled()).toBe(true);

    // Counts at the `connection` (TCP) event, not `request` (HTTP): a request
    // interception abort that never completes an HTTP round trip still opens
    // (or attempts to open) a socket, and that attempt is what must be zero.
    ssrfServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("should never be reached");
    });
    ssrfServer.on("connection", () => {
      ssrfConnectionCount += 1;
    });
    await new Promise<void>((resolve) => ssrfServer.listen(0, "127.0.0.1", resolve));
    const address = ssrfServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected the SSRF probe server to bind an ephemeral TCP port");
    }
    ssrfOrigin = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    // Bypassing Nest's container means its lifecycle hooks never fire on
    // their own; called directly so no Chromium process survives the run.
    await browserPoolService.onModuleDestroy();
    await new Promise<void>((resolve, reject) => {
      ssrfServer.close((error) => (error ? reject(error) : resolve()));
    });
  }, 60_000);

  it("renders an A4 page box", async () => {
    const html = buildStandaloneHtml({
      title: "A4 export",
      document: SIMPLE_DOCUMENT,
      pageSize: "a4",
      margins: DEFAULT_PAGE_MARGINS,
    });

    const pdf = await pdfExportService.render({
      html,
      margins: DEFAULT_PAGE_MARGINS,
      headerText: null,
      footerText: null,
    });

    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const boxes = mediaBoxes(pdfSource(pdf));
    expect(boxes.length).toBeGreaterThan(0);
    const expected = expectedPageBoxPt("a4");
    expectApprox(boxes[0]!.width, expected.width);
    expectApprox(boxes[0]!.height, expected.height);
  }, 60_000);

  it("renders a US Letter page box, and it is not the A4 box", async () => {
    const html = buildStandaloneHtml({
      title: "Letter export",
      document: SIMPLE_DOCUMENT,
      pageSize: "letter",
      margins: DEFAULT_PAGE_MARGINS,
    });

    const pdf = await pdfExportService.render({
      html,
      margins: DEFAULT_PAGE_MARGINS,
      headerText: null,
      footerText: null,
    });

    const boxes = mediaBoxes(pdfSource(pdf));
    expect(boxes.length).toBeGreaterThan(0);
    const letterExpected = expectedPageBoxPt("letter");
    expectApprox(boxes[0]!.width, letterExpected.width);
    expectApprox(boxes[0]!.height, letterExpected.height);

    // The regression guard: `print.css` ships its own default A4 `@page`
    // rule, and if `pageRuleCss` were emitted before the stylesheet instead
    // of after, that default would silently win the cascade and every
    // Letter export would come out A4-shaped.
    const a4Expected = expectedPageBoxPt("a4");
    expect(Math.abs(boxes[0]!.width - a4Expected.width)).toBeGreaterThan(1);
    expect(Math.abs(boxes[0]!.height - a4Expected.height)).toBeGreaterThan(1);
  }, 60_000);

  it("an explicit page break produces exactly two pages", async () => {
    expect(NOTE_DOCUMENT_NODE_TYPES).toContain("pageBreak");

    // `renderDocumentHtml` really emits the break, and `print.css` really
    // gives it `break-after: page` — both read from source, not assumed.
    const bodyHtml = renderDocumentHtml(TWO_PAGE_DOCUMENT);
    expect(bodyHtml).toContain('class="notted-page-break"');
    expect(printStylesheet()).toContain(".notted-page-break");
    expect(printStylesheet()).toContain("break-after: page");

    const html = buildStandaloneHtml({
      title: "Two pages",
      document: TWO_PAGE_DOCUMENT,
      pageSize: "a4",
      margins: DEFAULT_PAGE_MARGINS,
    });

    const pdf = await pdfExportService.render({
      html,
      margins: DEFAULT_PAGE_MARGINS,
      headerText: null,
      footerText: null,
    });

    expect(countPages(pdfSource(pdf))).toBe(2);
  }, 60_000);

  it("SSRF PROOF: a hostile document cannot make Chromium touch the network, and the export still succeeds", async () => {
    const html = buildStandaloneHtml({
      title: "Hostile export",
      document: SIMPLE_DOCUMENT,
      pageSize: "a4",
      margins: DEFAULT_PAGE_MARGINS,
    });

    // Splice in every reference shape a hostile note could carry: an <img>,
    // an <a>, a stylesheet <link>, and a CSS @import — each pointed at the
    // real, listening probe server.
    const hostileHead = `<link rel="stylesheet" href="${ssrfOrigin}/style.css"><style>@import url("${ssrfOrigin}/import.css");</style></head>`;
    const hostileBody = `<img src="${ssrfOrigin}/pixel.png"><a href="${ssrfOrigin}/link">reach me</a></body>`;
    const hostileHtml = html.replace("</head>", hostileHead).replace("</body>", hostileBody);
    expect(hostileHtml).not.toBe(html);
    expect(hostileHtml).toContain(ssrfOrigin);

    const pdf = await pdfExportService.render({
      html: hostileHtml,
      margins: DEFAULT_PAGE_MARGINS,
      headerText: null,
      footerText: null,
    });

    // The export still succeeds and produces a valid PDF...
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(mediaBoxes(pdfSource(pdf)).length).toBeGreaterThan(0);
    // ...and the listener recorded ZERO connections. This is the composite
    // proof; it must not be weakened even if it is inconvenient to satisfy.
    expect(ssrfConnectionCount).toBe(0);
  }, 60_000);

  it("printStylesheet() is byte-identical to packages/shared-validators/print.css", () => {
    const resolvedPrintCssPath = requireFromTest.resolve("@notted/shared-validators/print.css");
    const onDisk = readFileSync(resolvedPrintCssPath, "utf8");
    expect(printStylesheet()).toBe(onDisk);
  });
});
