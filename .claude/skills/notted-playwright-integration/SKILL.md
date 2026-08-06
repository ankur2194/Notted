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

Return the standard completion payload: `status` (`completed` | `blocked` | `failed`); result or
findings; files changed; commands or tests run; unresolved issues. Use `none` explicitly where empty.
