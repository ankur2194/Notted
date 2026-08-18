// Part 63 — the Puppeteer injection seam.
//
// `puppeteer-core` resolves cleanly under this project's CommonJS/Node10
// TypeScript config (verified directly: both `import type` and a value
// `import puppeteer from "puppeteer-core"` type-check against the package's
// `main`/`types` fields), so unlike `meilisearch` (ESM-only) this module does
// NOT need the dynamic-`import()` boundary used in
// `src/infrastructure/meilisearch/meilisearch.module.ts`. A plain static
// import is used below.
//
// The point of this file is testability, not runtime portability: real
// `puppeteer-core` objects carry far more surface than the module actually
// calls, so `BrowserPoolService`/`PdfExportService` depend on the narrow
// structural interfaces here instead. Unit tests supply a fully fake
// `BrowserLauncher` through the `BROWSER_LAUNCHER` token and never touch a
// real browser binary.

import puppeteer from "puppeteer-core";

import type { Provider } from "@nestjs/common";

export const BROWSER_LAUNCHER: unique symbol = Symbol("BROWSER_LAUNCHER");

export interface InterceptedRequest {
  url(): string;
  abort(): Promise<void>;
  continue(): Promise<void>;
}

/** The exact subset of `page.pdf`'s options this module passes. */
export interface PdfOptions {
  readonly preferCSSPageSize: true;
  readonly printBackground: true;
  readonly displayHeaderFooter?: boolean;
  readonly headerTemplate?: string;
  readonly footerTemplate?: string;
}

export interface PageHandle {
  setJavaScriptEnabled(enabled: boolean): Promise<void>;
  setRequestInterception(enabled: boolean): Promise<void>;
  setOfflineMode(offline: boolean): Promise<void>;
  setDefaultTimeout(timeout: number): void;
  on(event: "request", handler: (request: InterceptedRequest) => void): void;
  setContent(html: string, options: { waitUntil: "load"; timeout: number }): Promise<void>;
  emulateMediaType(type: "print"): Promise<void>;
  pdf(options: PdfOptions): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface BrowserContextHandle {
  newPage(): Promise<PageHandle>;
  close(): Promise<void>;
}

export interface LaunchedBrowser {
  createBrowserContext(): Promise<BrowserContextHandle>;
  close(): Promise<void>;
  on(event: "disconnected", handler: () => void): void;
  readonly connected: boolean;
}

export interface BrowserLauncher {
  launch(options: {
    executablePath: string;
    args: readonly string[];
    headless: boolean;
  }): Promise<LaunchedBrowser>;
}

/**
 * The real launcher, as a `useValue` object rather than an `@Injectable` class.
 *
 * It has no dependencies and no state, so a class here would be DI ceremony
 * around a single function — and an `@Injectable` that is only ever reached
 * through `useClass` also trips the `injectable-should-be-provided` lint rule,
 * because the class itself never appears in a `providers` array.
 */
export const puppeteerLauncherProvider: Provider<BrowserLauncher> = {
  provide: BROWSER_LAUNCHER,
  useValue: {
    async launch(options: {
      executablePath: string;
      args: readonly string[];
      headless: boolean;
    }): Promise<LaunchedBrowser> {
      // `puppeteer-core`'s real `Browser`/`Page` types structurally satisfy the
      // interfaces above (a superset of them); the cast is the one narrowing
      // point between the real library and this module's minimal contract.
      const browser = await puppeteer.launch({
        executablePath: options.executablePath,
        args: [...options.args],
        headless: options.headless,
      });
      return browser as unknown as LaunchedBrowser;
    },
  } satisfies BrowserLauncher,
};
