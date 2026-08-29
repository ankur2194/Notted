# Testing Standard

- Unit-test rules, validators, policies, transformations, and failure paths.
- Integration-test persistence and infrastructure boundaries against realistic services.
- Contract-test tRPC and REST through shared application services.
- Use Playwright for critical journeys, browsers, and accessibility.
- Add a regression test for reproducible defects.
- Keep fixtures deterministic, tenant-aware, and independent of execution order.
- Run focused checks, then relevant lint, type-check, integration/E2E, migration, and build checks.
- Never run a browser suite against the development database; use the disposable stack below.
- Record exact commands and honest results in the completion record.

## Disposable end-to-end stack

The `e2e` Compose profile is a second application stack — `api-e2e` and `web-e2e` on ports 3010 and
3011 — backed by its own PostgreSQL database (`notted_e2e_test`), its own MinIO buckets, and Redis
logical database 1. It shares the PostgreSQL, Redis, MinIO, Meilisearch and Mailpit *servers*, plus
the installed dependencies and compiled contract packages, with the development stack.

**Shared services require logical isolation.** Meilisearch uses distinct deterministic, versioned
index prefixes (`notted_dev_` and `notted_e2e_`) on the shared server, so an e2e rebuild cannot
contaminate developer indexes. Mailpit is likewise shared, and `clearMailpit()` empties
the entire mailbox, so a concurrent e2e run can delete a message a developer was reading; that is a
nuisance rather than a correctness problem, and it is why no spec should assert on mail it did not
itself send.

```bash
pnpm infra:down                                  # stop the development stack FIRST; never run both at once
docker compose --profile e2e build api-e2e       # pre-build the Chromium image in the foreground
pnpm e2e:up      # start the profile; drops and recreates the database, migrates, seeds, flushes Redis db 1
pnpm e2e:test    # run the Playwright chromium project against it
pnpm e2e:test --grep "note"                      # arguments pass to Playwright verbatim (no `--`)
pnpm e2e:down    # remove the profile's containers
pnpm infra:up:ports                              # bring the development stack back afterwards
```

`pnpm e2e:up` starts every run from the same state. `pnpm e2e:test` runs Playwright in the official
container joined to `api-e2e`'s network namespace, because Chromium cannot launch on the host. Inside
that namespace `127.0.0.1` is the API container, so Mailpit and PostgreSQL must be addressed by
Compose DNS (`http://mailpit:8025`, `postgres:5432`) while the application keeps the same
`localhost:3010`/`localhost:3011` origins the browser, the CORS allow-list and Better Auth all agree
on. Override `NOTTED_E2E_WEB_PORT` / `NOTTED_E2E_API_PORT` when another project holds those ports.

### Running the browser and Chromium suites efficiently

The order below is the one that works on a memory-capped host. It is not a
preference; each step exists because skipping it cost a run.

**1. Reclaim Docker first, by name.** Other projects share this daemon.
`docker system prune -a`, `docker image prune -a` and an untargeted
`docker volume prune` will destroy their images and data. Remove Notted's own
leftovers explicitly instead — stale containers via `pnpm e2e:down`, then images
and volumes belonging to dead Compose project names (a renamed project leaves
`<old-name>_postgres-data` and friends behind). `docker system df` before and
after is the measurement. Note that `docker builder prune` is global and, run
immediately before an end-to-end session, forces a cold ~1.45 GB `api-e2e`
rebuild at exactly the wrong moment.

**2. Run the Chromium PDF suite WITHOUT the e2e stack.**
`apps/api/test/export-pdf.integration.test.ts` is gated only on the Chromium
binary existing and touches no database, and the development `api` container
already runs `notted-dev-workspace-chromium:local` with `EXPORT_CHROMIUM_PATH`
set. So it runs inside the container that is already up, in seconds, for about
300 MB:

```bash
docker compose -p notted-dev exec -T --workdir /workspace/apps/api api \
  pnpm exec vitest run test/export-pdf.integration.test.ts
```

