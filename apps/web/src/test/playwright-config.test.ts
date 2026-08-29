// @vitest-environment node

/**
 * Three standing invariants of the browser suite that nothing else asserts.
 *
 * `forbidOnly` was `Boolean(process.env.CI)` and this repository sets `CI`
 * nowhere, so it was permanently false: one stray `test.only` cut a 7-13 minute
 * suite down to a single test and printed green. `workers: 1` and
 * `fullyParallel: false` are the WSL resource budget in
 * `docs/standards/testing.md` — each extra worker is another Chromium process on
 * a memory-capped host — and were likewise pinned by nothing.
 *
 * A `node` environment on purpose, and the config is imported dynamically:
 * loading it runs its own fail-closed guard, which throws unless
 * `PLAYWRIGHT_APP_URL` is set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlaywrightTestConfig } from "@playwright/test";

async function loadConfig(): Promise<PlaywrightTestConfig> {
  const loaded = await import("../../playwright.config");
  return loaded.default;
}

describe("playwright config", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("PLAYWRIGHT_APP_URL", "http://127.0.0.1:3000");
    vi.stubEnv("PLAYWRIGHT_API_URL", "http://127.0.0.1:3001");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses a stray test.only whether or not CI is set", async () => {
    vi.stubEnv("CI", "");
    expect((await loadConfig()).forbidOnly).toBe(true);

    vi.resetModules();
    vi.stubEnv("CI", "true");
    expect((await loadConfig()).forbidOnly).toBe(true);
  });

  it("runs one worker, serially", async () => {
    const config = await loadConfig();
    expect(config.workers).toBe(1);
    expect(config.fullyParallel).toBe(false);
  });

  it("keeps the local run free of bare retries", async () => {
    // `docs/standards/testing.md` forbids a retry as a diagnosis; the CI branch
    // is left alone because nothing in this repository sets `CI`.
    expect((await loadConfig()).retries).toBe(0);
  });
});
