import { describe, expect, it, vi } from "vitest";

/**
 * Part 75: make a silently-skipped integration run fail loudly.
 *
 * Roughly thirty suites are gated with `describe.skipIf(...)` on a piece of
 * infrastructure. That gate is right for a laptop with no stack running, but it
 * is a trap the moment a stack IS meant to be up: Turbo filters the environment
 * strictly, so one missing declaration in `turbo.json` makes every gated suite
 * skip while the run still prints green — a full test pyramid reduced to its
 * unit layer with no signal that it happened.
 *
 * This guard closes that hole with one assertion: *if* a database is configured
 * (so the stack is meant to be up), the other infrastructure the suites read
 * must be configured too.
 *
 * IT DELIBERATELY DOES NOT ASK WHETHER THIS IS CI. It used to, and this
 * repository has no CI — so the guard skipped itself on every machine that has
 * ever run it and never once executed. A developer who starts the stack and
 * runs the suite is in exactly the situation the guard was written for, so
 * `DATABASE_URL` alone is the trigger.
 *
 * Every variable checked here is read by real code on the test path:
 *   - `MINIO_ENDPOINT`   — `test/minio-test-helpers.ts` (`HAS_MINIO`).
 *   - `MEILISEARCH_HOST` — `src/config/meilisearch.config.ts`, which the search
 *     and reindex suites boot, and (since the Part 75 review)
 *     `src/search/hybrid-search.integration.test.ts` too. That file used to
 *     gate on `MEILISEARCH_URL`, a name set nowhere in the repository, which
 *     made the suite permanently dead rather than conditionally skipped; it now
 *     reads the same name as everything else.
 *   - `REDIS_URL`        — `src/config/redis.config.ts`, reached by every suite
 *     that boots the application (`test/app.e2e.test.ts` and the queue suites).
 *
 * Deliberately not asserted: `MAILPIT_URL`, `AUTH_E2E` and
 * `MEILISEARCH_INDEX_PREFIX`. Those select an *optional* suite rather than
 * describing the stack, and several only apply inside the `api-e2e` container.
 * `REALTIME_INTEGRATION` is likewise optional, but note that `compose.yaml` now
 * sets it for `api-e2e` — before that it was set nowhere at all, which made
 * `test/realtime.integration.test.ts` permanently dead in the same way
 * `MEILISEARCH_URL` had made the hybrid-search suite dead.
 *
 * This file used to carry a `ponytail:` note that it proved only that a variable
 * was SET, never that the service ANSWERED — because thirty-three suites had
 * each copied a 2 000 ms `isDatabaseReachable`/`reachable` probe that degraded a
 * live-but-slow database into a green skip. `requireDatabase()` in
 * `database-test-helpers.ts` is that upgrade path, landed: it throws instead of
 * skipping, and the last test below is what holds it to that.
 */

const DATABASE_CONFIGURED = (process.env.DATABASE_URL ?? "").trim() !== "";

describe.skipIf(!DATABASE_CONFIGURED)(
  "integration gates (DATABASE_URL is set, so the whole stack must be)",
  () => {
    it.each(["MINIO_ENDPOINT", "MEILISEARCH_HOST", "REDIS_URL"])(
      "%s reaches the test process",
      (name) => {
        const value = process.env[name];
        expect(
          typeof value === "string" && value.trim() !== "",
          `${name} is unset while DATABASE_URL is set. Either the service is not running or ` +
            `turbo.json does not pass it through, and the suites that need it are skipping ` +
            `silently. See docs/standards/testing.md → Infrastructure gates.`,
        ).toBe(true);
      },
    );
  },
);

/*
 * The other half of the same contract, and the one the guard above cannot state:
 * a database that is CONFIGURED but does not answer must fail, not skip.
 *
 * This runs unconditionally — it drives the probe against a closed port rather
 * than against the configured database, so it needs no stack and proves the
 * semantics on a laptop with nothing running.
 */
describe("requireDatabase", () => {
  it("throws rather than skipping when the configured database does not answer", async () => {
    // A port nothing listens on. The helper reads DATABASE_URL at import time,
    // so the stub has to be in place before the module is evaluated.
    vi.stubEnv("DATABASE_URL", "postgresql://probe:probe@127.0.0.1:59999/probe");
    vi.resetModules();
    try {
      const { requireDatabase } = await import("./database-test-helpers");
      await expect(requireDatabase()).rejects.toThrow(
        /DATABASE_URL is set but PostgreSQL did not answer/u,
      );
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
