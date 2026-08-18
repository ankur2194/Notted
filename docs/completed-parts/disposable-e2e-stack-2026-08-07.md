# Disposable end-to-end stack, and the production defect it uncovered

- **Scope:** cross-cutting; not a numbered `Plan.md` part. Follows the Phase 7 (Parts 40–42) delivery.
- **State:** Complete
- **Completed on:** 2026-08-07
- **Related records:** [Part 41](part-41-image-ingestion-processing.md) (the licence sign-off closed the same day), [Part 29](part-29-project-crud-apis.md) (owns the endpoint fixed here), [Part 32](part-32-note-browsing-hierarchy-share-ui.md) (owns the specs corrected here), [All-in-Docker development](all-in-docker-development-2026-08-04.md) (the stack this extends).

## Why this work happened

The Playwright suite ran against the **shared development database**. `PLAYWRIGHT_DISPOSABLE_TEST_RUN=true` read like a guarantee of a throwaway environment, but it only gated which specs executed — it created nothing. Six specs consulted the flag; none of them got a clean database.

The consequence compounded silently. Every run left users, workspaces, projects and notes in `notted_dev`, and specs written against a near-empty tenant began failing on the *previous* run's rows. Roughly nine specs failed this way. Because which spec broke depended on how much residue had accumulated and on how slow the host was that day, the failures looked like flakes and were treated as such.

By the time this work started the development database held **147 users** against a seed that creates 6.

## What was built

An opt-in Compose profile, `e2e`, holding a second application stack whose state is disposable by construction.

| Resource        | Development           | End-to-end                       | Why                                                                               |
| --------------- | --------------------- | -------------------------------- | --------------------------------------------------------------------------------- |
| Web / API ports | 3000 / 3001           | 3010 / 3011                      | Both stacks usable at once.                                                        |
| PostgreSQL      | `notted_dev`          | `notted_e2e_test`                | The accumulating state. Dropped, recreated, migrated and seeded on every `e2e:up`. |
| MinIO buckets   | `notted-attachments`  | `notted-e2e-attachments`         | Attachments are tenant data; a shared bucket leaks e2e objects into the browser.   |
| Redis           | logical db 0          | logical db 1, flushed on reset   | See below — this one was not optional.                                             |
| Meilisearch     | shared server / dev prefix | shared server / e2e prefix  | Part 51 added logical index isolation before indexing documents.                    |
| Mailpit         | shared                | shared                           | `clearMailpit()` empties the whole mailbox. Nuisance, not correctness.             |

```bash
pnpm e2e:up      # drop, recreate, migrate, seed; flush Redis db 1; start the profile
pnpm e2e:test    # containerised Playwright (chromium) joined to api-e2e's network namespace
pnpm e2e:down    # remove only the profile's containers
```

`docs/standards/testing.md` carries the operating detail.

### Decisions worth keeping

- **Redis needed real isolation, not documentation.** Better Auth stores sessions under a hardcoded `notted:better-auth:` prefix (`apps/api/src/auth/better-auth-redis.storage.ts:7`) with no environment knob. Cookies are not port-scoped, so a development cookie *is* sent to `:3011`. A shared logical database would therefore let a session minted against one database resolve against the other. `ioredis` reads the database number from the URL path and `duplicate()` inherits it, so the BullMQ connections move with it. No application change was needed.
- **The web port mapping is identity, not `3010:3000`.** `web-e2e` shares `api-e2e`'s network namespace, so a container-internal port of 3000 would put the browser on an origin that is neither in `BETTER_AUTH_TRUSTED_ORIGINS` nor the CORS allow-list — and is the development stack's own origin.
- **Rate limits are raised for the e2e API only.** The serial browser suite drives every request from the single IP of the shared namespace and exhausted the 10/min sensitive bucket partway through, at a point that varied with load — precisely the nondeterminism this stack exists to remove. This took the clean-database failure count from 8 to 1. The behaviour is still covered at the level where it is meaningful, by `apps/api/test/app.e2e.test.ts` asserting a real 429. **Known gap:** nothing exercises the browser-visible 429 experience.
- **The destructive reset has two independent gates.** A character gate (`[a-z0-9_]` only) and a shape gate (`notted_e2e*_test`), both failing closed before any SQL is issued, and the identifier is quoted by psql itself via `-v name=` + `:"name"`. Note this must be fed on stdin with `-f -`: psql does **not** interpolate variables in `-c`. `notted_dev` cannot match either gate.
- **The rule is now enforced, not merely written down.** `apps/web/playwright.config.ts` refuses to start when `PLAYWRIGHT_APP_URL` is unset, so a bare `playwright test` fails closed with an instruction instead of silently targeting `localhost:3000`. The root `pnpm test:e2e` was rewired to the disposable path.

