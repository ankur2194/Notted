import { defineConfig } from "vitest/config";

const databaseUrl = process.env.DATABASE_URL;
const hasDatabase = typeof databaseUrl === "string" && databaseUrl.trim() !== "";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    hookTimeout: 180_000,
    // Ten suites call `seedDatabase()` against the one configured database, and
    // they all upsert the same fixed `SEED_IDS` rows. Run in parallel they
    // contend on those rows and deadlock, which surfaces as an unrelated
    // "Failed query: insert into notes" inside whichever suite lost the race.
    // Serialize files whenever a live database is configured; without one every
    // database-gated suite skips, so parallelism there costs nothing.
    fileParallelism: !hasDatabase,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/main.ts"],
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      // `clean` defaults to removing this directory before a run. In the dev
      // container it is a writable volume mounted over a read-only source bind,
      // so the *contents* can be rewritten but the mount point itself cannot be
      // rmdir'd — which failed the run with EROFS before a single test executed.
      // Every configured reporter writes one file and overwrites it, so nothing
      // stale survives a run anyway.
      clean: false,
      // Without this a single failing suite suppresses the whole report, so a
      // run that fails one test looks identical to a run with no coverage at
      // all — and the numbers needed to diagnose the failure are exactly the
      // ones withheld.
      reportOnFailure: true,
      thresholds: {
        branches: 70,
        functions: 70,
        lines: 70,
        statements: 70,
      },
    },
  },
});
