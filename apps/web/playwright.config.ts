import { defineConfig, devices } from "@playwright/test";

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";

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
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
    {
      command: "pnpm exec rimraf .next && pnpm dev",
      url: `${appUrl}/settings/security`,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
