import { describe, expect, it, vi } from "vitest";

import { PdfExportService } from "./pdf-export.service";

import type { BrowserPoolService } from "./browser-pool.service";
import type { InterceptedRequest, PageHandle, PdfOptions } from "./puppeteer-launcher.provider";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { ExportConfig } from "../config/export.config";

// Fakes are NOT declared as extending the real interfaces (vitest's `Mock`
// return type does not satisfy TypeScript's interface-extends compatibility
// check even where it structurally satisfies the interface); each fake is
// cast to its real counterpart only where it crosses into production code,
// matching `ObjectStorageService`'s test convention.

function fakeRequest(url: string) {
  return {
    url: () => url,
    abort: vi.fn(async () => undefined),
    continue: vi.fn(async () => undefined),
  };
}
type FakeRequest = ReturnType<typeof fakeRequest>;

/**
 * A fake `PageHandle` whose `setContent` simulates any requests the "loaded"
 * document would have issued, firing them through the handler the service
 * registered via `page.on("request", ...)` — this is what lets the
 * interception tests below observe abort/continue behaviour without a real
 * browser.
 */
function fakePage(
  options: { readonly pdfBytes?: Uint8Array; readonly requestUrls?: readonly string[] } = {},
) {
  let requestHandler: ((request: InterceptedRequest) => void) | null = null;
  const requests: FakeRequest[] = [];
  const page = {
    setJavaScriptEnabled: vi.fn(async () => undefined),
    setRequestInterception: vi.fn(async () => undefined),
    setOfflineMode: vi.fn(async () => undefined),
    setDefaultTimeout: vi.fn(),
    on: vi.fn((event: "request", handler: (request: InterceptedRequest) => void) => {
      if (event === "request") requestHandler = handler;
    }),
    setContent: vi.fn(async () => {
      for (const url of options.requestUrls ?? []) {
        const request = fakeRequest(url);
        requests.push(request);
        requestHandler?.(request as unknown as InterceptedRequest);
      }
    }),
    emulateMediaType: vi.fn(async () => undefined),
    pdf: vi.fn(async (): Promise<Uint8Array> => options.pdfBytes ?? new Uint8Array([1, 2, 3])),
    close: vi.fn(async () => undefined),
    goto: vi.fn(),
    requests,
  };
  return page;
}
type FakePage = ReturnType<typeof fakePage>;

function asPage(page: FakePage): PageHandle {
  return page as unknown as PageHandle;
}

function fakeBrowserPool(page: FakePage, enabled = true): BrowserPoolService {
  return {
    isEnabled: vi.fn(() => enabled),
    withPage: vi.fn(async (use: (p: PageHandle) => Promise<unknown>) => use(asPage(page))),
  } as unknown as BrowserPoolService;
}

function logger(): StructuredLogger {
  return { info: vi.fn(), warn: vi.fn() } as unknown as StructuredLogger;
}

function config(overrides: Partial<ExportConfig> = {}): ExportConfig {
  return {
    chromiumPath: "/usr/bin/chromium",
    renderTimeoutMs: 30_000,
    maxArtifactBytes: 26_214_400,
    ...overrides,
  } as ExportConfig;
}

const INPUT = {
  html: "<!doctype html><html><body>hi</body></html>",
  margins: { x: 20, y: 25 },
  headerText: null,
  footerText: null,
} as const;

function pdfOptionsOf(page: FakePage): PdfOptions {
  const call = page.pdf.mock.calls[0] as [PdfOptions] | undefined;
  if (call === undefined) throw new Error("page.pdf was never called");
  return call[0];
}

