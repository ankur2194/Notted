import { defineConfig, devices } from "@playwright/test";

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";
const disposableTestRun = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";

/**
 * A disposable run normally owns its servers, so it refuses to reuse one that is
 * already listening. That rule makes the real-stack specs unrunnable against the
 * Compose stack, which is the only way to get a browser here: the containers are
 * already serving `localhost:3000`/`:3001`, and `reuseExistingServer: false`
 * aborts rather than attaching. This opt-in says "the stack outside is the
 * disposable one" and leaves CI, where the variable is unset, unchanged.
 */
const reuseExistingServer =
  process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "true" ||
  (!process.env.CI && !disposableTestRun);

if (
  disposableTestRun &&
  (process.env.DATABASE_URL === undefined || process.env.PLAYWRIGHT_MAILPIT_URL === undefined)
) {
  throw new Error(
    "Disposable Playwright runs require explicit DATABASE_URL and PLAYWRIGHT_MAILPIT_URL values",
  );
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  outputDir: "test-results/playwright",
  use: {
    baseURL: appUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm --dir ../api start",
      url: `${apiUrl}/health/live`,
      reuseExistingServer,
      timeout: 300_000,
    },
    {
      command: "pnpm exec rimraf .next && pnpm dev",
      url: `${appUrl}/settings/security`,
      reuseExistingServer,
      timeout: 300_000,
    },
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
