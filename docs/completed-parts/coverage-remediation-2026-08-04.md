# Coverage remediation — making `pnpm test:ci` pass

## Status

- **State:** Complete
- **Completed on:** 2026-08-04
- **Implemented by:** Follow-up session to the Parts 34–36 delivery
- **Plan reference:** Not a numbered `Plan.md` part. Remediation of the follow-up item recorded in Part 34.
- **Related records:** Parts 33, 34, 35, and 36

## Objective

`pnpm test:ci` failed. Make it pass with every workspace genuinely at
or above its 70% coverage thresholds, without lowering a threshold or excluding a source
file from measurement.

## The actual starting state

The Part 34 record described this as one problem: `apps/web` branch coverage at 63.31%. That
was wrong, because only `apps/web` had been measured. Running the real gate for every
workspace showed three of four failing:

| Package | statements | branches | functions | lines | Result |
|---|---|---|---|---|---|
| `@notted/shared-types` | 41.17 | 100 | **0** | 41.17 | **Fail** |
| `@notted/shared-validators` | 84.19 | 78.37 | 95.76 | 87.28 | Pass |
| `@notted/api` | **53.64** | **45.33** | **60.79** | **55.30** | **Fail** |
| `@notted/web` | 70.05 | **63.31** | 73.28 | 72.52 | **Fail** |

Each package failed for a different reason:

- **shared-types** — the 10 `NOTE_API_PATHS` builder arrows in `src/note.ts` were never
  called by that package's own tests, which put the whole package at 0% functions.
- **api** — 16 test files gate themselves on `DATABASE_URL` via `describe.skipIf`. Without a
  database ~54 tests skipped and `src/notes/notes.service.ts` (493 statements) sat at 3.04%.
- **web** — genuinely untested `src/lib` modules, several at 0%.

## Implemented Work

### Make the API's existing integration tests actually run

This was the decisive change. The suites already existed and already ran their own
migrations and seed; they only needed an empty database.

- Declared `"env": ["DATABASE_URL"]` on the `test` and `test:ci` tasks in `turbo.json`.
  **Without this the passthrough does nothing**: Turbo filters the environment strictly,
  so the variable never reached vitest, every gated suite skipped, and coverage collapsed
  back to 55.78% with only threshold numbers to explain why. This was caught by running the
  real command rather than the per-package one.

### Fix two pre-existing flaws the newly-running tests exposed

- **Parallel suites raced on shared seed rows.** Six files call `seedDatabase()` against the
  one configured database and upsert identical `SEED_IDS`. Run in parallel they deadlocked,
  surfacing as an unrelated `Failed query: insert into "notes"` inside whichever suite lost.
  `apps/api/vitest.config.ts` now sets `fileParallelism: !hasDatabase` — serial when a
  database is configured, unchanged otherwise (every gated suite skips without one, so
  parallelism there costs nothing).
- **The notes concurrency suite leaked committed rows.** It commits rather than rolling back,
  because its barrier-synchronized races need genuinely independent transactions. Each run
  added three permanent sibling notes to the same workspace root, so reruns contended harder
  until `expect(reorders.every(fulfilled)).toBe(true)` legitimately failed — 26 leaked notes
  and 23 leaked folders had accumulated. Every row it commits is now tagged
  `CONCURRENCY_FIXTURE` and cleared at the start of the next run. Verified by three
  consecutive passes against a reused database.

### Cover the gaps

New tests, all asserting real behaviour rather than executing lines:

| Area | File | What it pins down |
|---|---|---|
| shared-types | `src/note.test.ts` | All 10 route builders, workspace-scoping of every path, verbatim interpolation (callers own validation), frozen object |
| api | `src/auth/auth-security.service.test.ts` | Fail-closed when Better Auth is unwired, own-session marking, user-agent summarization, refusal to revoke the current session remotely, silent no-op for another user's session id |
| api | `src/auth/auth.controller.test.ts` | Denial mapping to `RECENT_AUTHENTICATION_REQUIRED`/`UNAUTHENTICATED` without revoking, and 500 rather than anonymous access when the guard attaches no principal |
| api | `src/common/logging/structured-logger.service.test.ts` (extended) | Level routing, context extraction, and message coercion — an `Error` is reduced to its name because messages carry connection strings the redact paths cannot reach into |
| web | `src/lib/auth/{requests,security-requests,server-capabilities}.test.ts` | Rejected vs. network failures kept distinct, two-factor enrollment payload validation, 403 → "recent authentication required" |
| web | `src/lib/shell/{requests,server-shell}.test.ts` | Notification status mapping, and the stale-selection retry that drops a revoked `workspaceId` rather than stranding the user |
| web | `src/lib/workspaces/{server-workspaces,invitation-requests,requests}.test.ts` | 403/404 both concealed as `not-found`, conflict kept apart from network failure, slug coercion bounds |
| web | `src/lib/notes/{requests,server-notes,paths}.test.ts` | Version-gated destructive mutations, three-id share route validation, bounded page sizes, route selection by project membership |