Starting the `e2e` profile or the Playwright container for this suite wastes
several gigabytes and minutes for nothing. **`5 passed` is the pass condition —
a `skipped` result means the gate did not see the binary and must be reported as
unproven, never as a pass.**

**3. Only then the browser suite**, in the order the Local resource budget below
requires: `pnpm infra:down`, `docker compose --profile e2e build api-e2e` as its
own finished foreground step, `pnpm e2e:up`.

**4. Stage the Playwright run.** Focused spec first, whole suite second:

```bash
pnpm e2e:test export-formats.spec.ts print-export.spec.ts   # fails fast on new code
pnpm e2e:test                                               # then the full baseline
```

A full serial run is 7–13 minutes depending on host contention; discovering a
broken new spec at minute 9 is avoidable.

**5. `api-e2e` runs `nest start --watch`.** An `apps/api` source fix is picked up
without restarting the stack, so a red API-side spec can be fixed and re-run
immediately. `apps/web` is a `next dev` server, likewise.

**6. Isolate before calling a failure a defect.** This suite is load-sensitive
here: across four consecutive full runs three different tests each failed once
and then passed in isolation in seconds. Re-run the single spec
(`pnpm e2e:test <one>.spec.ts`) before diagnosing. A test that passes alone and
fails only under a full run is contention, and the honest fix is either a cause
you can name — a lost keystroke, a budget that must cover a server-side
projection — or nothing at all. Never a bare retry, a sleep, or a weakened
assertion.

**7. Do not pipe a long run through `tail` when capturing it.** The first
failure's message, locator and call log sit at the top of Playwright's output;
tailing keeps only the summary and forces the whole run again to learn what
broke. Capture in full and read selectively. `error-context.md` and the trace
under `apps/web/test-results/playwright/` survive the run and carry the page
snapshot.

**8. Finish by restoring the development stack:** `pnpm e2e:down`, then
`pnpm infra:up:ports`.

Rough budget on an 8.7 GiB VM: development stack ~3.8 GB (`web` alone is 2.4 GB
of Next dev server), the `e2e` stack about the same, the Playwright container a
further 1–1.5 GB. One application stack plus Playwright fits with roughly 3 GB
spare. Two application stacks plus a concurrent image build does not, and that
combination is what froze the host.

### Never wait on the save indicator in a browser test

`NoteEditorSurface` binds **one writer at a time**. Once a collaborative session
syncs — which a lone user does, since the socket connects for a single peer too —
the Part 39 autosave machine is deliberately left unbound and the server-side Yjs
projection owns `notes.content`. The save indicator therefore stays on
"No unsaved changes." forever, and `toHaveText(/Saved\./)` can never pass for a
**content** change. (A **settings** change, such as the page size, still goes
through autosave and does show "Saved.")

Wait on the persisted row instead: read the note back through
`GET /api/v1/workspaces/:workspaceId/notes/:noteId` and poll until the stored
document carries the state the next assertion is about. That is both honest and
stronger than the string it replaces — it waits for the exact thing being
asserted rather than for a proxy. `note-images.spec.ts` (`waitForStored` /
`waitForStoredImage`), `note-attachments.spec.ts` and `tags-templates.spec.ts`
show the pattern.

For the same reason, do not assert that a note **PATCH** was sent. A synced
session ships its edits over the socket and may issue no note PATCH at all, so
"every PATCH body is clean" is a transport check that no longer proves
persistence. Assert on the stored document.

### Local resource budget

On a memory-capped host — WSL2 in particular, which defaults to roughly half of host RAM with swap at
a quarter of that — an end-to-end run can exhaust the VM and take every terminal down with it, not
just Docker. The symptom is a machine that looks hung but is actually thrashing swap. Three rules keep
the run inside the budget.

