import { defineConfig } from "vitest/config";

const databaseUrl = process.env.DATABASE_URL;
const hasDatabase = typeof databaseUrl === "string" && databaseUrl.trim() !== "";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    hookTimeout: 180_000,
    // Explicit, because Vitest's 5 s default sat below what several suites
    // legitimately need under v8 coverage instrumentation in a memory-capped
    // container — a per-test kill that reads as a real failure but is only the
    // harness being slower than the test's own budget. 60 s is roughly 2x the
    // slowest legitimate test measured here (the multi-instance realtime
    // distributed-cap case, 26.5 s under coverage), which keeps a genuine hang
    // bounded rather than open-ended.
    testTimeout: 60_000,
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
        // Part 75: per-path floors for the four directories where a missed
        // branch is a SECURITY bug rather than a coverage statistic — the
        // policy engine, the authentication surface, the tenant scope, and the
        // idempotency guard. The global 70 is deliberately NOT raised: pushing
        // one number up is the superficial move the plan part warns against,
        // and it would be satisfied by covering whatever is cheapest.
        //
        // MEASURED, then rounded DOWN to the nearest 5 — a ratchet floor is set
        // from what the suite actually achieves, never from what it ought to.
        // Source: `coverage/coverage-summary.json` from a full `pnpm test:ci`
        // inside the API container (which needs the dev stack; see
        // docs/standards/testing.md). Each floor is the LOWEST of the four
        // metrics for that path, so no metric can regress unnoticed.
        //
        // `src/tenant/**` and `src/common/idempotency/**` both measure a clean
        // 100 across all four metrics. They are pinned at 95, NOT 100: a literal
        // 100 is a hair-trigger that turns the next added line — a log call, an
        // early return — into a red build before anyone has written a test for
        // it, which trains people to lower the threshold. 95 keeps the signal
        // and leaves one line of slack.
        //
        // `src/auth/**` is the lowest of the four, at 75 (measured
        // 90.34/79.05/96.94/91.54 — branches are the binding metric). That is a
        // structural fact, not neglect: its uncovered branches are the live
        // Better Auth flows, which execute only when `AUTH_E2E` and Mailpit are
        // configured. Before those variables reached the API container it
        // measured 49.21 branches and could not have met any honest floor at
        // all. Raise it when those suites grow, not by adding shallow unit tests
        // elsewhere in the directory.
        //
        // A path that measures BELOW its floor is a finding to fix, not a
        // number to lower.
        "src/authorization/**": { branches: 85, functions: 85, lines: 85, statements: 85 },
        "src/auth/**": { branches: 75, functions: 75, lines: 75, statements: 75 },
        // `src/realtime/**` is the newest floor, and it exists because ~650
        // lines covering presence forgery, cross-instance room concealment,
        // distributed connection caps and session revocation live behind
        // `REALTIME_INTEGRATION` — which nothing in the repository set until
        // `compose.yaml` did. The suite could be skipped with the whole run
        // still green, and no gate said otherwise.
        //
        // MEASURED WITH THE FLAG ON, which is the only measurement that means
        // anything here: `src/realtime/` already has six unit test files
        // including a 23 KB gateway test, so a floor read from a run WITHOUT the
        // integration suite would be satisfiable by the unit layer alone and
        // would prove nothing at all.
        //
        //   REALTIME_INTEGRATION=true  ->  89.70 / 87.52 / 91.95 / 78.78
        //   flag absent                ->  79.97 / 77.30 / 75.17 / 67.32
        //
        // Lowest with the flag is branches at 78.78; rounded down to the nearest
        // 5 that is 75. Skipping the suite lands branches at 67.32 — below the
        // floor, so the run goes red instead of green, which is the entire
        // reason this entry exists. Both directions were verified before it was
        // written down.
        "src/realtime/**": { branches: 75, functions: 75, lines: 75, statements: 75 },
        "src/tenant/**": { branches: 95, functions: 95, lines: 95, statements: 95 },
        "src/common/idempotency/**": { branches: 95, functions: 95, lines: 95, statements: 95 },
      },
    },
  },
});
