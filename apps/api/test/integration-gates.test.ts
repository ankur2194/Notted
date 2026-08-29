import { describe, expect, it } from "vitest";

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
 * ponytail: this proves the variable is SET, not that the service ANSWERS. The
 * ~32 copied `isDatabaseReachable`/`reachable` probes give a live-but-slow
 * database a 2 000 ms budget and degrade to a green skip when it is exceeded —
 * which a memory-capped host makes plausible. Upgrade path: one shared probe
 * helper beside `minio-test-helpers.ts` that THROWS rather than skips when the
 * variable is set but the service does not answer.
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
