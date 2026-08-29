import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Unconditional, because `CI` is set nowhere in this repository. Vitest's
    // default is `allowOnly: !isCI`, so a stray `.only` was PERMITTED here and
    // would silently reduce this file to one test while printing green — the
    // same fail-open-on-an-unset-`CI` shape as the Playwright `forbidOnly` and
    // integration-gate bugs this audit already closed. `vitest/no-focused-tests`
    // in `eslint.config.mjs` catches it before the run; this catches it during.
    allowOnly: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      thresholds: {
        branches: 70,
        functions: 70,
        lines: 70,
        statements: 70,
      },
    },
  },
});