**Never run both stacks at once.** `e2e` is a *profile* inside the same Compose project as
development, not a separate project, so `pnpm e2e:up` starts `api-e2e` and `web-e2e` **alongside** a
running development `api` and `web` rather than replacing them. That is two application stacks, two
Next.js servers and two NestJS servers against one shared infrastructure set. Run `pnpm infra:down`
before `pnpm e2e:up`, and `pnpm e2e:down` before returning to development. Only one stack is up at any
moment. The profile's targeted startup deliberately does not *build or start* the development
services, but it does not stop ones that are already running either.

**Pre-build the Chromium image as its own foreground step.** `api-e2e` extends `api`, which since
Part 63 builds the `workspace-chromium` target of `docker/Dockerfile.dev` and installs Debian
`chromium` — `notted-dev-workspace-chromium:local` is about 1.45 GB against about 493 MB for the lean
`notted-dev-workspace:local`. Run `docker compose --profile e2e build api-e2e` on its own and let it
finish before `pnpm e2e:up`, so the image build is never competing with Playwright for memory. It also
keeps a long, silent `apt-get` out of any automated runner's no-output stall watchdog, which
otherwise kills the run mid-build and leaves the tree in an unknown state.

**Playwright stays at one worker.** `apps/web/playwright.config.ts` pins `workers: 1` with
`fullyParallel: false`, and `playwrightTestArguments` injects `--project=chromium` unless the caller
names projects. Every additional worker is another browser process inside the runner container, and
every additional project multiplies the suite. This is a standing invariant, not a default to tune:
do not raise the worker count or widen the project list on a memory-capped host. `docker stats` is the
check before blaming the tests, and `PLAYWRIGHT_LIGHTWEIGHT_MODE=true` drops traces, screenshots,
videos and the HTML report when diagnosing under pressure.

**Why it exists.** `PLAYWRIGHT_DISPOSABLE_TEST_RUN=true` used to gate specs without creating
anything: the suite ran against `notted_dev` and every run left users, workspaces, projects and notes
behind, so specs that assume a near-empty tenant failed on the previous run's rows. The flag now
names a stack that really is disposable. The development database is never written by a browser
test, and that is now enforced rather than merely documented: `playwright.config.ts` refuses to start
when `PLAYWRIGHT_APP_URL` is unset, so a bare `playwright test` fails closed with an
instruction instead of silently targeting `localhost:3000`. Set `PLAYWRIGHT_APP_URL` explicitly to
aim at some other stack on purpose.

The targeted startup names only `api-e2e` and `web-e2e`; Compose starts their shared infrastructure,
contract, migration, reset, and bucket dependencies transitively, but does not build or start the
development `api`, `web`, `db-init`, or `minio-init` services. Playwright is told these disposable
servers are external, so retries attach to the same healthy processes instead of invoking its
development-server commands or rebuilding between attempts.

For a resource-constrained local diagnosis where failure traces, screenshots, videos, and the HTML
report are not needed, opt into the lightweight runner explicitly:

```bash
PLAYWRIGHT_LIGHTWEIGHT_MODE=true pnpm e2e:test version-history.spec.ts
```

List output and assertions remain unchanged.

Only the chromium project runs unless you pass your own `--project`. A `--grep` filter therefore
narrows the run without also widening it to firefox and webkit, which are not part of the maintained
baseline.

Two further sources of run-to-run drift are handled by the profile rather than by the specs: Redis
logical database 1 is flushed so sessions cannot outlive the rows they reference, and the API's
in-memory rate-limit buckets are raised, because a serial browser suite drives every request from the
single IP of the shared network namespace.

`db-reset-e2e` destroys a database unconditionally, so it validates `POSTGRES_E2E_DB` against a
pattern (`notted_e2e*_test`) that no development or production name can match, and `redis-reset-e2e`
hardcodes logical database 1. Never point either at development data, and never use
`pnpm infra:reset:dev` to prepare an end-to-end run.

