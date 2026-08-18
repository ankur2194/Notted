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
