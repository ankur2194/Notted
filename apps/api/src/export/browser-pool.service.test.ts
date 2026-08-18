import { describe, expect, it, vi } from "vitest";

import { BrowserPoolService, ChromiumUnavailableError } from "./browser-pool.service";

import type {
  BrowserContextHandle,
  BrowserLauncher,
  LaunchedBrowser,
  PageHandle,
} from "./puppeteer-launcher.provider";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { ExportConfig } from "../config/export.config";

// Fakes are intentionally NOT declared as extending the real interfaces:
// vitest's `Mock` return type does not satisfy TypeScript's interface-extends
// compatibility check even where it structurally satisfies the interface.
// Each fake is cast to its real counterpart only at the point it crosses into
// production code, matching `ObjectStorageService`'s test convention
// (`service({ putObject } as Partial<Client>)`).

function fakeContext() {
  return {
    newPage: vi.fn(async () => ({}) as PageHandle),
    close: vi.fn(async () => undefined),
  };
}
type FakeContext = ReturnType<typeof fakeContext>;

function fakeBrowser(contexts: FakeContext[] = []) {
  const disconnectedHandlers: Array<() => void> = [];
  return {
    createBrowserContext: vi.fn(async (): Promise<BrowserContextHandle> => {
      const context = fakeContext();
      contexts.push(context);
      return context as unknown as BrowserContextHandle;
    }),
    close: vi.fn(async () => undefined),
    on: vi.fn((event: "disconnected", handler: () => void) => {
      if (event === "disconnected") disconnectedHandlers.push(handler);
    }),
    connected: true,
    disconnect: (): void => {
      for (const handler of disconnectedHandlers) handler();
    },
  };
}
type FakeBrowser = ReturnType<typeof fakeBrowser>;

function asLaunched(browser: FakeBrowser): LaunchedBrowser {
  return browser as unknown as LaunchedBrowser;
}

function logger(): StructuredLogger {
  // `warning`, NOT `warn`. `StructuredLogger` carries both: `warn(message, ...)`
  // is the NestJS `LoggerService` member, `warning(metadata, message)` is the
  // structured one, and this pool calls `warning`. The `as unknown as` cast
  // means a mock missing it fails at runtime rather than at compile time.
  return { warning: vi.fn(), info: vi.fn(), failure: vi.fn() } as unknown as StructuredLogger;
}

function config(overrides: Partial<ExportConfig> = {}): ExportConfig {
  return {
    // Any real file works for the existsSync check the enabled path exercises.
    chromiumPath: __filename,
    renderTimeoutMs: 30_000,
    maxArtifactBytes: 26_214_400,
    ...overrides,
  } as ExportConfig;
}

function service(
  launch: BrowserLauncher["launch"],
  overrides: Partial<ExportConfig> = {},
): BrowserPoolService {
  return new BrowserPoolService({ launch }, config(overrides), logger());
}