## The production defect the clean database uncovered

With the state noise gone, one failure proved to be a genuine **500 on `GET /api/v1/workspaces/:workspaceId/projects/:projectId`**, firing whenever the project had at least one note or task.

`drizzle-orm@0.45.2`'s node-postgres session deliberately installs pg type parsers that return `TIMESTAMPTZ` / `TIMESTAMP` / `DATE` / `INTERVAL` as **raw strings**, because it maps each value back to `Date` through that column's own decoder. A bare ``sql`max(...)` `` expression carries no decoder, so the value stayed a `string` regardless of the `sql<Date | null>` type argument written at the call site. `projects.service.ts` then filtered with `(value): value is Date => value !== null` — a predicate asserting a claim it never checked — and called `.getTime()`.

Two things had kept it hidden:

- `max()` over zero rows returns NULL, which the filter removed, so a project with no notes never reached the throwing path. `project-management.spec.ts` happens to use exactly such a project.
- `projects.service.test.ts:215` mocked `lastActivityAt` as a real `Date` — a value the driver never produces here. The mock disagreed with reality and the test certified the bug.

### What changed

- New `apps/api/src/database/sql-aggregates.ts` — a `maxTimestamp(column)` helper carrying the explanation, typed so `maxTimestamp(notes.title)` is a **compile** error.
- `projects.service.ts` — both aggregates now use it, and the dishonest predicate was **deleted rather than repaired**: `project.updatedAt` is NOT NULL so it seeds a `reduce<Date>`, and the array is typed from the loader signatures, so a string reappearing is a compile error instead of a runtime 500. Filtering it out silently would have been the same lie in a new costume.
- `attachments.service.ts:442` — an audit of all 8 `sql<...>` select expressions found `coalesce(sum(...))::bigint` typed `sql<number>` was the same class of lie (int8 arrives as a string), defused only by a `Number()` at the call site. Now decoded with `.mapWith(Number)`; the redundant coercion is gone. The five remaining sites are `count(*)::int` / `cast(... as integer)`, which are correct because int4 is not overridden.
- `apps/api/test/projects.integration.test.ts` — a regression test at a level that exercises **real driver marshalling**, since a unit test with a mocked `Date` provably cannot catch this. Verified to fail against the unfixed code with `TypeError: value.getTime is not a function`.

## Test defects corrected

Fixing the first failure unmasked others in stretches of `note-management.spec.ts` that had **never executed**. All were test defects, not product defects; every change tightens an assertion and none uses `.first()`.

- `getByRole("heading", { name: "Notes" })` matched both the sidebar note-tree label and the page title. Now `{ level: 1, name: "Notes" }`. The duplicate heading was assessed and is **not** an accessibility defect: WCAG 2.4.6 requires headings be descriptive, not unique, and the two are disambiguated by level and by landmark.
- The keyboard drag pressed `ArrowUp` where the grid places the cards side by side, so dnd-kit found no candidate and the item was dropped on itself. Now `ArrowLeft`, with the drag layer's own live-region announcement as the synchronisation point — `aria-pressed` flips one commit too early.
- `dragTo` cannot drive a `PointerSensor` with an 8px activation distance: its single move is entirely consumed satisfying the threshold.
- A 200% zoom reflow assertion was invalid twice over — it compared zoom-scaled `scrollWidth` against unscaled `clientWidth`, and CSS `zoom` does not re-evaluate media queries, so the page kept its `sm:` layout inside 320 CSS pixels. Replaced with a real 320px viewport, which is the condition WCAG 2.2 AA 1.4.10 actually states. **The product is conformant**; only the test was wrong, and it would have passed intermittently depending on whether `setViewportSize` had propagated.

