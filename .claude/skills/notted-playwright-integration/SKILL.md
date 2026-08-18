---
name: notted-playwright-integration
description: Author, diagnose, and verify Notted Playwright integration and end-to-end tests in apps/web/e2e and apps/web/playwright.config.ts. Use for browser journeys backed by the real Next.js app, NestJS API, PostgreSQL, Redis, Mailpit, tenant fixtures, OAuth capability modes, WebAuthn, accessibility, responsive layouts, or flaky Playwright failures.
---

# Build and Diagnose Notted Playwright Integration Tests

Read `AGENTS.md`, the selected `Plan.md` part, relevant `Notted.md` requirements, completed
prerequisite records, and `docs/standards/testing.md`. Also invoke the `notted-frontend-editor` skill;
invoke `notted-backend-data` when a journey starts or diagnoses API, database, Redis, queue, SMTP, or
auth infrastructure.

If delegating any bounded subtask, follow the Synchronous Delegation Protocol recursively: spawn with
the `Agent` tool using `run_in_background: false`, which is the one supported finite blocking wait, and
remain blocked until every started subagent is terminal.

## Test the Real Boundary

- Prefer real Next.js Server Components, the compiled NestJS API, disposable PostgreSQL data,
  Redis, and Mailpit for critical journeys. Mock only the external provider boundary.
- A browser `page.route()` cannot intercept a fetch performed by a Server Component. Configure the
  real API capability through process environment or a dedicated server fixture instead of writing
  a browser interception that never observes the request.
- Keep OAuth credentials synthetic and provider responses local. Never commit, print, or attach real
  provider secrets, session cookies, action links, recovery codes, or personal data.
- Create login identities through supported auth flows. Add tenant memberships and safe fixture rows
  only in a disposable database; do not add authenticating passwords to canonical seed data.
- Keep cross-tenant denial, guessed identifiers, session revocation, mutation origin checks, and
  persistent read state in the browser or live integration coverage where relevant.

## Stable Runner Setup

- Start infrastructure and apply migrations before browser tests. Build the API before a Playwright
  config starts `apps/api/dist/main.js`.
- Never run the development and `e2e` Compose stacks at the same time. `e2e` is a profile inside the
  same Compose project, so `pnpm e2e:up` starts `api-e2e`/`web-e2e` **alongside** a running
  development `api`/`web` instead of replacing them. Run `pnpm infra:down` first and `pnpm e2e:down`
  before returning to development. Two application stacks on a memory-capped host (WSL2 especially)
  can exhaust the VM and freeze every terminal, not just Docker.
- Pre-build the Chromium image as its own foreground step: `docker compose --profile e2e build
  api-e2e`, finished before `pnpm e2e:up`. `api-e2e` extends `api`, which builds the
  `workspace-chromium` target and installs Debian `chromium` (~1.45 GB against ~493 MB for the lean
  image). Keeping it separate stops the build competing with Playwright for memory and keeps a long
  silent `apt-get` out of any automated runner's no-output stall watchdog, which would otherwise kill
  the run mid-build.
- Keep Playwright at one worker. `apps/web/playwright.config.ts` pins `workers: 1` with
  `fullyParallel: false`, and only the `chromium` project runs unless the caller names projects. Each
  additional worker is another browser process inside the runner container. Treat this as a standing
  invariant; do not raise it to speed a run up.
- Do NOT start the `e2e` profile for the Chromium PDF suite.
  `apps/api/test/export-pdf.integration.test.ts` is gated only on the browser binary existing and
  touches no database, and the development `api` container already runs the `workspace-chromium`
  image with `EXPORT_CHROMIUM_PATH` set. Run it inside that container —
  `docker compose -p notted-dev exec -T --workdir /workspace/apps/api api pnpm exec vitest run
  test/export-pdf.integration.test.ts` — in seconds, for about 300 MB. `5 passed` is the pass
  condition; a `skipped` result means the gate never saw the binary and is unproven, not passed.
