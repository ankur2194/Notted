# Part 23 — Add OAuth, two-factor authentication, passkeys, and session controls

## Status

- **State:** Complete
- **Completed on:** 2026-07-31
- **Implemented by:** Phase 4 Part 23 sequential implementation agent
- **Plan reference:** `Plan.md`, Part 23
- **Related records:** Parts 13, 19, 20, 21, and 22; ADRs 0003, 0007-0010

Implementation and required verification are complete. Historical statements below describing
checks as not run reflect the initial implementation-only session and are superseded by the
completion update near the end of this record.

## Objective

Extend the pinned Better Auth 1.6.24 opaque-session integration with optional Google, GitHub,
and Microsoft OAuth, encrypted TOTP/recovery behavior, WebAuthn passkeys, explicit remember-me
policy, recent-authentication enforcement, and safe user session controls in the canonical
dashboard settings area. Preserve Better Auth as the sole credential/session authority and keep
workspace/resource authorization in Part 24.

## Implemented Work

- Added strict optional OAuth tuple parsing. Disabled providers are omitted entirely; partial
  tuples fail startup by variable name without reflecting supplied values. A public capabilities
  projection returns provider IDs/labels and safe durations only.
- Added exact `@better-auth/passkey@1.6.24` server/browser plugins with validated RP ID and exact
  origins, required user verification, named registration, safe listing, removal, passwordless
  login, and unsupported/insecure-context guidance.
- Compared the installed passkey plugin schema to the existing Part 13 `passkey` table. Fields
  match, so no schema source or migration was changed. An executable comparison test was authored.
- Enabled Better Auth TOTP plus encrypted recovery codes, enrollment confirmation, one-time
  presentation, regeneration, sign-in challenges, per-challenge limits, and account-level
  lockout using the existing `two_factor` table.
- Configured one shared recent-authentication window in Better Auth `session.freshAge`, the
  internal principal, raw high-risk Better Auth paths, and versioned session mutations. Added a
  reauthentication endpoint/dialog using Better Auth's current password authority; passkey
  confirmation verifies that the same user remains authenticated. Password state is cleared.
- Applied the same freshness gate to TOTP enrollment confirmation/URI access, passkey
  registration/update/removal, account linking, email/password/account changes, and all session
  revocations. A login-time TOTP challenge remains usable without an already-authenticated
  session and is bounded by Better Auth's signed challenge cookie and lockout controls.
- Reconciled remember-me UI with Better Auth's actual API: password login sends the explicit
  boolean; non-remembered sessions are one day with a browser-session cookie; remembered sessions
  use the configured day count. Better Auth's TOTP management rotations preserve the current
  one-day/remembered intent instead of promoting a non-remembered session. Registration no longer
  presents a misleading session option because registration does not auto-sign in.
- Added safe active-session and passkey projections. Session tokens, IP addresses, raw user
  agents, passkey public keys, and credential IDs never enter the settings response. Remote revoke
  and revoke-others are ownership-checked, origin-checked, freshness-gated, and idempotent.
- Disabled raw Better Auth routes that would expose session/provider token material or raw session
  and passkey records. Internal Better Auth adapters still own authoritative list/revocation.
- Added canonical `/settings/security` Server Component page with a bounded interactive client,
  loading/empty/error/retry states, current-session indication, dates, device summaries, TOTP QR
  and otpauth fallback, one-time recovery display, and keyboard/focus-aware reauthentication.
- Added enabled-only OAuth buttons to login/register with local callback construction and generic
  errors. Disabled/unrecognized providers are rejected at the API boundary, and provider callback
  failures return to a generic local login state. Passkey login remains available when OAuth
  providers are disabled.
- Extended structured redaction for one-time codes, recovery codes, TOTP URIs, credential IDs,
  and public-key material.
- Authored focused API, shared-contract, component, and Playwright coverage. Chromium virtual
  authenticators are used for passkey journeys; OAuth is mocked without provider credentials.

## Important Decisions

- Better Auth 1.6.24 remains the only credential/session authority. No JWT, bearer, refresh-token,
  Passport, parallel session, or second password verifier was added.
- Microsoft is enabled only with client ID, client secret, and tenant ID. Google and GitHub each
  require client ID plus client secret. Provider credentials remain API-only.
- Account linking is explicit: implicit same-email linking is disabled, local email verification
  remains required, and no provider is globally trusted for implicit links. Link/unlink paths are
  recent-authentication gated.
- `@better-auth/passkey@1.6.24` (MIT) exactly matches Better Auth. `qrcode.react@4.2.0` (ISC) renders
  the enrollment QR locally so the otpauth URI is never sent to a third-party image service.
- Better Auth 1.6.24 hard-codes remembered-session creation during authenticated TOTP management
  rotations. A narrowly scoped Better Auth database-create hook retains the active session's
  one-day expiry on confirmation/disable; sign-in challenges retain Better Auth's own signed
  remember-me intent.
