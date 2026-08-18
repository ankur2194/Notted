// Part 63 — the shared Chromium process lifecycle.
//
// Despite the file name, this is NOT a pool of browsers: export concurrency
// is pinned at 2 elsewhere, and a second whole Chromium process would double
// memory for zero benefit. It is one lazily launched, shared browser, with
// one incognito `BrowserContext` per job — contexts are what actually
// isolate one tenant's export from the next.

import { existsSync } from "node:fs";

import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { EXPORT_CONFIG, type ExportConfig } from "../config/export.config";

import {
  BROWSER_LAUNCHER,
  type BrowserLauncher,
  type LaunchedBrowser,
  type PageHandle,
} from "./puppeteer-launcher.provider";

/** Thrown when a render is attempted while Chromium is unavailable. Mirrors `ObjectStorageDisabledError`. */
export class ChromiumUnavailableError extends Error {
  constructor() {
    super("Chromium is unavailable for export rendering");
    this.name = "ChromiumUnavailableError";
  }
}

/**
 * How long the browser stays warm with zero active jobs before it is torn
 * down. Not an env knob: this is an internal resource-lifecycle detail, not a
 * deployment concern.
 */
const IDLE_CLOSE_MS = 60_000;

const LAUNCH_ARGS: readonly string[] = [
  // REQUIRED because the API container runs `USER node` (non-root), which
  // cannot create the namespaces Chromium's own sandbox needs. Compensating
  // controls, all enforced by `PdfExportService` on every page it opens:
  // JavaScript stays disabled, all network access is blackholed (the
  // `--host-resolver-rules` flag below, plus offline mode and request
  // interception), no plugins run, the HTML fed in is the fixed, escaped
  // output of `buildStandaloneHtml`/`renderDocumentHtml`, every job gets a
  // fresh incognito context, and the container mounts no credentials. The
  // real seccomp/user-namespace sandbox is Part 79's job.
  "--no-sandbox",
  "--disable-setuid-sandbox",
  // SSRF defence in depth: blackhole every hostname at the resolver so a
  // request that slips past `page.setRequestInterception` still cannot
  // reach an internal service, cloud metadata endpoint, or the public
  // internet. `PdfExportService` aborts non-`data:` requests outright; this
  // is the second layer, not the only one.
  "--host-resolver-rules=MAP * ~NOTFOUND",
  // /dev/shm is tiny (often 64MB) in a container; Chromium crashes under
  // load without this.
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-background-networking",
  "--no-first-run",
  "--disable-sync",
  "--mute-audio",
];

@Injectable()
export class BrowserPoolService implements OnModuleDestroy {
  private browser: LaunchedBrowser | null = null;
  private launchPromise: Promise<LaunchedBrowser> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private activeJobs = 0;

  constructor(
    @Inject(BROWSER_LAUNCHER) private readonly launcher: BrowserLauncher,
    @Inject(EXPORT_CONFIG) private readonly config: ExportConfig,
    private readonly logger: StructuredLogger,
  ) {}

  isEnabled(): boolean {
    return this.config.chromiumPath !== null && existsSync(this.config.chromiumPath);
  }

  /** Opens one incognito browser context, runs `use`, and always tears the context down. */
  async withPage<T>(use: (page: PageHandle) => Promise<T>): Promise<T> {
    if (!this.isEnabled()) {
      throw new ChromiumUnavailableError();
    }

    this.beginJob();
    try {
      const browser = await this.getBrowser();
      const context = await browser.createBrowserContext();
      try {
        const page = await context.newPage();
        return await use(page);
      } finally {
        await context.close();
      }
    } finally {
      this.endJob();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    await this.closeBrowser();
  }

  /** Memoizes the in-flight launch so concurrent callers share one browser instead of racing to start their own. */
  private async getBrowser(): Promise<LaunchedBrowser> {
    if (this.browser !== null) {
      return this.browser;
    }
    if (this.launchPromise === null) {
      this.launchPromise = this.launchBrowser().catch((error: unknown) => {
        // A failed launch must not wedge every later export: clear the
        // memoized promise so the next call retries from scratch.
        this.launchPromise = null;
        throw error;
      });
    }
    return this.launchPromise;
  }

  private async launchBrowser(): Promise<LaunchedBrowser> {
    const executablePath = this.config.chromiumPath;
    // `withPage` already ran `isEnabled()`, so this is unreachable — but a
    // narrowing check is cheaper than a cast and cannot go stale if a second
    // caller ever appears.
    if (executablePath === null) {
      throw new ChromiumUnavailableError();
    }
    const browser = await this.launcher.launch({
      executablePath,
      args: LAUNCH_ARGS,
      headless: true,
    });
    browser.on("disconnected", () => {
      // A crashed/killed browser must not keep serving stale jobs: drop the
      // cached handle so the next `withPage` launches a fresh process.
      if (this.browser === browser) {
        this.browser = null;
      }
      this.logger.warning(
        { component: "export-browser-pool", outcome: "disconnected" },
        "Chromium disconnected; the next export will launch a fresh browser",
      );
    });
    this.browser = browser;
    this.launchPromise = null;
    return browser;
  }

  private beginJob(): void {
    this.activeJobs += 1;
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private endJob(): void {
    this.activeJobs -= 1;
    if (this.activeJobs <= 0) {
      this.activeJobs = 0;
      this.scheduleIdleClose();
    }
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
    }
    const timer = setTimeout(() => {
      this.idleTimer = null;
      void this.closeBrowser();
    }, IDLE_CLOSE_MS);
    timer.unref();
    this.idleTimer = timer;
  }

  private async closeBrowser(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    if (browser === null) {
      return;
    }
    try {
      await browser.close();
    } catch (error: unknown) {
      // Class name only: a Chromium error message can quote the page it was
      // rendering, and a log line is persistence just like a mailbox is.
      this.logger.warning(
        {
          component: "export-browser-pool",
          outcome: "close_failed",
          errorClass: error instanceof Error ? error.name : "unknown",
        },
        "Chromium browser close failed",
      );
    }
  }
}