- Reclaim Docker by name before a session, never with `docker system prune -a` or `image prune -a`:
  the daemon is shared with other projects and those commands destroy their images and volumes.
  `docker builder prune` is likewise global, and running it immediately beforehand forces a cold
  ~1.45 GB `api-e2e` rebuild at the worst moment.
- Stage the run: focused spec first (`pnpm e2e:test <new>.spec.ts`), whole suite second. A full
  serial run is 7–13 minutes depending on host contention.
- `api-e2e` runs `nest start --watch` and `web-e2e` runs `next dev`, so a source fix is live without
  restarting the stack; re-run the failing spec directly.
- Use finite web-server and test timeouts. Keep stateful live suites serial unless their fixtures are
  proven isolated. Do not hide failures with unbounded retries or sleeps.
- Prewarm expensive or lazily compiled routes through `webServer.url` when first-request compilation
  can race a test. Clean stale `.next` development output before starting a fresh dev server.
- Await queue and worker readiness before producing jobs. When diagnosing missing mail, inspect the
  durable outbox/intent state, BullMQ state, and Mailpit separately without logging payload secrets.
- Install only the browser/runtime dependencies needed for the requested project. Record unavailable
  browsers honestly; do not represent a skipped browser as passed.
- Keep Playwright reports, traces, videos, screenshots, and test-results ignored by Git and Prettier.

## Author Reliable Journeys

- Use role, label, and visible-name locators. Filter generic roles such as `alert` because Next.js
  route announcers may expose the same role.
- Wait for observable navigation or state before the next action. After login, wait until the URL has
  left `/login`; before reading options or lists, assert the expected count or visible state.
- Account for hydration. Prove an interactive trigger changed `aria-expanded`, opened a dialog, or
  produced another user-visible state before depending on later controls.
- Test keyboard behavior with keyboard activation, focus return, Escape handling, skip links, and
  landmarks. Exercise phone, tablet, desktop, reduced motion, and 200% zoom/reflow when the owning
  part requires them.
- Keep provider-enabled and provider-disabled modes explicit. If one server cannot represent both,
  run bounded mode-specific commands and document the intentional conditional skip plus its passing
  companion run.
- Use fresh identities or reset disposable state. Make shell fixtures opt-in through environment
  values and verify they have the required memberships and safe notifications before running.

## Diagnose Failures

1. Read Playwright's error context, trace, screenshot, video, and network status once. Capture the
   run in full rather than piping it through `tail`: the first failure's message, locator and call
   log sit at the TOP of Playwright's output, and tailing keeps only the summary — forcing the whole
   run again to learn what broke. `error-context.md` and `trace.zip` under
   `apps/web/test-results/playwright/` survive the run and carry the page snapshot.
2. Re-run the single failing spec in isolation before calling it a defect. This suite is
   load-sensitive on a memory-capped host: a test that passes alone in seconds and fails only inside
   a full serial run is contention, not breakage. When it is contention, fix a cause you can name —
   a keystroke lost because a client effect had not installed its listener, a timeout that must also
   cover a server-side projection — or leave it and say so. Never a bare retry, a sleep, or a
   weakened assertion.
3. Decide whether the failure is product behavior, test timing/hydration, server capability setup,
   stale build output, infrastructure state, or an invalid fixture assumption.
4. Inspect only the relevant database rows, Redis keys/counts, queue states, and Mailpit metadata.
   Redact tokens and message content.
5. Fix the smallest underlying issue. Do not weaken assertions, add arbitrary sleeps, or skip a
   required scenario to obtain a green run.
6. Rerun the focused failing scenario, then the complete relevant browser project.

## Completion Evidence

Run focused Playwright scenarios first, then the applicable full project and repository gates.
Report the exact browser/project, passed/failed/skipped counts, fixture mode, infrastructure used,
commands executed, unavailable checks, generated artifacts, and unresolved risks. Never mark a
part complete when a required browser journey failed, was skipped without a passing companion mode,
or could not run.

Return the standard completion payload: `status` (`completed` | `blocked` | `failed`); result or
findings; files changed; commands or tests run; unresolved issues. Use `none` explicitly where empty.