## Bug found and fixed

`requestNotePage` rejected its own callers' input. `parseNoteSearchParams` returns the
schema's **output** — `isArchived` is a real `boolean`, `folderId` may be `null` — and the
page components pass that straight through. `requestNotePage` then re-validated it against
`noteListQuerySchema`, whose **input** is the raw query-string form (`"true"`/`"false"`,
absent rather than null). Any list query using one of those selectors was rejected as
`invalid` and never issued a request, so the archived-notes view failed closed and rendered
empty.

Fixed with `listQueryInput()` in `apps/web/src/lib/notes/requests.ts`, which restates an
already-parsed query in the input shape before re-validating, keeping the trust boundary
intact. Covered by a named regression test.

## Files and Components

| Path | Change |
|---|---|
| `turbo.json` | `env: ["DATABASE_URL"]` on `test` and `test:ci` |
| `apps/api/vitest.config.ts` | `fileParallelism: !hasDatabase` |
| `apps/api/test/notes.integration.test.ts` | `CONCURRENCY_FIXTURE` tagging and self-cleanup |
| `apps/web/src/lib/notes/requests.ts` | `listQueryInput()` — the archived-view fix |
| 11 new and 4 extended test files | See the table above |

## Database and Data Changes

No schema, migration, or seed change.
26 leaked notes and 23 leaked folders left by earlier runs of the concurrency suite were
deleted from the local development database; the suite no longer accumulates them.

## Security and Tenant-Isolation Notes

No authorization, tenant-scoping, or secret-handling behaviour changed. Several new tests
pin existing security properties that were previously unasserted: 403 and 404 collapsing to
one client-visible outcome so workspace existence is not disclosed, three-id validation on
share routes before any request, the stale workspace-selection retry, refusal to revoke
another user's session, and `Error` messages never being logged verbatim.

## Verification Evidence

Run serially against live infrastructure.

| Check | Result | Notes |
|---|---|---|
| `pnpm build:packages` | Pass | |
| `pnpm exec turbo run lint --concurrency=1 --force` | Pass | 4/4, `--max-warnings 0` |
| `pnpm exec eslint eslint.config.mjs --max-warnings 0` | Pass | |
| `pnpm format:check` | Pass | |
| `pnpm exec turbo run type-check --concurrency=1 --force` | Pass | 6/6 |
| **`pnpm test:ci`** | **Pass** | 6/6 turbo tasks + 4 script tests, exit 0 |
| `pnpm test:ci` with `pnpm infra:down` | **Fail (expected)** | `apps/api` 55.78% statements; the gated suites skip without a reachable database |
| api suite vs. an empty database | Pass | 635 passed, 3 skipped — verified with a throwaway database created without the dev init script |
| notes concurrency suite × 3 against a reused database | Pass | Confirms the leak fix |
| Production-env `turbo run build --concurrency=1 --force` | Pass | 4/4 |
| `pnpm db:check` | Pass | |
| `git diff --check` | Pass | |

Final coverage, all four workspaces above every threshold:

| Package | statements | branches | functions | lines |
|---|---|---|---|---|
| `@notted/api` | 79.26 | 72.44 | 83.68 | 81.12 |
| `@notted/web` | 79.03 | 72.36 | 83.30 | 81.01 |
| `@notted/shared-types` | 100 | 100 | 100 | 100 |
| `@notted/shared-validators` | 84.19 | 78.37 | 95.76 | 87.28 |

## Known Limitations and Follow-up Work

- **`pnpm test:ci` now requires a local database.** Without one it fails with only coverage
  numbers, which is a poor error message. Documented in `docs/README.md`; plain `pnpm test`
  still needs nothing.
- Branch coverage is the tightest metric in both apps (~2.4 points of headroom). The
  remaining large gaps are `apps/api/src/auth/better-auth.setup.ts` (88 uncovered branches,
  reachable only through the `AUTH_E2E` suites) and several 0%-covered web components.

## Handoff Notes

- Removing `env: ["DATABASE_URL"]` from
  `turbo.json` silently reverts the API to skipping its integration suites; the failure looks
  like a coverage regression, not a configuration one.
- Adding a new test file that calls `seedDatabase()` is safe — files run serially whenever a
  database is configured.
- A new suite that commits rather than rolls back must clean up after itself, or it will
  degrade every later run against the same database.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-04 | Coverage remediation session | Made `pnpm test:ci` pass across all four workspaces |