<!-- BEGIN Part 75 — automated test pyramid. Append new sections below this block, not inside it. -->

## Infrastructure gates

Around thirty API suites are wrapped in `describe.skipIf(...)` on a piece of infrastructure —
`DATABASE_URL`, `MINIO_ENDPOINT`, `MEILISEARCH_HOST`, `REDIS_URL`, a Mailpit URL, and a handful of
opt-in switches. That gate is right on a laptop with no stack running. In CI it is a trap: Turbo 2
filters the environment strictly, so a variable that is not declared in `turbo.json` never reaches
vitest, every gated suite skips, and the run still prints green.

Two things keep that honest:

- `turbo.json` declares the full set on both `test` and `test:ci`, wildcards included
  (`MINIO_*`, `MEILISEARCH_*`, `MAILPIT_*`, `BETTER_AUTH_*`, `RATE_LIMIT_*`, `FEATURE_*`).
  **Adding a suite that reads a new variable means adding it there in the same change.**
- `apps/api/test/integration-gates.test.ts` asserts that whenever `DATABASE_URL` is set, the other
  stack variables are set too — turning "thirty suites skipped" into one red test. It fires on any
  run that configures a database, a developer laptop included. It used to additionally require
  `CI`, which this repository sets nowhere, so it had never executed once.

Note the name: the application reads `MEILISEARCH_HOST`, which `compose.yaml` does set.
`MEILISEARCH_URL` is a name nothing reads and nothing sets.

### Two suites that only run in a specific container

- `apps/api/test/search-reindex.integration.test.ts` requires
  `MEILISEARCH_INDEX_PREFIX=notted_e2e_`, which only the `api-e2e` service sets. It refuses to run
  against the development prefix on purpose: it deletes and rebuilds index documents. That gate is
  correct and must not be weakened — what was missing was a way to *satisfy* it, since no script ran
  API vitest inside a container at all. With the `e2e` profile up (`pnpm e2e:up`):

  ```bash
  pnpm test:api:e2e-container test/search-reindex.integration.test.ts
  ```

  The same wrapper serves the other `api-e2e`-only suite, `test/realtime.integration.test.ts`,
  which the profile now enables via `REALTIME_INTEGRATION`. Use `pnpm test:api:dev-container` for
  suites that want the ordinary development stack instead.
- `apps/api/test/export-pdf.integration.test.ts` needs a Chromium binary but no database, so it runs
  in the **development** `api` container, which already carries one, and needs no e2e stack:

  ```bash
  pnpm test:api:dev-container test/export-pdf.integration.test.ts
  ```

  `5 passed` is the pass condition. `skipped` is unproven, not passed.

## Shared Playwright fixtures

New browser specs import `apps/web/e2e/accounts.ts` for identities, registration, workspace
creation, and invitations, instead of copying those helpers again. It is a plain module, not a
`*.spec.ts`, so Playwright's `testMatch` does not collect it — the same arrangement as
`apps/web/e2e/mailpit.ts`.

Provisioning there is API-driven. The sign-up and sign-in *forms* are already covered by
`auth.spec.ts`; a spec about something else should not spend browser time re-proving them. The
session cookie lands in the browser context either way, so `page.goto` afterwards is authenticated
exactly as a form login would be.

**Existing specs were deliberately not migrated.** Their copies diverged for real reasons — 503
route injection, focus-order assertions, passkey and OAuth variants — and rewriting them would trade
working coverage for tidiness. Migrate one only when it is already being edited for another reason.

### Assert exact status codes in denial tests

`apps/web/e2e/role-denial.spec.ts` asserts that the **server** refuses when the UI is bypassed, which
is the assertion that matters: a hidden button is a convenience, an API is the boundary. Two rules
apply to any spec of that kind:

- Assert the **exact** status. "Not 2xx" lets a `429` from a rate limiter masquerade as an
  authorization decision.
