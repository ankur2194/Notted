import { defineConfig } from "vitest/config";

const databaseUrl = process.env.DATABASE_URL;
const hasDatabase = typeof databaseUrl === "string" && databaseUrl.trim() !== "";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    hookTimeout: 180_000,
    // Six suites call `seedDatabase()` against the one configured database, and
    // they all upsert the same fixed `SEED_IDS` rows. Run in parallel they
    // contend on those rows and deadlock, which surfaces as an unrelated
    // "Failed query: insert into notes" inside whichever suite lost the race.
    // Serialize files whenever a live database is configured; without one every
    // database-gated suite skips, so parallelism there costs nothing.
    fileParallelism: !hasDatabase,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts"],
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
