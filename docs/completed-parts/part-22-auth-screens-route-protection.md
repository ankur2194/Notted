# Part 22 — Build authentication screens and route protection

## Status

- **State:** Complete with follow-up
- **Completed on:** 2026-07-31
- **Implemented by:** Phase 4 Part 22 sequential implementation agent
- **Plan reference:** `Plan.md`, Part 22
- **Related records:** Parts 4, 6, 13, 19, 20, and 21; ADRs 0003, 0007-0010

Implementation and required verification are complete. Historical statements below describing
checks as not run reflect the initial implementation-only session and are superseded by the
completion update near the end of this record.

## Objective

Provide accessible user-facing screens for every Part 21 authentication flow, integrate
the official Better Auth browser client, validate opaque cookie sessions in Server
Components, deny unauthenticated protected route access without a client flash, and prevent
open redirects while preserving the Part 23/24/25 boundaries.

## Implemented Work

- Added Better Auth `1.6.24` browser integration using the shared Part 21 auth path contract,
  credentialed cookies, and the magic-link client plugin in a client-only transport module.
- Added a server-only session helper that forwards request cookies to the safe principal
  projection with `no-store`, validates the secret-free response shape, never logs cookies,
  and distinguishes unauthenticated from dependency-unavailable failures.
- Replaced the disabled login preview with functional login and magic-link forms. Added
  registration, forgot-password, reset-password, email-verification result/resend, and
  magic-link result pages at canonical auth-group paths.
- Forms consume shared Zod credential schemas, provide associated field errors, focused
  error summaries, live status, disabled/submitting states, password autocomplete,
  generic credential/email responses, and network retry messages.
- Added a compatible `rememberMe` checkbox and request field only. Advanced remembered
  session policy, remote session controls, OAuth, TOTP, passkeys, and recent-authentication
  UX remain Part 23.
- Added strict local redirect validation that rejects external URLs, protocol-relative
  targets, backslashes, schemes, controls, percent-encoded bypasses, overlong values, and
  loops through authentication routes. Valid targets are preserved between login and
  registration and in result callbacks.
- Protected the dashboard route-group layout with a server session check. Unauthenticated
  root access redirects to `/login?redirect=%2F`; unavailable session infrastructure fails
  closed without rendering protected children; authenticated entry-form requests redirect
  server-side to `/`.
- Added client logout through Better Auth `signOut`, followed by a server refresh and login
  navigation. The dashboard remains the Part 25 placeholder and no workspace or tenant
  data is loaded.
- Added auth-group loading/error/retry states, invalid/expired/success result states, and
  reusable accessible form controls.
- Added exact `@playwright/test@1.62.0`, monorepo-aware Chromium/Firefox/WebKit config,
  Mailpit helpers, fresh identity journeys, and focused Vitest/Testing Library tests. No
  browser binaries were installed and no authored test was executed.

## Important Decisions

- Server Components remain default. Client boundaries are limited to forms, Better Auth
  browser requests, and logout interaction; session routing decisions run on the server.
- The browser client derives its base path from `AUTH_API_PATHS.login` instead of copying
  endpoint strings. Custom hash-at-rest reset calls use the official client's `$fetch`.
- Percent signs are rejected in return targets. This deliberately trades permissive encoded
  local URLs for a small, auditable parser that cannot be reinterpreted after validation.
- Magic-link success/result is the narrow authenticated auth-group exception: the callback
  page confirms the one-time link before the user continues. Login, registration, forgot,
  reset, and verification pages redirect authenticated users before rendering.
- A valid session proves identity only. Part 24 still owns workspace/resource authorization,
  and Part 25 still owns the real dashboard shell.