describe("BrowserPoolService", () => {
  it("launches nothing until the first withPage call", () => {
    const launch = vi.fn(async () => asLaunched(fakeBrowser()));
    service(launch);
    expect(launch).not.toHaveBeenCalled();
  });

  // The SSRF containment layers that live in the LAUNCH ARGS have no other
  // guard. `pdf-export.service.test.ts` covers the two page-level layers
  // (JavaScript disabled, non-`data:` requests aborted), and the composite
  // real-browser proof is `skipIf`-gated on Chromium being installed, so on a
  // developer machine without it these flags could be deleted and every suite
  // would stay green. This is the assertion that fails instead.
  it("launches with the resolver blackhole and the sandbox flags the container needs", async () => {
    // Typed off the real launcher so `mock.calls` carries the options object;
    // an untyped `vi.fn` erases it and the assertions below cannot see `args`.
    const launch = vi.fn<BrowserLauncher["launch"]>(async () => asLaunched(fakeBrowser()));
    const pool = service(launch);
    await pool.withPage(async () => "a");

    const args = launch.mock.calls[0]?.[0]?.args ?? [];
    // Second SSRF layer: every hostname blackholed at the resolver, so a
    // request that slipped past interception still reaches nothing.
    expect(args).toContain("--host-resolver-rules=MAP * ~NOTFOUND");
    // Required because the container runs as `USER node`; recorded with its
    // compensating controls in `browser-pool.service.ts`.
    expect(args).toContain("--no-sandbox");
    expect(args).toContain("--disable-setuid-sandbox");
  });

  it("launches exactly once across two sequential withPage calls", async () => {
    const launch = vi.fn(async () => asLaunched(fakeBrowser()));
    const pool = service(launch);
    await pool.withPage(async () => "a");
    await pool.withPage(async () => "b");
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("memoizes an in-flight launch across two concurrent withPage calls", async () => {
    // Definite-assignment assertion, not a nullable union: the executor runs
    // synchronously, so `resolveLaunch` is always assigned before use, and
    // this sidesteps a TypeScript control-flow quirk where a `let` read
    // after a closure-only reassignment narrows to the initializer instead
    // of the declared type.
    let resolveLaunch!: (browser: LaunchedBrowser) => void;
    const pending = new Promise<LaunchedBrowser>((resolve) => {
      resolveLaunch = resolve;
    });
    const launch = vi.fn(() => pending);
    const pool = service(launch);

    const call1 = pool.withPage(async () => "a");
    const call2 = pool.withPage(async () => "b");

    expect(launch).toHaveBeenCalledTimes(1);
    resolveLaunch(asLaunched(fakeBrowser()));

    await expect(call1).resolves.toBe("a");
    await expect(call2).resolves.toBe("b");
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("opens exactly one context per job and closes it, even when the callback throws", async () => {
    const contexts: FakeContext[] = [];
    const browser = fakeBrowser(contexts);
    const pool = service(vi.fn(async () => asLaunched(browser)));

    await pool.withPage(async () => "ok");
    expect(browser.createBrowserContext).toHaveBeenCalledTimes(1);
    expect(contexts[0]?.close).toHaveBeenCalledTimes(1);

    await expect(
      pool.withPage(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(browser.createBrowserContext).toHaveBeenCalledTimes(2);
    expect(contexts[1]?.close).toHaveBeenCalledTimes(1);
  });

  it("launches a fresh browser the next time withPage is called after a disconnect", async () => {
    const browsers: FakeBrowser[] = [];
    const launch = vi.fn(async () => {
      const browser = fakeBrowser();
      browsers.push(browser);
      return asLaunched(browser);
    });
    const pool = service(launch);

    await pool.withPage(async () => "a");
    expect(launch).toHaveBeenCalledTimes(1);

    browsers[0]?.disconnect();

    await pool.withPage(async () => "b");
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("closes the browser on module destroy and is a no-op when nothing was ever launched", async () => {
    const untouched = service(vi.fn(async () => asLaunched(fakeBrowser())));
    await expect(untouched.onModuleDestroy()).resolves.toBeUndefined();

    const browser = fakeBrowser();
    const pool = service(vi.fn(async () => asLaunched(browser)));
    await pool.withPage(async () => "a");
    await pool.onModuleDestroy();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("is disabled and rejects withPage with ChromiumUnavailableError when no chromium path is configured", async () => {
    const pool = service(
      vi.fn(async () => asLaunched(fakeBrowser())),
      { chromiumPath: null },
    );
    expect(pool.isEnabled()).toBe(false);
    await expect(pool.withPage(async () => "x")).rejects.toBeInstanceOf(ChromiumUnavailableError);
  });

  it("is disabled when the configured chromium binary does not exist on disk", () => {
    const pool = service(
      vi.fn(async () => asLaunched(fakeBrowser())),
      { chromiumPath: "/nonexistent/path/to/chromium-binary" },
    );
    expect(pool.isEnabled()).toBe(false);
  });
});
