---
name: notted-playwright-integration
description: Author, diagnose, and verify Notted Playwright integration and end-to-end tests in apps/web/e2e and apps/web/playwright.config.ts. Use for browser journeys backed by the real Next.js app, NestJS API, PostgreSQL, Redis, Mailpit, tenant fixtures, OAuth capability modes, WebAuthn, accessibility, responsive layouts, or flaky Playwright failures.
---

# Build and Diagnose Notted Playwright Integration Tests

Read `AGENTS.md`, the selected `Plan.md` part, relevant `Notted.md` requirements, completed
prerequisite records, and `docs/standards/testing.md`. Also load `notted-frontend-editor`; load
`notted-backend-data` when a journey starts or diagnoses API, database, Redis, queue, SMTP, or auth
infrastructure.

If delegating any bounded subtask, follow the `AGENTS.md` Synchronous Delegation Protocol
recursively. Remain blocked on one finite supported wait until every started subagent is terminal.

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
- Never run the development and `e2e` Compose stacks at once: `e2e` is a profile in the same project,
  so `pnpm e2e:up` adds to a running dev stack rather than replacing it. `pnpm infra:down` first,
  `pnpm e2e:down` before returning to development.
- Pre-build the Chromium image as its own finished foreground step,
  `docker compose --profile e2e build api-e2e`, so the ~1.45 GB build neither competes with
  Playwright for memory nor sits inside a runner's no-output stall watchdog.
- Keep Playwright at one worker. `apps/web/playwright.config.ts` already pins `workers: 1` /
  `fullyParallel: false` and injects `--project=chromium`. Standing invariant; do not raise it.
- Do NOT start the `e2e` profile for `apps/api/test/export-pdf.integration.test.ts`. It is gated only
  on the browser binary and touches no database, and the development `api` container already carries
  Chromium: `docker compose -p notted-dev exec -T --workdir /workspace/apps/api api pnpm exec vitest
  run test/export-pdf.integration.test.ts`. `5 passed` is the pass condition; `skipped` is unproven.
- Reclaim Docker by name only. The daemon is shared with other projects, so `docker system prune -a`
  and `image prune -a` destroy their data; `docker builder prune` is global and forces a cold
  `api-e2e` rebuild if run just beforehand.
- Stage the run: focused spec first, whole suite second. A full serial run is 7–13 minutes.
- `api-e2e` runs `nest start --watch` and `web-e2e` runs `next dev`, so a source fix is live without
  restarting the stack.
- Re-run a failing spec alone before calling it a defect: passes isolated, fails only in the full run
  means contention. Fix a named cause or report it; never a bare retry, sleep, or weaker assertion.
- Capture a long run in full rather than piping it through `tail`: the first failure's message,
  locator and call log are at the top, and tailing keeps only the summary.
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

1. Read Playwright's error context, trace, screenshot, video, and network status once.
2. Decide whether the failure is product behavior, test timing/hydration, server capability setup,
   stale build output, infrastructure state, or an invalid fixture assumption.
3. Inspect only the relevant database rows, Redis keys/counts, queue states, and Mailpit metadata.
   Redact tokens and message content.
4. Fix the smallest underlying issue. Do not weaken assertions, add arbitrary sleeps, or skip a
   required scenario to obtain a green run.
5. Rerun the focused failing scenario, then the complete relevant browser project.

## Completion Evidence

Run focused Playwright scenarios first, then the applicable full project and repository gates.
Report the exact browser/project, passed/failed/skipped counts, fixture mode, infrastructure used,
commands executed, unavailable checks, generated artifacts, and unresolved risks. Never mark a
part complete when a required browser journey failed, was skipped without a passing companion mode,
or could not run.