- Preserve the **403-vs-404 split**. `docs/authorization.md` promises that cross-tenant and guessed
  identifiers are concealed as `404` while known same-tenant permission failures are `403`.
  Collapsing the two is a tenant-existence oracle that every layer below still calls "denied".

Because a wrong path also returns `404`, and `404` is a *passing* result for half of those
assertions, the spec first checks every path it uses against the OpenAPI document the running API
serves. Route drift then fails loudly instead of hollowing the spec out.

## Verifying that traces carry no deployment secret

A failed Playwright run keeps a trace, and a trace is a full record of the requests the browser made.
The claim worth verifying is **"no deployment secret"**, not "no credentials" — a trace legitimately
contains the fixture password and the session token it produced, because that is what the browser
sent. Those are per-run: the identity is created with a `randomUUID()` suffix inside a disposable
database that the next `pnpm e2e:up` drops.

What must never appear is a value that outlives the run:

```bash
unzip trace.zip -d ./trace-inspect
grep -rlF -e 'notted-development-auth-secret-change-me' -e 'notted_dev_password' \
  -e 'notted-dev-minio-secret' -e 'notted-dev-meili-master-key' \
  -e 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=' ./trace-inspect   # expect 0 hits
```

Zero hits is the pass condition. Any hit means a secret reached the browser and the leak, not the
trace, is the bug.

## Coverage thresholds are a ratchet

`apps/api/vitest.config.ts` keeps the global floor at 70/70/70/70 and adds per-path floors for
`src/authorization/**`, `src/auth/**`, `src/tenant/**`, and `src/common/idempotency/**` — the four
places where a missed branch is a security bug rather than a statistic. The global number is
deliberately not raised: pushing one aggregate up is satisfied by covering whatever is cheapest.

Raise a per-path floor to that path's **measured** value, rounded down to the nearest 5, read from
`coverage/coverage-summary.json` after a full `pnpm test:ci` with `DATABASE_URL` exported and the dev
stack up. Never write a threshold that was not measured, and never lower one to make a run pass.

<!-- END Part 75 -->

<!-- BEGIN Part 76 — accessibility and cross-browser validation. Append new sections below this block, not inside it. -->

## Accessibility scans