## Verification

All commands run one at a time on 2026-08-07.

| Command                                                    | Result                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm lint`                                                 | pass, 4/4                                                              |
| `pnpm format:check`                                         | pass                                                                   |
| `pnpm type-check`                                           | pass, 6/6                                                              |
| `pnpm test`                                                 | pass, 6/6 (api 69 files + 9 skipped, web 86, validators 9, types 2)     |
| `node --test scripts/dev-tooling.test.mjs`                  | 17/17                                                                  |
| `pnpm db:check` / `pnpm db:generate`                        | pass / **zero new files**                                              |
| `docker compose exec api pnpm test`                         | 793 passed, 4 skipped (live PostgreSQL and MinIO suites)               |
| `pnpm e2e:test`                                             | **19 passed, 0 failed, 9 skipped**, reproduced across consecutive runs |
| `pnpm e2e:test --grep "conceals an existing workspace"`     | 1 passed, chromium only                                                |

Isolation was proven at runtime, not argued: `notted_dev` held 147 users / 12 workspaces / 83 notes / 4 projects **before and after** full suite runs. Redis db 0 stayed at 412 keys while db 1 cycled. `docker compose config` renders the development services byte-identically with the profile inactive. The reset guard was probed with eleven hostile names including an SQL-injection candidate, which is refused at the character gate with a non-zero exit and `notted_dev` intact.

The 9 skips are pre-existing opt-in fixtures: 8 `dashboard-shell` tests require `PLAYWRIGHT_SHELL_EMAIL`/`PLAYWRIGHT_SHELL_PASSWORD`, and 1 `advanced-auth` test requires Google OAuth fixture credentials.

## Known gaps and follow-up

- **Resolved by Part 51:** the shared Meilisearch server now uses distinct development and e2e index prefixes, as required by `docs/standards/testing.md` and `compose.yaml`.
- **`pnpm build` is not claimed green here.** It fails on this host at `apps/web`'s `env:validate --production` because no root `.env` exists and the `NEXT_PUBLIC_*` URLs are `http://`. Pre-existing and unrelated: `pnpm --filter @notted/api build` passes, and the web build completes when given production-shaped URLs.
- **Firefox and WebKit were not investigated.** The maintained baseline is chromium.
- **`workspace-management.spec.ts:248`** flaked once early on and did not reproduce in five serial attempts; a trace measured the step at 838 ms against a 5 s budget, which contradicts a "timeout too tight" reading. Deliberately left unchanged. If it recurs, assert the component's own submitting state between the click and the URL so the failure distinguishes "the click never reached hydrated React" from "the request failed".
- **`apps/web/src/components/layout/Sidebar.tsx:187-193`** puts `aria-label` on a bare `<span>` (role `generic`), which ARIA prohibits and assistive technology drops. Low severity — no content or keyboard access is lost — but it is a hard `aria-prohibited-attr` failure the day an automated scan covers the collapsed sidebar.
- **`pnpm e2e:up` restarts the development `api` and `web` containers**, because the profile shares their one-shot dependencies. Harmless, but it is not a no-op on a running stack.
- **`sql-aggregates.test.ts` reads drizzle's undeclared `SQL#decoder` field.** Acceptable under the ADR 0008 pin — the same behaviour has live PostgreSQL coverage, and a drizzle upgrade fails it loudly — but re-check it on any version bump.

## Files

**Created:** `apps/api/src/database/sql-aggregates.ts`, `apps/api/src/database/sql-aggregates.test.ts`, this record.

**Modified:** `compose.yaml`, `scripts/dev-tooling.mjs`, `scripts/dev-tooling.test.mjs`, `package.json`, `.env.example`, `docs/standards/testing.md`, `docs/standards/operations.md`, `apps/web/playwright.config.ts`, `apps/web/e2e/note-management.spec.ts`, `apps/api/src/projects/projects.service.ts`, `apps/api/src/attachments/attachments.service.ts`, `apps/api/test/projects.integration.test.ts`.