describe("PdfExportService", () => {
  it("delegates isEnabled to the browser pool", () => {
    const svc = new PdfExportService(fakeBrowserPool(fakePage(), false), config(), logger());
    expect(svc.isEnabled()).toBe(false);
  });

  it("passes preferCSSPageSize and printBackground, and never passes format or margin", async () => {
    const page = fakePage();
    const svc = new PdfExportService(fakeBrowserPool(page), config(), logger());
    await svc.render(INPUT);
    const options = pdfOptionsOf(page);
    expect(options.preferCSSPageSize).toBe(true);
    expect(options.printBackground).toBe(true);
    expect(options).not.toHaveProperty("format");
    expect(options).not.toHaveProperty("margin");
  });

  it("applies every defensive page control and never navigates", async () => {
    const page = fakePage();
    const svc = new PdfExportService(fakeBrowserPool(page), config(), logger());
    await svc.render(INPUT);
    expect(page.setJavaScriptEnabled).toHaveBeenCalledWith(false);
    expect(page.setOfflineMode).toHaveBeenCalledWith(true);
    expect(page.setRequestInterception).toHaveBeenCalledWith(true);
    expect(page.emulateMediaType).toHaveBeenCalledWith("print");
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("omits displayHeaderFooter entirely when the margin band is too small for either band", async () => {
    const page = fakePage();
    const svc = new PdfExportService(fakeBrowserPool(page), config(), logger());
    await svc.render({
      ...INPUT,
      margins: { x: 20, y: 5 },
      headerText: "Header",
      footerText: "Footer",
    });
    const options = pdfOptionsOf(page);
    expect(options.displayHeaderFooter).toBeUndefined();
    expect(options).not.toHaveProperty("headerTemplate");
    expect(options).not.toHaveProperty("footerTemplate");
  });

  it("shows an escaped header/footer with page-number classes at a generous margin", async () => {
    const page = fakePage();
    const svc = new PdfExportService(fakeBrowserPool(page), config(), logger());
    await svc.render({
      ...INPUT,
      margins: { x: 20, y: 25 },
      headerText: "<b>Notted</b>",
      footerText: "Confidential & <secret>",
    });
    const options = pdfOptionsOf(page);
    expect(options.displayHeaderFooter).toBe(true);
    expect(options.headerTemplate).toContain("&lt;b&gt;Notted&lt;/b&gt;");
    expect(options.headerTemplate).not.toContain("<b>");
    expect(options.footerTemplate).toContain("Confidential &amp; &lt;secret&gt;");
    expect(options.footerTemplate).toContain("pageNumber");
    expect(options.footerTemplate).toContain("totalPages");
  });

  it("counts zero aborted requests for a document that issues none", async () => {
    const page = fakePage();
    const log = logger();
    const svc = new PdfExportService(fakeBrowserPool(page), config(), log);
    await svc.render(INPUT);
    // `objectContaining`: the log line also carries `component`/`outcome`, which
    // are observability shape, not the fact under test.
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ abortedRequestCount: 0 }),
      expect.any(String),
    );
  });

  it("aborts every non-data request from a hostile document and allows a data: URI through", async () => {
    const page = fakePage({
      requestUrls: [
        "http://169.254.169.254/latest/meta-data/",
        "file:///etc/passwd",
        "data:text/plain;base64,aGVsbG8=",
      ],
    });
    const log = logger();
    const svc = new PdfExportService(fakeBrowserPool(page), config(), log);
    await svc.render(INPUT);

    expect(page.requests).toHaveLength(3);
    expect(page.requests[0]?.abort).toHaveBeenCalledTimes(1);
    expect(page.requests[0]?.continue).not.toHaveBeenCalled();
    expect(page.requests[1]?.abort).toHaveBeenCalledTimes(1);
    expect(page.requests[1]?.continue).not.toHaveBeenCalled();
    expect(page.requests[2]?.abort).not.toHaveBeenCalled();
    expect(page.requests[2]?.continue).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ abortedRequestCount: 2 }),
      expect.any(String),
    );
  });

  it("throws when the generated PDF exceeds the configured maximum artifact size", async () => {
    const page = fakePage({ pdfBytes: new Uint8Array(20) });
    const svc = new PdfExportService(
      fakeBrowserPool(page),
      config({ maxArtifactBytes: 10 }),
      logger(),
    );
    await expect(svc.render(INPUT)).rejects.toThrow();
  });

  it("returns a Buffer built from the raw PDF bytes", async () => {
    const bytes = new Uint8Array([37, 80, 68, 70]);
    const page = fakePage({ pdfBytes: bytes });
    const svc = new PdfExportService(fakeBrowserPool(page), config(), logger());
    const result = await svc.render(INPUT);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result).toEqual(Buffer.from(bytes));
  });
});