- Production must use a routing/cookie topology in which the web request receives the
  opaque cookie that is forwarded to the API (normally one public host/reverse proxy or an
  explicitly reviewed shared cookie domain). No cross-site cookie workaround was invented.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/web/src/lib/auth/` | Official browser client, callbacks, safe redirects, request wrappers, server-only session lookup, auth entry guard, and focused tests |
| `apps/web/src/components/auth/` | Login, registration, magic-link, recovery, verification, reset, logout, and auth-card components/tests |
| `apps/web/src/components/ui/form-controls.tsx` | Reusable labeled field, focused error summary, and live status primitives |
| `apps/web/src/app/(auth)/` | Canonical auth entry/result routes plus loading/error states |
| `apps/web/src/app/(dashboard)/layout.tsx` | Server-side protected layout and fail-closed session state |
| `apps/web/e2e/` | Fresh-identity Playwright auth journeys and Mailpit helper |
| `apps/web/playwright.config.ts` | Monorepo web/API startup and three-browser configuration |
| `apps/web/package.json`, `package.json`, `pnpm-lock.yaml` | Exact Better Auth/Playwright dependencies and scripts |
| `.gitignore` | Ignores Playwright HTML reports |
| `README.md`, `docs/README.md`, `docs/environment.md` | Local auth UI, E2E, cookie topology, and test environment guidance |

## Database and Data Changes

None. Part 22 adds no schema, migration, seed, retention, or tenant-owned data change. It
depends on Part 21 migration `0008_sour_queen_noir.sql`, which remains unverified.

## API, Configuration, and Operational Changes

- Consumes the Part 21 unversioned Better Auth routes exported through `AUTH_API_PATHS` and
  `GET /api/v1/auth/session`; no API route was added or renamed.
- Adds root/web `test:e2e` scripts and Playwright-only optional runner values
  `PLAYWRIGHT_APP_URL`, `PLAYWRIGHT_API_URL`, and `PLAYWRIGHT_MAILPIT_URL`.
- Default Playwright values use web `3000`, API `3001`, and Mailpit `8025`. The suite expects
  infrastructure and migration prerequisites and never installs browser binaries.

## Security and Tenant-Isolation Notes

- Cookie values are forwarded only in a server request header and are neither returned nor
  logged. Session lookup uses `cache: "no-store"` and malformed/suspended infrastructure
  fails closed.
- Return targets are local-only and auth-loop-free. Callback URLs are built from the typed
  public app origin after target validation.
- UI errors do not display backend/provider messages, rejected passwords, tokens, or account
  existence. Forgot, resend, and magic-link request success text remains generic.
- Better Auth remains the password/session authority. No token storage, JWT, bearer flow,
  workspace claim, role, or client-side authorization was added.
- Part 24 must still enforce membership and tenant isolation for all workspace data. The
  protected placeholder proves only identity and intentionally fetches no tenant resource.

## Verification Evidence

| Check | Result | Notes |
|---|---|---|
| `git status --short` | Inspection only | Run before implementation to identify and preserve the uncommitted Part 21 change set. |
| `pnpm view @playwright/test version engines --json` | Dependency metadata only | Reported `1.62.0` with Node `>=20`; not a project verification gate. |
| `pnpm install --no-frozen-lockfile --strict-peer-dependencies` | Artifact generation timed out | Run twice; dependency resolution reached package linking but each shell call timed out. No pass is claimed. |
| `pnpm install --ignore-scripts --no-frozen-lockfile --strict-peer-dependencies` | Artifact generation only | Completed lockfile/workspace linking without lifecycle scripts. This was necessary to produce dependency artifacts, not treated as verification. |
| Tests, Playwright, browser binaries, lint, formatting check, type-check, build, audit, review, final diff review | **Not run by instruction** | Verification is explicitly pending the quality reviewer. |

## Known Limitations and Follow-up Work

- Part 21 and Part 22 are both unverified and may contain type, API, cookie, runtime,
  migration, Mailpit, or cross-browser integration defects.
- Quality review must inspect the lockfile/dependency graph because the first two install
  calls timed out; the final `--ignore-scripts` install completed but did not run lifecycle
  scripts.
- Verify official Better Auth response typing/method inference, magic-link callback behavior,
  cookie availability to Next Server Components, CORS/origin handling, and logout cookie
  invalidation against Better Auth `1.6.24`.
- Verify all focused Vitest/Testing Library suites, three Playwright projects, refresh/direct
  routing, one-time/expired links, generic account responses, accessibility, lint,
  formatting, strict type-check, production build, and dependency audit.
- Playwright browsers are intentionally absent. The reviewer may install them outside this
  implementation boundary before running browser journeys.
- Part 23 owns actual remember-me policy validation and advanced auth methods/session
  controls. Part 24 owns authorization. Part 25 replaces the protected placeholder.

## Handoff Notes

Start with Part 21 verification because Part 22 exercises its unverified routes, migration,
Redis session path, and email worker. Run focused web utilities/forms tests before the full
browser journeys. Keep test identities fresh; seed users intentionally have no credentials.
Do not include cookie/token values in failure artifacts or logs.

## Completion Verification Update

- Two independent review rounds completed and all reported frontend/auth integration findings were
  remediated before the lead completion review.
- The 24-file/116-test web suite, broad repository formatting/lint/type-check/tests, production
  build, and live backend authentication suites passed.
- Chromium Playwright passed valid/invalid registration, direct protected access, safe redirects,
  refresh, logout, expired/replayed links, password reset, magic-link, and Mailpit-backed flows.
- Firefox and WebKit remain configured but were not required by Part 22's completion criterion;
  broad browser validation remains Part 76. Track the reviewed transitive advisories in Part 21.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-29 | Phase 4 Part 22 sequential implementation agent | Authored implementation, tests, dependencies, and docs; state remains In progress with verification pending by instruction. |
| 2026-07-31 | Lead part engineer | Completed review remediation and live Chromium/repository verification; marked Complete with follow-up. |
