// Part 63 — renders `buildStandaloneHtml`'s output to a PDF buffer.
//
// This service NEVER navigates: `page.goto` would let the document reach a
// URL, and `buildStandaloneHtml` guarantees the HTML has no external
// references anyway. `page.setContent` is the only entry point, and every
// defensive control below (JS disabled, offline mode, request interception,
// print media emulation) runs before it.

import { Inject, Injectable } from "@nestjs/common";
import { clampMargins } from "@notted/shared-types";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { EXPORT_CONFIG, type ExportConfig } from "../config/export.config";

import { BrowserPoolService } from "./browser-pool.service";

import type { InterceptedRequest, PdfOptions } from "./puppeteer-launcher.provider";
import type { PageMargins } from "@notted/shared-types";

/**
 * Minimum top/bottom margin band (millimetres) a header/footer template is
 * allowed to render into. Chromium clips a header/footer template that does
 * not fit the reserved margin band rather than shrinking it, so an
 * unsuppressed template on a tight margin would silently eat the first line
 * of page content instead of failing loudly. `PageMargins.y` is symmetric
 * (it is both the top AND bottom margin), so the same threshold gates both
 * bands.
 */
const HEADER_FOOTER_MIN_MARGIN_MM = 10;

const HEADER_FOOTER_STYLE =
  "font-size:9px;width:100%;text-align:center;color:#666;padding:0 10mm;box-sizing:border-box;";

/** Valid empty markup — NOT an empty string, which Puppeteer treats as "no template" and falls back to its own default (url/title/date) header. */
const EMPTY_HEADER_FOOTER_TEMPLATE = "<div></div>";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

@Injectable()
export class PdfExportService {
  constructor(
    private readonly browserPool: BrowserPoolService,
    @Inject(EXPORT_CONFIG) private readonly config: ExportConfig,
    private readonly logger: StructuredLogger,
  ) {}

  isEnabled(): boolean {
    return this.browserPool.isEnabled();
  }

  async render(input: {
    readonly html: string;
    readonly margins: PageMargins;
    readonly headerText: string | null;
    readonly footerText: string | null;
  }): Promise<Buffer> {
    // The caller already clamps margins; clamping again is free and this
    // module must never trust an upstream invariant it can cheaply reverify.
    const margins = clampMargins(input.margins);
    const pdfOptions = this.buildPdfOptions(margins, input.headerText, input.footerText);

    // Part 77 residual — sub-stage attribution inside the render, so the ~36 s
    // that `job.export.wait` cannot account for can be pinned on browser-context
    // acquisition, `setContent`, or `page.pdf` instead of on "rendering". Marks
    // only; nothing branches on them.
    const startedAt = performance.now();

    return this.browserPool.withPage(async (page) => {
      // Includes the incognito-context + page creation, and a cold Chromium
      // launch on the one job in a batch that pays for it.
      const pageAcquiredAt = performance.now();
      page.setDefaultTimeout(this.config.renderTimeoutMs);
      await page.setJavaScriptEnabled(false);

      let abortedRequestCount = 0;
      await page.setRequestInterception(true);
      page.on("request", (request: InterceptedRequest) => {
        if (request.url().startsWith("data:")) {
          void request.continue();
        } else {
          abortedRequestCount += 1;
          void request.abort();
        }
      });

      await page.setOfflineMode(true);
      await page.emulateMediaType("print");
      const pageConfiguredAt = performance.now();

      await page.setContent(input.html, {
        waitUntil: "load",
        timeout: this.config.renderTimeoutMs,
      });
      const contentSetAt = performance.now();

      const bytes = await page.pdf(pdfOptions);

      // A COUNT ONLY — never a URL. `buildStandaloneHtml` emits no external
      // reference at all, so the expected value is 0 and any non-zero count
      // means a document tried to leave the sandbox and was stopped.
      //
      // Emitted AFTER `page.pdf` so the same line can carry the stage timings;
      // interception is still armed during printing, so a request aborted then
      // is now counted rather than missed.
      this.logger.info(
        {
          component: "export-pdf",
          outcome: "rendered",
          abortedRequestCount,
          pageAcquireMs: Math.round(pageAcquiredAt - startedAt),
          pageConfigureMs: Math.round(pageConfiguredAt - pageAcquiredAt),
          setContentMs: Math.round(contentSetAt - pageConfiguredAt),
          pdfMs: Math.round(performance.now() - contentSetAt),
        },
        "PDF export blocked outbound requests",
      );

      if (bytes.byteLength > this.config.maxArtifactBytes) {
        throw new Error("Generated PDF exceeds the maximum export artifact size");
      }
      return Buffer.from(bytes);
    });
  }

  private buildPdfOptions(
    margins: PageMargins,
    headerText: string | null,
    footerText: string | null,
  ): PdfOptions {
    // ONE boolean, not two. `PageMargins.y` is a single symmetric value used
    // for BOTH the top and the bottom band, so a separate `suppressHeader` and
    // `suppressFooter` could never disagree — two names would only imply a
    // distinction the geometry does not have. If margins ever become
    // asymmetric, that is the moment to split this, not before.
    const suppressBands = margins.y < HEADER_FOOTER_MIN_MARGIN_MM;

    // `format`/`margin` are deliberately absent from BOTH shapes: the page
    // geometry comes exclusively from the `@page` rule baked into the HTML by
    // `buildStandaloneHtml`. Passing either here would silently win over the
    // stylesheet and defeat the "matches the editor's print output" criterion.
    if (suppressBands) {
      return { preferCSSPageSize: true, printBackground: true };
    }

    return {
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: this.headerTemplate(headerText),
      footerTemplate: this.footerTemplate(footerText),
    };
  }

  private headerTemplate(headerText: string | null): string {
    if (headerText === null || headerText === "") {
      return EMPTY_HEADER_FOOTER_TEMPLATE;
    }
    return `<div style="${HEADER_FOOTER_STYLE}">${escapeHtml(headerText)}</div>`;
  }

  private footerTemplate(footerText: string | null): string {
    const label = footerText === null || footerText === "" ? "" : `${escapeHtml(footerText)} — `;
    return `<div style="${HEADER_FOOTER_STYLE}">${label}<span class="pageNumber"></span> / <span class="totalPages"></span></div>`;
  }
}
