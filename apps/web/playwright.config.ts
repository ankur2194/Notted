import { defineConfig, devices } from "@playwright/test";

import { playwrightDiagnostics } from "./src/lib/testing/playwright-runtime";

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";
const disposableTestRun = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";
const externalServers = process.env.PLAYWRIGHT_EXTERNAL_SERVERS === "true";
const diagnostics = playwrightDiagnostics(process.env);

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

/**
 * Refuse to run the browser suite against the *development* stack.
 *
 * Specs register users and create workspaces, notes and projects. Pointed at
 * `notted_dev` they accumulate that state permanently, and specs that assume a
 * near-empty tenant then fail on a previous run's rows — nondeterministically,
 * because which one breaks depends on how much junk has piled up. That is the
 * exact failure class `pnpm e2e:up` / `pnpm e2e:test` exists to remove, and
 * `docs/standards/testing.md` states the rule; this is the guard behind it.
 *
 * `PLAYWRIGHT_APP_URL` is the discriminator: the disposable runner always sets
 * it (see `playwrightEnvironment` in `scripts/dev-tooling.mjs`), and CI supplies
 * its own stack. Bare `playwright test` on a developer machine sets neither and
 * would silently target `localhost:3000`.
 */
if (!process.env.CI && process.env.PLAYWRIGHT_APP_URL === undefined) {
  throw new Error(
    "Refusing to run the browser suite against the development stack, which would write test " +
      "users and notes into notted_dev. Use `pnpm e2e:up` then `pnpm e2e:test`, which runs " +
      "against a disposable database. To target another stack deliberately, set " +
      "PLAYWRIGHT_APP_URL (and PLAYWRIGHT_API_URL) explicitly.",
  );
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: diagnostics.htmlReport
    ? [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : [["list"]],
  outputDir: "test-results/playwright",
  use: {
    baseURL: appUrl,
    trace: diagnostics.trace,
    screenshot: diagnostics.screenshot,
    video: diagnostics.video,
  },
  webServer: externalServers
    ? undefined
    : [
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