- Passkey and TOTP plugin schema comparisons found no drift. Migrations `0000`-`0008`, snapshots,
  and journal entries were not edited and no migration was generated.
- The assurance projection remains conservatively `single-factor`: Better Auth 1.6.24 does not
  persist a trustworthy per-session method/second-factor claim across password, magic-link,
  OAuth, and passkey sessions. Freshness is stable and explicit; Part 24 must not infer workspace
  access or stronger assurance than the principal states.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/src/config/auth.config.ts` | OAuth tuples, WebAuthn RP/origins, freshness, challenge, and lockout config |
| `apps/api/src/auth/better-auth.setup.ts` | Optional providers, TOTP/passkey plugins, reauthentication, high-risk gates, remember-intent-preserving rotation, disabled unsafe projections |
| `apps/api/src/auth/auth.service.ts` | Safe capabilities, shared freshness, origin enforcement, principal contract |
| `apps/api/src/auth/auth-security.service.ts` | Safe session/passkey overview and authoritative idempotent revocation |
| `apps/api/src/auth/auth.controller.ts`, `auth.module.ts` | Thin versioned capabilities/security/session transports and DI |
| `apps/api/src/auth/advanced-auth.test.ts`, `apps/api/test/advanced-auth.e2e.test.ts` | Config/schema/freshness/redaction and live TOTP/session coverage |
| `apps/api/src/config/auth.config.test.ts`, `environment-contract.test.ts` | Provider tuple, RP/origin, and secret-safe startup contracts |
| `apps/api/src/common/logging/structured-logger.service.ts` and test | Expanded advanced-auth redaction |
| `apps/web/src/lib/auth/` | Passkey/2FA client plugins, safe capabilities/security requests, advanced request wrappers |
| `apps/web/src/components/auth/` | OAuth/passkey entry, 2FA challenge, reauthentication dialog and component tests |
| `apps/web/src/components/settings/security-settings.tsx` and test | Interactive bounded user security settings |
| `apps/web/src/app/(auth)/two-factor/` | Sign-in challenge route |
| `apps/web/src/app/(dashboard)/settings/security/` | Canonical protected page plus loading/error boundaries |
| `apps/web/e2e/advanced-auth.spec.ts` | Mock OAuth, TOTP/recovery, virtual-authenticator passkey, remember, revocation, a11y journeys |
| `packages/shared-types/src/auth.ts`, `packages/shared-types/src/api.ts`, `packages/shared-validators/src/auth.schema.ts` and barrels/tests | Secret-free contracts, stable auth error codes, and bounded advanced-auth inputs |
| `apps/api/package.json`, `apps/web/package.json`, `pnpm-lock.yaml` | Exact passkey and local QR dependencies |
| `apps/api/.env.example`, `README.md`, `docs/README.md`, `docs/environment.md` | Configuration, callback, RP/origin, secure-context, and local security guidance |

## Database and Data Changes

None. The installed passkey plugin declares the existing Part 13 fields `name`, `publicKey`,
`userId`, `credentialID`, `counter`, `deviceType`, `backedUp`, `transports`, `createdAt`, and
`aaguid`. The installed two-factor plugin declares the existing `secret`, `backupCodes`, `userId`,
`verified`, `failedVerificationCount`, and `lockedUntil` fields. No migration was generated or
modified. Existing auth rows remain Better Auth-owned; seed data remains non-authenticating.

## API, Configuration, and Operational Changes

- Public safe metadata: `GET /api/v1/auth/capabilities`.
- Protected safe overview: `GET /api/v1/auth/security`.
- Fresh, origin-protected controls: `DELETE /api/v1/auth/sessions/:sessionId` and
  `POST /api/v1/auth/sessions/revoke-others`.
- Better Auth additions include `/notted/reauthenticate`, `/two-factor/*`, and `/passkey/*`.
  Raw session/passkey list routes and provider token retrieval/refresh routes are disabled.
- New server values: `AUTH_OAUTH_GOOGLE_CLIENT_ID`, `AUTH_OAUTH_GOOGLE_CLIENT_SECRET`,
  `AUTH_OAUTH_GITHUB_CLIENT_ID`, `AUTH_OAUTH_GITHUB_CLIENT_SECRET`,
  `AUTH_OAUTH_MICROSOFT_CLIENT_ID`, `AUTH_OAUTH_MICROSOFT_CLIENT_SECRET`,
  `AUTH_OAUTH_MICROSOFT_TENANT_ID`, `AUTH_PASSKEY_RP_ID`, `AUTH_PASSKEY_ORIGINS`,
  `AUTH_RECENT_AUTH_SECONDS`, `AUTH_TWO_FACTOR_CHALLENGE_SECONDS`,
  `AUTH_TWO_FACTOR_LOCKOUT_ATTEMPTS`, and `AUTH_TWO_FACTOR_LOCKOUT_SECONDS`.
- Production WebAuthn uses HTTPS; only `http://localhost` is allowed in development. OAuth
  callbacks are registered under the configured Better Auth base URL as documented.

## Security and Tenant-Isolation Notes

- Authentication data remains global identity infrastructure, not workspace-owned data. No role,
  membership, workspace claim, or authorization policy was added. Part 24 must load live workspace
  access independently.
- OAuth secrets are parsed only on the server, omitted from metadata, and not present in examples,
  tests, docs, errors, or logs. OAuth callbacks and browser return paths remain trusted/local.
- TOTP secrets and recovery codes remain encrypted at rest by Better Auth. They are presented only
  during explicit enrollment/regeneration and are redacted from logging paths.
- WebAuthn challenges are short-lived/signed, origins and RP IDs are exact, registration requires
  a fresh authenticated session, user verification is required, and removal is ownership/freshness
  protected.
- State-changing versioned routes require an exact trusted `Origin`; raw Better Auth mutations use
  its CSRF/origin middleware. Error UI remains generic and does not enumerate accounts.

## Verification Evidence

| Check | Result | Notes |
|---|---|---|
| `git status --short` | Inspection only | Run before implementation to preserve uncommitted Parts 21-22 work. |
| `pnpm view "@better-auth/passkey@1.6.24" version peerDependencies dependencies engines license --json` | Dependency metadata only | Confirmed exact plugin compatibility and MIT license; not a verification gate. |
| `pnpm --filter "@notted/api" add "@better-auth/passkey@1.6.24" --save-exact --strict-peer-dependencies` then equivalent web command | Artifact generation only | Installed exact server/browser package and updated lockfile; lifecycle ran Husky. |
| `pnpm view "qrcode.react@4.2.0" version peerDependencies dependencies engines license --json` | Dependency metadata only | Confirmed React 19 peer support and ISC license. |
| `pnpm --filter "@notted/web" add "qrcode.react@4.2.0" --save-exact --strict-peer-dependencies` | Artifact generation only | Installed local QR renderer and updated lockfile; lifecycle ran Husky. |
| Tests, Playwright, browser binaries, lint, format, type-check, build, audit, review, final diff review, migration checks/execution | **Not run by instruction** | Verification is explicitly pending the dedicated reviewer. |

## Known Limitations and Follow-up Work

- Parts 21-23 are unverified and may contain compile, API inference, runtime, browser, cookie,
  Redis, migration prerequisite, or accessibility issues.
- Shared package `dist/` outputs were not regenerated because builds were prohibited. The
  reviewer must build shared packages before API/web runtime checks and retain only the
  repository's expected generated-output policy.
- Quality review must verify Better Auth hook ordering, internal adapter list/delete behavior,
  disabled raw paths, 2FA enrollment session rotation, account lockout, one-time recovery races,
  OAuth callback behavior, and passkey origin/RP behavior against 1.6.24.
- Verify the authored non-remembered/remembered database and cookie expiry coverage before and
  after reauthentication and TOTP enrollment/disable rotations, including the narrowly scoped
  database hook that preserves non-remembered intent.
- Playwright browser binaries were not installed. Chromium CDP virtual-authenticator coverage and
  Firefox/WebKit unsupported/error behavior remain pending execution.
- Part 24 consumes only the stable user ID, session ID, conservative assurance, expiry, and
  freshness contract for authorization. Part 25 consumes these controls in the full dashboard
  shell. SAML/SSO remains out of scope.

## Handoff Notes

Verify Parts 21 and 22 first, then run Part 23 focused config/schema/unit suites, live PostgreSQL +
Redis auth E2E, and browser journeys. Do not add provider credentials to tests; OAuth Playwright
coverage intentionally mocks safe metadata and initiation. Keep migrations `0000`-`0008`
immutable. If an installed plugin schema comparison later shows real drift, generate a new forward
migration rather than editing prior artifacts.

## Completion Verification Update

- Two independent review rounds completed; provider, session, freshness, redaction, and browser
  findings were remediated before the lead completion review.
- Focused and broad API/web suites, live advanced-auth integration, strict repository gates, and
  the production build passed.
- Chromium Playwright passed provider-disabled and configured-Google states, callback failure,
  TOTP/recovery, virtual WebAuthn registration/login/removal, remembered/non-remembered cookies,
  recent authentication, and remote session revocation.
- Firefox/WebKit unsupported-state validation remains Part 76. Transitive dependency advisories
   resolved per Part 21.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-07-29 | Phase 4 Part 23 sequential implementation agent | Authored advanced auth implementation, tests, dependencies, docs, and pending-verification record. |
| 2026-07-29 | Phase 4 Part 23 resumed implementation agent | Preserved prior artifacts; tightened provider rejection/callback failure handling, account/passkey/TOTP freshness, non-remembered TOTP rotations, sequential revocation, redaction, and unsupported/insecure passkey states. Verification remains pending by instruction. |
| 2026-07-31 | Lead part engineer | Completed review remediation and live advanced-auth/browser/repository verification; marked complete. |
