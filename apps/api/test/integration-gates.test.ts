import { describe, expect, it } from "vitest";

/**
 * Part 75: make a silently-skipped integration run fail loudly.
 *
 * Roughly thirty suites are gated with `describe.skipIf(...)` on a piece of
 * infrastructure. That gate is right for a laptop with no stack running, but in
 * CI it is a trap: Turbo filters the environment strictly, so one missing
 * declaration in `turbo.json` makes every gated suite skip while the run still
 * prints green — a full test pyramid reduced to its unit layer with no signal
 * that it happened.
 *
 * This guard closes that hole with one assertion: *if* CI configured a database
 * (so the stack is meant to be up), the other infrastructure the suites read
 * must be configured too.
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
 * Deliberately not asserted: `MAILPIT_URL`, `AUTH_E2E`, `REALTIME_INTEGRATION`
 * and `MEILISEARCH_INDEX_PREFIX`. Those select an *optional* suite rather than
 * describing the stack, and several only apply inside the `api-e2e` container.
 */

const CI = process.env.CI;
const RUNNING_IN_CI = typeof CI === "string" && CI !== "" && CI !== "false";
const DATABASE_CONFIGURED = (process.env.DATABASE_URL ?? "").trim() !== "";

describe.skipIf(!RUNNING_IN_CI || !DATABASE_CONFIGURED)(
  "CI integration gates (DATABASE_URL is set, so the whole stack must be)",
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
