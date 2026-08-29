# Part 74 — Security hardening and abuse controls

## Status

- **State:** Complete
- **Completed on:** 2026-08-25
- **Implemented by:** Claude Code session (backend/platform engineer + parallel specialists)
- **Plan reference:** `Plan.md`, Part 74
- **Related records:** [Part 21](part-21-better-auth-backend.md) (Better Auth, its hooks, rate-limit
  `customRules`, and the `GHSA-36xv-jgw5-4q75` suppression this part re-examines),
  [Part 24](part-24-centralized-authorization.md) (the policy layer this part does not touch and
  deliberately does not duplicate), [Part 65](part-65-public-rest-api-api-keys.md)
  (`assertTrustedMutationOrigin`, and the settled rule that the Origin check is meaningless for
  API keys), [Part 71](part-71-audit-logging-admin-views.md) (`audit_logs`, the repudiation
  control the threat model cites), [Part 72](part-72-branding-and-customization.md) (the public
  tokenised logo GET and the deliberately-unshipped custom CSS),
  [Part 73](part-73-custom-domain-support.md) (verified custom hostnames, the trusted-host
  middleware, and the `isTrustedOriginSync` seam this part reuses rather than re-derives)
- **Related decision:** [ADR 0014](../decisions/0014-workspace-branding-and-custom-domains.md)
  (custom-domain trust model, which the threat model's B10 boundary depends on)

## Objective

Close out the security review `Plan.md` names: CSRF, XSS, SSRF, SQL injection, path traversal,
upload bombs, websocket abuse, brute force, session fixation, open redirects, CSP, CORS and
secret handling — and add what the review found missing rather than re-litigating what already
works.

Three things were genuinely missing, and they are what this part builds:

1. **Brute force had no identifier axis.** Every existing limit was keyed by IP, which a
   distributed attacker rotates for free. Credential stuffing does not care about per-IP limits.
2. **CSRF protection was opt-in.** `assertTrustedMutationOrigin` is called by hand at ~97 call
   sites. That is a convention, not a boundary: a controller added tomorrow that forgets the call
   is forgeable, and nothing fails.
3. **There was no written threat model and no remediation record**, so no exception had an owner
   or a deadline — which is precisely the artefact `Plan.md`'s verification asks for.

Everything else in the review list was found already implemented and is recorded as **Verified**
in the checklist with the file that carries the control, not re-built.

## Implemented Work

- **`AuthLockoutService` (`auth/auth-lockout.service.ts`) — the per-identifier control.** A
  60-second request budget (`RATE_LIMIT_AUTH_PER_MINUTE`, default 5) and a lockout
  (`AUTH_LOCKOUT_ATTEMPTS` 10 failures within `AUTH_LOCKOUT_SECONDS` 900) keyed on the attempted
  email. State lives in **Redis**, via the existing `incrementWithTtl` Lua INCR+PEXPIRE, so it
  holds across replicas — a lockout that only holds on the instance that saw the failures is not
  a lockout. The identifier is **never stored or logged in the clear**: every key and the
  `account_locked` warning carry only its SHA-256. The refusal message is byte-identical for a
  known and an unknown identifier, so the lockout cannot be turned into an account-enumeration
  oracle.
- **Where the counting happens, and why it is split.** Better Auth needs the raw request stream,
  so `auth-rate-limit.middleware.ts` must not parse the JSON body and therefore cannot see the
  email. The per-IP half stays in that Express middleware; the per-identifier half moved into
  Better Auth's `hooks.before`, which is the first place the body is parsed. The before-hook
  consumes the budget and asserts the lock **before any validation, session lookup or password
  hash**, so a refused attempt costs the server less than it costs the attacker.
- **Outcome recording in `hooks.after`.** Better Auth 1.6.24 accepts exactly one `hooks.after`
  middleware (`after?: AuthMiddleware`, not an array), so the existing
  `preserveRotationCookieHook` and the new sign-in outcome hook are **composed into one**
  `afterHook` rather than registered separately. Only a **401** on `/sign-in/email` counts as a
  failure: an unverified account answers 403 and a malformed body 400, and counting those would
  let a bad client lock its own user out.
- **Better Auth's IP resolution, which was a real finding.** Its default trusts inbound
  `x-forwarded-for` unconditionally, and with no proxy in front it falls back to a constant that
  collapses every caller into one bucket. `advanced.ipAddress.ipAddressHeaders` is now pinned to a
  single private `x-notted-client-ip`, and `main.ts` **overwrites** that header unconditionally
  from Express's `request.ip` — which already honours the deployment's `trust proxy` setting. An
  inbound value for that name never survives, and naming exactly one header makes the spoofable
  ones unreadable to the limiter.
- **`CsrfOriginMiddleware` (`auth/csrf-origin.middleware.ts`) — default-deny, mounted once.** On
  `/api/v1`, after the credential middleware (it must know whether an API-key actor was installed)
  and before tRPC and the Nest pipeline. Three conditions, all required: a mutating method, a
  session cookie present, and no API-key actor. It reuses `AuthService.assertTrustedMutationOrigin`
  rather than re-deriving origin logic, so Part 73's verified custom-domain origins are honoured
  automatically. **The ~97 existing manual calls stay** — they are the ones a reviewer sees next to
  the mutation they protect; this is the layer that catches the call someone forgets to write.
- **Explicit helmet configuration (`main.ts`).** `default-src 'none'` with nothing added, plus
  `frame-ancestors`, `base-uri` and `form-action` all `'none'`: an API response has no legitimate
  subresource of any kind, so the strictest policy is also the correct one. CORP `same-origin`
  (attachments and exports already downgrade themselves to `same-site` where the web app must read
  the bytes cross-origin), `Referrer-Policy: no-referrer`, and **HSTS in production only** — sending
  it from `http://localhost:3001` would pin the developer's browser to HTTPS for localhost and
  durably break every other local project on that host. The Bull Board CSP override is unchanged.
- **Web response headers (`apps/web/security-headers.js`, wired through `next.config.js`).** A
  CJS pure function `buildSecurityHeaders({ apiUrl, wsUrl, production })` producing the full CSP,
  `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`,
  `X-Frame-Options: DENY` and production-only HSTS. A malformed environment value omits that CSP
  source rather than throwing, because a bad env value must not fail the build.
- **Extended log redaction (`common/logging/structured-logger.service.ts`).** API keys,
  signatures, `set-cookie`, private keys, webhook secrets, access keys, connection strings and
  DSNs, in both bare and `*.` forms, plus the `res.headers` / `err.*` / `error.*` object paths
  where a provider library will happily attach an entire authenticated request. The two
  hyphenated names use fast-redact bracket notation (`["x-api-key"]`), which is required — a bare
  hyphenated path is not a valid redact path.
- **On-demand scanning (`scripts/security-scan.mjs`, `pnpm security:check`).** `security:deps` is
  `pnpm audit --prod --audit-level=high` reusing the existing suppression verbatim;
  `security:containers` runs Trivy through Docker, **pinned by digest** because an
  unpinned scanner is itself a supply-chain risk, against the images named in `compose.yaml`. The
  scanner receives the image as a tarball written by `docker save` and bind-mounted read-only; it
  is never handed the Docker socket. (Corrected after the Part 74 review: the original pin,
  `aquasec/trivy:0.68.0`, was a tag upstream never published, so every run failed to start and was
  counted as a scan finding. See `scripts/security-scan.mjs`.) A run
  in which every image was absent locally exits 0 but prints an explicit "nothing scanned … this is
  not a pass" line, so an empty run can never be misread as a clean one. Not wired into CI, which
  this project does not have by design.
- **`docs/security/threat-model.md` and `docs/security/remediation-checklist.md`.** Assets, actors,
  ten numbered trust boundaries, and STRIDE tables for nine surfaces — each row naming the control
  and the file it lives in — plus OWASP A01–A10 with every finding marked Verified, Fixed in
  Part 74, or Exception. Five exceptions, all owned by Ankur Patel, each with a plan-part deadline.

## Important Decisions

- **The per-identifier budget is not in the Express middleware, and that is the whole design.**
  Parsing the JSON body there would consume the stream Better Auth needs. Splitting per-IP
  (Express, in-memory) from per-identifier (Better Auth hook, Redis) is not duplication; it is the
  only place each axis is observable.
- **Redis for the lockout, in-memory left alone for the general tier.** The general
  `RateLimitStore` stays in-memory and is recorded as exception **E2** (→ Part 80) rather than
  migrated opportunistically. The lockout is the control where per-replica state is a correctness
  bug, so only it moved.
- **One identical message for known and unknown identifiers.** A distinct "this account is
  locked" reply would be an enumeration oracle — a worse leak than the brute force it stops. The
  tests assert this property explicitly rather than assuming it.
- **OAuth and passkey paths are deliberately absent from `AUTH_IDENTIFIER_PATHS`.** Neither
  accepts a guessable secret, and locking on them would let one attacker lock a victim out of
  their own provider sign-in.
- **The auth tier is tighter than the sensitive tier (5 vs 10) and uses a disjoint `:auth` bucket
  key**, so draining authentication attempts never consumes a caller's allowance for sensitive
  application routes, and vice versa.
- **CORS still accepts an `undefined` origin.** That is what an API-key integration sends, and
  rejecting it would break every legitimate non-browser caller. Documented rather than changed —
  the CSRF middleware's cookie condition is what makes it safe.
- **`script-src 'unsafe-inline'` is accepted, not worked around.** Next 16's App Router emits
  inline flight scripts and there is no nonce seam without a proxy rewrite. Recorded as exception
  **E1** (→ Part 82) with a `ponytail:` comment at the code site naming the upgrade path, rather
  than shipping a CSP that silently does not apply.
- **No new dependencies.** Trivy runs as a pinned container; the compose image list is extracted
  by a regex over `image:` lines with a `ponytail:` comment naming the ceiling (nested image
  declarations) and the upgrade path (a real YAML parser) if compose ever grows them.

## Files and Components

**Created**

| Path | Purpose |
|---|---|
| `apps/api/src/auth/auth-lockout.service.ts` | Per-identifier budget, lockout, hashed identifiers, `AuthLockoutError` |
| `apps/api/src/auth/auth-lockout.service.test.ts` | Fake-Redis unit suite incl. the enumeration and privacy properties |
| `apps/api/src/auth/csrf-origin.middleware.ts` | Default-deny Origin check for mutating cookie-authenticated `/api/v1` requests |
| `apps/api/src/auth/csrf-origin.middleware.test.ts` | Method, cookie, API-key and both cookie-spelling cases |
| `apps/api/src/auth/auth-rate-limit.middleware.test.ts` | Proves the AUTH tier and the `:auth` bucket key are used |
| `apps/web/security-headers.js` | `buildSecurityHeaders({ apiUrl, wsUrl, production })` (CJS, apps/web root) |
| `apps/web/src/config/security-headers.test.ts` | Production/development CSP divergence and every static header |
| `scripts/security-scan.mjs` | `imagesFromCompose` + the `containers` Trivy subcommand |
| `scripts/security-scan.test.mjs` | `node:test` coverage of the compose image extraction |
| `docs/security/threat-model.md` | Assets, actors, B1–B10 boundaries, STRIDE across nine surfaces |
| `docs/security/remediation-checklist.md` | OWASP A01–A10 with Verified / Fixed in Part 74 / Exception |

**Modified**

| Path | Change |
|---|---|
| `apps/api/src/main.ts` | Explicit helmet policy; `x-notted-client-ip`; `CsrfOriginMiddleware` mount |
| `apps/api/src/auth/better-auth.setup.ts` | `AUTH_IDENTIFIER_PATHS`, before-hook budget/lock, composed `afterHook`, auth-tier `customRules`, `advanced.ipAddress`, magic-link tier |
| `apps/api/src/auth/auth-rate-limit.middleware.ts` | Auth tier and disjoint `:auth` bucket |
| `apps/api/src/auth/auth.module.ts` | Provides/exports `AuthLockoutService` and `CsrfOriginMiddleware`; passes `lockout` to the setup |
| `apps/api/src/config/app.config.ts` | `authRateLimitPerMinute` (`RATE_LIMIT_AUTH_PER_MINUTE`) |
| `apps/api/src/config/auth.config.ts` | `lockoutAttempts`, `lockoutSeconds` |
| `apps/api/src/common/logging/structured-logger.service.ts` | Extended redaction list |
| `apps/api/src/auth/advanced-auth.test.ts`, `.../structured-logger.service.test.ts`, `.../environment-contract.test.ts` | New assertions for this part |
| `apps/api/test/auth.e2e.test.ts` | Module-scope env overrides; lockout and session-fixation cases |
| `apps/web/next.config.js` | `headers()` wired to `buildSecurityHeaders` |
| `package.json` | `security:deps`, `security:containers`, `security:check` |
| `compose.yaml` | `RATE_LIMIT_AUTH_PER_MINUTE: "10000"` on the e2e anchor only |
| `apps/api/.env.example`, `docs/environment.md`, `docs/README.md`, `docs/standards/security.md` | The three new variables and the scan commands |

## Database and Data Changes

**None.** No schema change, no migration, no seed change. Every piece of state this part adds is
ephemeral and lives in Redis under `auth:budget:`, `auth:fail:` and `auth:lock:` keys, all
TTL-bounded. Losing Redis loses the counters, which fails **open** for the lockout and closed for
authentication itself (Better Auth requires Redis secondary storage, so no-Redis deployments have
no auth to brute-force).

## API, Configuration, and Operational Changes

- **Three new optional environment variables**, all with safe defaults, so no deployment must
  change to upgrade: `RATE_LIMIT_AUTH_PER_MINUTE` (5, 1–10000), `AUTH_LOCKOUT_ATTEMPTS` (10,
  3–100), `AUTH_LOCKOUT_SECONDS` (900, 60–86400).
- **New refusal shapes on the Better Auth base path:** `429 RATE_LIMITED` and `423 ACCOUNT_LOCKED`,
  both carrying `Retry-After`. `Retry-After` is already in the CORS `exposedHeaders` list, so the
  browser client can read it.
- **New response headers on every web route** and a materially stricter set on the API. The one
  operationally significant consequence: **HSTS now ships in production** from both apps.
- **`pnpm security:check`** is new and on demand. It requires Docker for the container half and
  skips images that are not present locally.
- **The e2e Compose anchor raises `RATE_LIMIT_AUTH_PER_MINUTE` to 10000.** A containerised
  Playwright shares one address and cycles dozens of identities; the development `api` service
  keeps the default of 5.

## Security and Tenant-Isolation Notes

- **No authorization change.** This part adds no action, no resource kind and no policy branch;
  `Part 24`'s layer decides exactly what it decided before. Tenant isolation is untouched, which
  is why no cross-tenant test was added — there is no new tenant-scoped surface.
- **The lockout is per identifier, not per user row**, so it applies identically to an address
  that has no account. That is deliberate and is what makes the generic message meaningful.
- **A lockout is a denial-of-service primitive against a known address.** The 15-minute expiry is
  the mitigation; a permanent lock or an admin-unlock flow would be worse, because it would let an
  attacker take a victim offline until a human intervened.
- **The CSRF middleware cannot be bypassed by omitting the cookie**, because omitting it also
  removes the credential the mutation needs. Public unauthenticated routes (Part 72's logo GET,
  Part 73's resolve) are unaffected by construction.
- **Nothing in this part logs an identifier, token, cookie or origin value.** The lockout warning
  carries a hash and a count.

## Verification Evidence

Gates were run serially by two independent review rounds and a final main-thread pass on 2026-08-25 (dev stack on the alternate-port root `.env`; the e2e stack was never started). Results below are from the final pass unless a note says otherwise.

| Check | Result | Notes |
|---|---|---|
| `pnpm lint` | **Pass** | Repo root, 2026-08-25 final run: `Tasks: 4 successful, 4 total`, `--max-warnings 0`, no problems |
| `pnpm format:check` | **Pass** | `All matched files use Prettier code style!` |
| `pnpm type-check` | **Pass** | `Tasks: 6 successful, 6 total` |
| `pnpm test` | **Pass** | api `204 passed \| 27 skipped (231)`, web `155 passed (155)`, shared-validators `16 passed`, shared-types `4 passed`; `node --test scripts/*.test.mjs` `# pass 21 / # fail 0` |
| `pnpm test:ci` | **Pass** | `DATABASE_URL` (postgres 5433) and `REDIS_URL` (6380) exported, dev stack on the alternate-port `.env`: api `224 passed \| 7 skipped`, coverage `85.57 / 77.07 / 86.73 / 87.81`; web `155 passed`, `79.9 / 72.82 / 81.42 / 82.35`; shared-validators branch `77.17`; shared-types branch `95.69` — every threshold ≥ 70 met. The 7 skipped API suites are MinIO/Meilisearch/Chromium/`AUTH_E2E`-gated |
| `pnpm build` | **Pass** | Prefixed with the three `NEXT_PUBLIC_*` values: `Tasks: 4 successful, 4 total` |
| `pnpm --filter @notted/api db:check` | **Pass** | `Everything's fine 🐶🔥` with migrations `0021`–`0023` in the journal |
| `apps/api/test/auth.e2e.test.ts` (`AUTH_E2E=true`) | **Pass** | Run inside the dev `api` container (`docker compose -p notted-dev exec … -e AUTH_E2E=true -e MAILPIT_API_URL=http://mailpit:8025 api pnpm exec vitest run test/auth.e2e.test.ts`): `3 passed (3)` — the 401×3 → 423 + `Retry-After` sequence, the enumeration-safe constant, and distinct session cookies across two sign-ins |
| `pnpm security:deps` | **Pass (run in review round 1)** | Exit 0. `7 vulnerabilities found / Severity: 3 moderate (1 ignored) \| 4 high (4 ignored)` — every ignored id carries an owner and a deadline in the remediation checklist. Before the fix this script exited 0 unconditionally while masking the four highs |
| `pnpm audit:prod` | **Fails, deliberately (run in review round 1)** | Exit 1 on `postcss` GHSA-fxqj-rqcc-2cmp (moderate, build-time only, needs `postcss >= 8.5.23` from the ADR 0008 matrix). Not suppressed, because it has no owner-and-deadline exception |
| `pnpm security:containers` | Not run | The pinned Trivy image is not present locally and pulling it was outside this session's scope; a skipped run is not a pass. Follow-up recorded below |
| Browser check that the CSP does not break the app | Not run | `pnpm build` proves `next.config.js headers()` loads and `security-headers.test.ts` proves both header sets; a runtime CSP violation is only visible in a browser console and no Playwright journey exists (see limitations) |

## Known Limitations and Follow-up Work

- **E1 — the web CSP allows `script-src 'unsafe-inline'`.** Next 16's App Router emits inline
  flight scripts with no nonce seam. An XSS that reaches the DOM is therefore not stopped by the
  CSP alone; React's escaping and the absence of `dangerouslySetInnerHTML` are what carry that
  risk today. Owner Ankur Patel, deadline **Part 82**.
- **E2 — the general rate-limit store is in-memory and per process**, so those limits are per
  replica. The Part 74 lockout is in Redis and is not affected. Owner Ankur Patel, deadline
  **Part 80**.
- **E3 — `GHSA-36xv-jgw5-4q75` is suppressed**, now in `pnpm.auditConfig.ignoreGhsas`. Part 21
  records the reason: the vulnerable `SseStream` class does not exist in `@nestjs/core@10.4.22`
  and arrived in v11, so the advisory is a semver false positive. **The suppression is unbounded
  by version** — if `@nestjs/core` is ever bumped to v11 the advisory becomes real and would
  still be hidden. Nothing enforces the re-check. Owner Ankur Patel, deadline: next dependency
  refresh.

  **Corrected in review round 1:** the suppression as originally shipped did not work, and
  neither did the audit gate. `pnpm audit --ignore <id>` in pnpm 10.34.5 is not a filter — it
  switches `audit` into write-the-ignore-list mode, prints `No new vulnerabilities were ignored`
  and **always exits 0**, so `security:deps` had been passing unconditionally while four high
  advisories stood in the tree. `auditConfig.ignoreCves` matched nothing either, because it
  matches CVE identifiers and the entries were GHSA ones. The flag is gone from both
  `audit:prod` and `security:deps`, suppression moved to `ignoreGhsas`, and the four real
  advisories were triaged as **E6** (`pdfjs-dist`, high, arbitrary JS on a malicious PDF) and
  **E7** (`brace-expansion` ×2 and `nanoid`, transitive/dev-only). The advisory itself is **not**
  obsolete: `pnpm audit --prod` still reports it against `@nestjs/core@10.4.22` at **moderate**
  severity, below `security:deps`'s `--audit-level=high` threshold.
- **E6 — `pdfjs-dist` GHSA-hq66-cqwq-w95j (high).** Installed `5.6.205`; patched in `>=6.2.108`,
  a major bump that belongs to the ADR 0008 dependency-matrix refresh rather than a security
  part. Mitigated by the viewer only ever rendering PDFs streamed from Notted's own private
  object storage to an authenticated member of the owning workspace. Owner Ankur Patel,
  deadline: next dependency-matrix refresh.
- **E7 — transitive `brace-expansion` (×2) and `nanoid` denial-of-service advisories.** Reached
  only through `@bull-board/express > ejs > jake > filelist > minimatch` (operator-only console)
  and `better-auth > vitest > vite > postcss` (a test dependency the API never loads). Owner
  Ankur Patel, deadline: next dependency-matrix refresh.
- **One moderate advisory is deliberately NOT suppressed.** `postcss` GHSA-fxqj-rqcc-2cmp is
  build-time only and fixed in `postcss >= 8.5.23`, which is an `overrides` / ADR 0008 change.
  `pnpm audit:prod` therefore exits non-zero today, on purpose; `pnpm security:deps` (high and
  above) is clean.
- **E4 — container scanning covers development images only**, because production images do not
  exist yet. Owner Ankur Patel, deadline **Part 79**.
- **E5 — sessions are per host.** Cookies are host-only and `Lax`, so a Part 73 custom domain
  requires its own sign-in and no cross-registrable-domain cookie is issued. Owner Ankur Patel,
  deadline **Part 82**.
- **Session-token rotation on sign-in was not independently verified.** What the repo shows was
  checked — the cookie is the sole session carrier, no session id is read from query, body or a
  custom header, and `cookieCache` is disabled so every request revalidates against the store —
  but rotation itself is Better Auth's internal behaviour and its source was not read. The e2e
  test asserts the observable property (two sign-ins yield different cookies).
- **No Playwright journey asserts the response headers.** The CSP is covered by unit tests over
  the pure builder and by `pnpm build`; nothing yet loads a real page and fails on a console CSP
  violation. That is the follow-up most likely to catch a regression here.
- **Rate-limit and lockout behaviour has no integration test against real Redis.** The unit suite
  uses a fake with the same semantics; the e2e suite exercises the real path but is
  `AUTH_E2E`-gated and therefore skipped in the default run.
- **A 421 from `TrustedHostMiddleware` used to carry no security headers.** Fixed in review
  round 1 by mounting helmet ahead of the trusted-host check in `main.ts` — helmet reads nothing
  host-derived, so ordering it first costs nothing and every refusal now carries the headers.
  `TrustedHostMiddleware` still runs before CORS and Better Auth.
- **`imagesFromCompose` is a regex, not a YAML parser.** Marked with a `ponytail:` comment naming
  the ceiling. It is correct for compose.yaml's current flat `image:` declarations, anchors and
  aliases.

## Handoff Notes

- **Read `docs/security/remediation-checklist.md` before changing anything in this area.** It is
  the record of what was reviewed and found sufficient; re-implementing a Verified control is
  wasted work, and weakening one silently invalidates the review.
- **`AuthService.assertTrustedMutationOrigin` is now called from two places** — the manual call
  sites and `CsrfOriginMiddleware`. Do not "simplify" by deleting the manual calls: the middleware
  is the safety net, not the replacement.
- **Never register a second `hooks.after`** on Better Auth 1.6.24 — the option is a single
  middleware and a second assignment silently replaces the first, which would drop the
  non-remembered rotation cookie. Add to `afterHook` instead.
- **`x-notted-client-ip` is internal.** It is overwritten unconditionally in `main.ts`; do not
  read it from anywhere that runs before that middleware, and do not add it to any allow-list of
  client-supplied headers.
- **If the auth limits ever need to differ per IP and per identifier**, split
  `authRateLimitPerMinute` into two values rather than raising the shared one — the current single
  knob is a deliberate simplification, not an oversight.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-25 | Claude Code session | Initial record — implementation complete, quality gates deferred to the session reviewer |
| 2026-08-25 | Claude Code session | Review round 1 fixes. **H1:** `pnpm audit --ignore` and `auditConfig.ignoreCves` were both no-ops — `security:deps` had been exiting 0 unconditionally while four high advisories stood; the flag is dropped from `audit:prod` and `security:deps`, suppression moved to `auditConfig.ignoreGhsas`, and the four advisories triaged as E6/E7 in `docs/security/remediation-checklist.md` (E3 corrected rather than retired — it is still in the tree at moderate). **H2:** `eslint.config.mjs` now applies the node-globals block to `apps/*/security-headers.js`, which fixes the two `no-undef` errors; the eight `import-x/order` errors were autofixed. **H3:** `pnpm format`. **H4:** four `let context … = null` narrowing errors in `request-context.middleware.test.ts` moved to the array-capture pattern already used in the same file; `auth-lockout.service.test.ts` destructured an index signature under `noUncheckedIndexedAccess`; `structured-logger.service.test.ts` passed nested `err`/`res` objects that `LogMetadata` deliberately forbids (scalars only, so a caller cannot dump an object into a log line) — the narrow type is kept as the guardrail it is and the test casts, with the service now saying in one line that those redaction paths defend untyped call sites. **M3:** the two Mailpit-reading `auth.e2e.test.ts` cases poll for up to 10 s but `vitest.config.ts` raises only `hookTimeout`, so both now state a 30 s per-test timeout. **M4:** helmet mounts before `TrustedHostMiddleware`, so a 421 carries security headers. **L7:** no `AUTH_E2E=1` mention existed to correct — every reference already reads `AUTH_E2E=true`. |
| 2026-08-25 | Claude Code session | Review round 2 and final gates. **M-1:** `test/auth.e2e.test.ts` matched its marker against the message body, but every marker is a *subject* (`auth-action.tsx`), which the templates never repeat in the body — so the pre-existing first case and Part 74's new session-fixation case could never pass; `readMailpitLink` now selects the message by `Subject` from the Mailpit search summary, and the suite passes `3 / 3` in the dev `api` container. **L-1:** the `415` code change from round 1 (`UNSUPPORTED_MEDIA_TYPE`) is now listed in `docs/API.md` → Breaking changes in `v1`. **L-3:** `docs/security/remediation-checklist.md` revision history now records the round-1 rewrite. Final serial gates all pass; `pnpm security:deps` exit 0, `pnpm audit:prod` exit 1 on `postcss` only (deliberate) — table updated. Status moved to Complete. |