`apps/web/e2e/axe.ts` is the shared axe helper — a plain module, not a `*.spec.ts`, so Playwright's
`testMatch` does not collect it. It injects `axe.min.js` from the exact-pinned `axe-core` devDependency
of `apps/web`, runs against the tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`, and keeps
only `serious` and `critical` results. `best-practice` and every AAA tag are deliberately out of scope:
they are advice, not the conformance target, and a failing gate full of advice stops being read.

`apps/web/e2e/accessibility.spec.ts` scans `/login` unauthenticated, the dashboard shell, the note
editor, the tasks surface, search results, and one open dialog, then adds the three assertions axe
cannot make: a focus indicator under `forced-colors: active`, focus order with dialog focus restore,
and a polite-live-region invariant.

That last one is **not** "exactly one region per page", and the difference matters. The root layout's
sonner `Toaster` mounts a polite region on every page, and `PageContainer` documents in its own source
why the note editor deliberately runs a second (a layout announcement must not be able to overwrite
"Couldn't save"). The defect that actually harms someone is **nesting** — a region inside a region makes
every announcement arrive twice, and it only appears once components are composed, which is precisely
what a component test cannot see. So the spec asserts no polite region contains another, and pins
`toHaveCount(1)` only inside `main` on the tasks route, where `TaskListView` is the sole content and its
source states that guarantee outright.

**One rule governs known violations.** They are listed in `ACCEPTED_VIOLATIONS` with a rationale and
subtracted *after* the run, and every run prints what it subtracted. They are never suppressed with
axe's own `rules: { enabled: false }` — a disabled rule produces no evidence, so the day the underlying
markup changes, nothing says so.

Be honest about what a green scan means. Automated tooling detects roughly a third to a half of WCAG
issues. It is a floor that stops regressions, not a conformance claim, and it is not a substitute for
the manual keyboard and screen-reader pass.

## Cross-browser runs

`apps/web/e2e/cross-browser.spec.ts` covers only the surfaces where the engines actually diverge:
contenteditable, clipboard, print, reduced motion and reflow, and WebAuthn degradation. It runs on
whichever project is selected, so the default chromium run exercises it as a canary.

Run it explicitly under the other two engines:

```
pnpm e2e:test --project=firefox e2e/cross-browser.spec.ts
pnpm e2e:test --project=webkit  e2e/cross-browser.spec.ts
```

**Firefox and webkit are always invoked with an explicit spec path, never the whole suite.** A full
serial chromium run is already 7–13 minutes on this host, and the one-worker limit in
`apps/web/playwright.config.ts` is a standing invariant, so a second engine over the whole suite doubles
that for coverage that only matters where the engines diverge. Chromium remains the maintained default
and the only project the unqualified command runs.

Neither command needs setup. `apps/web/playwright.config.ts` already declares all three projects;
`scripts/dev-tooling.mjs` `playwrightTestArguments()` only *defaults* to chromium, injecting
`--project=chromium` when the caller passes no `--project` of their own; and the runner image,
`mcr.microsoft.com/playwright:v1.62.0-noble`, ships all three browser binaries.

### Edge

Edge has no project and is not run. It is Chromium-equivalent for everything this application uses, and
its `msedge` channel needs a host-installed binary the Playwright image does not carry. Its documented
divergences from upstream Chromium — its own PDF viewer, its `mica`/`acrylic` window surfaces, WebView2
embedding — touch nothing here. Chromium coverage stands in for Edge; that substitution is recorded
here rather than silently assumed, and the day one of those surfaces becomes load-bearing this note is
the thing to revisit.

### The axe helper cannot use `import.meta`

`apps/web/e2e/axe.ts` resolves the bundled `axe-core/axe.min.js` with **`require.resolve`**, not
`createRequire(import.meta.url)`. Playwright transpiles these specs to **CommonJS** — `apps/web` is not
`"type": "module"` — so `import.meta` is a *syntax* error at run time, and the failure mode is not one
broken scan: collection of every spec that imports the file dies with `SyntaxError: Cannot use
'import.meta' outside a module` followed by `Error: No tests found`. That is how the accessibility spec
managed to be written, reviewed, and never once executed.

### axe severity and scope, as configured

- `serious`, `critical`, **and ungraded (`impact: null`)** fail. axe leaves `impact` unset when it cannot
  grade a finding, and reading "ungraded" as "harmless" is the one interpretation that can only hide
  things. `minor` and `moderate` are not gating.
- The conformance tags are the WCAG A/AA set. `best-practice` stays excluded **except for two rules named
  individually** in a second `runOnly: { type: "rule" }` pass: `aria-treeitem-name` and
  `aria-dialog-name`, both `serious`, both describing a control a screen reader announces with no name.
  Add to that list only with the same justification; never widen the tag.
- `incomplete` results are **printed and never gating**. They are what axe could not decide — almost
  always `color-contrast` over a gradient, an image, or a partly transparent background. Discarding them
  (which the helper originally did) means contrast can be entirely undecidable on a surface while the run
  reads as a clean pass.
- Never silence a finding with `rules: { <id>: { enabled: false } }`. Add a rationale to
  `ACCEPTED_VIOLATIONS`, which still runs the rule and prints what it subtracted.

### Do not run the browser suite straight after the performance benchmark

`scripts/perf-bench.mjs seed` leaves roughly **7,000 `pending` rows in `job_outbox`**, and verification
email queues behind them. Every spec that provisions an account then times out at `waiting for
authentication mail` — 30 specs, none of them a real defect. Run the browser suite first, or `pnpm e2e:up`
between the two. Full rules in [`performance.md`](performance.md#resource-rules).

<!-- END Part 76 -->
