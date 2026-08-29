# Remediation Checklist — OWASP Top 10 (2021)

**Review date:** 2026-08-25 · **Reviewer:** Ankur Patel · **Plan reference:** `Plan.md`, Part 74

This is a **manual, OWASP-oriented review of the Notted codebase**, not an automated scan
report. Every row below was reached by reading the control in the tree and naming the file that
carries it; nothing here is inferred from a tool's output. The two automated scans that exist
are separate and on demand:

```bash
pnpm security:check        # = security:deps + security:containers
pnpm security:deps         # pnpm audit, production dependencies, high and above
pnpm security:containers   # Trivy through Docker against the images named in compose.yaml
```

`security:containers` runs `scripts/security-scan.mjs`, which needs Docker running. Neither
scan is wired into `pnpm lint` / `pnpm test` / `pnpm build`; they are deliberately on demand,
because both reach the network and one pulls a scanner image.

**Status vocabulary — exactly one per row:**

| Status                 | Meaning                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- |
| **Verified**           | The control already existed and was read and reviewed during this pass.          |
| **Fixed in Part 74**   | This part added the control, or tightened one that was too loose.                |
| **Exception**          | Accepted risk. Carries an owner and a deadline expressed as the plan part that closes it. |

The companion [threat model](threat-model.md) holds the assets, actors, trust boundaries, and
the per-surface STRIDE analysis this checklist is the remediation half of.

## Part 74 review list — where each item is answered

`Plan.md` names thirteen items for review. Each is covered by at least one row below.

| Item                | Rows                                                            |
| ------------------- | --------------------------------------------------------------- |
| CSRF                | [A01](#a01--broken-access-control) · [A05](#a05--security-misconfiguration) |
| XSS                 | [A03](#a03--injection) · [A05](#a05--security-misconfiguration)  |
| SSRF                | [A10](#a10--server-side-request-forgery-ssrf)                    |
| SQL injection       | [A03](#a03--injection)                                           |
| Path traversal      | [A01](#a01--broken-access-control) · [A03](#a03--injection)      |
| Upload bombs        | [A04](#a04--insecure-design)                                     |
| Websocket abuse     | [A01](#a01--broken-access-control) · [A04](#a04--insecure-design) |
| Brute force         | [A07](#a07--identification-and-authentication-failures)          |
| Session fixation    | [A07](#a07--identification-and-authentication-failures)          |
| Open redirects      | [A01](#a01--broken-access-control)                               |
| CSP                 | [A05](#a05--security-misconfiguration)                           |
| CORS                | [A05](#a05--security-misconfiguration)                           |
| Secret handling     | [A02](#a02--cryptographic-failures) · [A09](#a09--security-logging-and-monitoring-failures) |

## A01 — Broken access control

| Finding                                                                                  | Status               | Control and file(s)                                                                                                                          |
| ---------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| One authorization engine, not a matrix copied per module                                 | Verified             | `apps/api/src/authorization/authorization-policy.service.ts`, `apps/api/src/authorization/authorization-entry.service.ts`                       |
| A workspace UUID is a selector, never authority                                          | Verified             | Membership bootstrap then `TenantContextService.run`: `apps/api/src/authorization/authorization-entry.service.ts`, `apps/api/src/tenant/tenant-context.service.ts` |
| Every tenant-owned query is workspace-scoped or fails loudly                              | Verified             | `apps/api/src/tenant/workspace-scope.ts`; `get()` throws when no context is active                                                             |
| Cross-tenant existence is concealed rather than reported                                  | Verified             | `404` for cross-tenant/guessed ids, `403` for known same-tenant denial, `401` unauthenticated: `apps/api/src/authorization/authorization.errors.ts` |
| A route with no authorization specification is denied for API-key callers                 | Verified             | `apps/api/src/api-keys/api-key-route.guard.ts` (default-deny)                                                                                   |
| REST and tRPC reuse the same policy rather than re-implementing it                        | Verified             | `apps/api/src/authorization/authorization-adapters.service.ts`; ADR 0002                                                                        |
| Socket joins and permission-sensitive messages re-authorize per event                     | Verified             | `authorizeSocketJoin` / `authorizeSocketMessage` in `apps/api/src/realtime/realtime.gateway.ts`                                                  |
| Jobs re-check membership at run time; system jobs have finite action/kind lists            | Verified             | `apps/api/src/authorization/authorization-adapters.service.ts`                                                                                  |
| File downloads authorize against the database, never against the object key                | Verified             | `apps/api/src/attachments/attachments.controller.ts`, `apps/api/src/attachments/attachments.service.ts`                                          |
| Path traversal through an uploaded filename                                                | Verified             | The raw name never becomes an object key; keys are derived server-side: `apps/api/src/attachments/attachment-storage-key.ts`, `apps/api/src/attachments/filename.ts` |
| Open redirect on the authentication return path                                            | Verified             | `safeRedirectPath` accepts only an app-local absolute path, rejects `//`, `\`, `%`, control characters and auth paths: `apps/web/src/lib/auth/redirects.ts`, `apps/web/src/lib/auth/callbacks.ts` |
| Cross-site forged mutation on the versioned API                                            | **Fixed in Part 74** | Global default-deny `Origin` middleware for mutating, cookie-authenticated, non-API-key requests on `/api/v1`, layered over the existing per-service calls: `apps/api/src/auth/csrf-origin.middleware.ts`, mounted in `apps/api/src/main.ts` |
| Cross-site forged sign-in / sign-out / credential change                                   | **Fixed in Part 74** | Trusted-`Origin` requirement on every state-changing method at the Better Auth base path: `apps/api/src/main.ts`                                 |
| Arriving on a verified custom hostname is not authorization                                | Verified             | Stated and enforced: the proxy only decides *which shell renders*, the API re-authorizes every request: `apps/web/src/proxy.ts`                   |

## A02 — Cryptographic failures

| Finding                                                              | Status               | Control and file(s)                                                                                                        |
| -------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Passwords are never handled by application code                      | Verified             | Better Auth owns credential storage and verification (ADR 0003): `apps/api/src/auth/better-auth.setup.ts`                     |
| API keys are stored as a peppered HMAC-SHA-256, never in plaintext   | Verified             | `apps/api/src/api-keys/api-key-secret.ts`, looked up by hash in `apps/api/src/api-keys/api-key-auth.service.ts`               |
| Webhook secrets are encrypted at rest with a key version and an AAD  | Verified             | `apps/api/src/webhooks/webhook-secret.service.ts`; `encryptedSecret` is absent from the DTO by construction (`apps/api/src/webhooks/webhooks.service.ts`) |
| AI provider credentials are encrypted at rest, with lazy key migration | Verified            | `apps/api/src/ai/ai-credential.service.ts`, `apps/api/src/ai/ai-governance.service.ts`                                       |
| Authentication email payloads are encrypted on the queue             | Verified             | `apps/api/src/auth/auth-email-encryption.service.ts`                                                                          |
| Secret comparisons are constant-time                                  | Verified             | `timingSafeEqual` for the logo token (`apps/api/src/workspaces/workspace-logo.service.ts`) and for webhook signatures (`apps/api/src/webhooks/webhook-signature.ts`) |
| Unguessable public identifiers use CSPRNG material                    | Verified             | 128-bit logo token (`apps/api/src/workspaces/workspace-logo.service.ts`); 32-byte webhook secret (`apps/api/src/webhooks/webhooks.service.ts`) |
| Object storage is private; no bearer URL is handed out                | Verified             | Attachment and export downloads are proxied and authorized per request rather than presigned: `apps/api/src/attachments/attachments.controller.ts`, `apps/api/src/export/export.controller.ts` (ADR 0005) |
| Transport security is asserted to the browser                        | **Fixed in Part 74** | HSTS (1 year, `includeSubDomains`) in production only, on both the API (`apps/api/src/main.ts`) and the web app (`apps/web/security-headers.js`); `upgrade-insecure-requests` in the production web CSP |
| Sensitive identifiers are hashed before they are stored or logged     | **Fixed in Part 74** | Authentication identifiers are SHA-256 hashed before becoming a Redis key or a log field: `apps/api/src/auth/auth-lockout.service.ts` |
| Realtime rate-limit and lease keys do not embed actor identifiers     | Verified             | HMAC digests keyed with the auth secret: `apps/api/src/realtime/realtime-rate-limit.service.ts`                               |

## A03 — Injection

| Finding                                                                 | Status               | Control and file(s)                                                                                                          |
| ----------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| SQL injection                                                           | Verified             | Every query is a parameterised Drizzle builder; there is **no `sql.raw` anywhere in `apps/api/src`**, and identifiers are never string-interpolated into SQL |
| Unmodelled input reaching a service                                     | Verified             | Global `ValidationPipe` with `whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues` (`apps/api/src/main.ts`) plus shared Zod contracts in `packages/shared-validators/` |
| Realtime event payloads                                                 | Verified             | Every event is parsed by a Zod contract before it reaches a handler: `apps/api/src/realtime/realtime.contracts.ts`             |
| Stored XSS through an uploaded SVG                                      | Verified             | Rasterize, do not sanitize-and-serve: no download route can emit `image/svg+xml`: `apps/api/src/attachments/svg-safety.ts`, `apps/api/src/attachments/image-processing.service.ts` (ADR 0005) |
| Stored XSS through a mistyped upload                                    | Verified             | Type is derived from magic bytes and the download extension is forced to the canonical one; text uploads are stored as `text/plain`: `apps/api/src/attachments/attachment-admission.ts`, `apps/api/src/attachments/filename.ts`, `apps/api/src/attachments/text-safety.ts` |
| Content sniffing turning a download into a document                     | Verified             | `X-Content-Type-Options: nosniff` and an explicit `Content-Disposition` on every download: `apps/api/src/attachments/attachments.controller.ts`, `apps/api/src/export/export.controller.ts`, `apps/api/src/workspaces/workspace-logo.controller.ts` |
| Reflected XSS in the web app                                            | Verified             | React escapes by default; the editor persists TipTap JSON rather than HTML, and no route renders unsanitised user HTML         |
| XSS blast radius if a sink is ever introduced                           | **Fixed in Part 74** | Full web CSP (`default-src 'self'`, `object-src 'none'`, `frame-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`) plus `X-Frame-Options: DENY`: `apps/web/security-headers.js` via `apps/web/next.config.js`. See **E1** for the `script-src` caveat |
| The API being made to execute anything in a browser                     | **Fixed in Part 74** | Explicit API CSP `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`: `apps/api/src/main.ts`      |
| XML entity expansion / XXE via an uploaded SVG                          | Verified             | Entity declarations and external references are refused before librsvg parses the bytes: `apps/api/src/attachments/svg-safety.ts` |
| Regular-expression denial of service in the upload prescan              | Verified             | Every pattern is linear (no nested quantifier, alternation-in-repetition, or backreference) and a test asserts a wall-clock budget: `apps/api/src/attachments/svg-safety.ts` |
| Log injection through a crafted field                                   | Verified             | Structured logging with a fixed metadata shape and a redaction list; messages are coerced through `safeMessage`: `apps/api/src/common/logging/structured-logger.service.ts` |

## A04 — Insecure design

| Finding                                                             | Status               | Control and file(s)                                                                                                          |
| ------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Upload bomb — oversized source, lying `Content-Length`              | Verified             | The multipart parser enforces the ceiling **during** transfer: `apps/api/src/attachments/multipart-upload.parser.ts`; `MAX_ATTACHMENT_UPLOAD_BYTES` / `MAX_IMAGE_UPLOAD_BYTES` in `packages/shared-validators/src/attachment.schema.ts` |
| Upload bomb — decompression (pixel canvas, animation frames)        | Verified             | `MAX_IMAGE_PIXELS` through Sharp's `limitInputPixels` and `MAX_IMAGE_ANIMATION_FRAMES`: `apps/api/src/config/image-processing.config.ts`, `apps/api/src/attachments/image-processing.service.ts` |
| Export bomb — unbounded attachment bytes pulled into an archive     | Verified             | `readObject` stops at `maxBytes` rather than buffering and measuring after: `apps/api/src/export/note-export-source.service.ts` |
| Storage exhaustion by a single workspace                            | Verified             | Per-workspace quota reserved inside the write transaction, plus the abandoned-upload and orphan sweeps: `apps/api/src/storage/storage-quota.service.ts`, `apps/api/src/maintenance/storage-maintenance.service.ts` |
| Websocket abuse — connection flooding                               | Verified             | A bounded, TTL'd socket lease per actor: `apps/api/src/realtime/realtime-rate-limit.service.ts`                                |
| Websocket abuse — join/update/awareness floods                      | Verified             | Seven disjoint per-tier Redis counters: `apps/api/src/realtime/realtime-rate-limit.service.ts`                                 |
| Websocket abuse — oversized frames                                  | Verified             | `maxHttpBufferSize` and `pingTimeout` on the adapter: `apps/api/src/realtime/realtime-socket.adapter.ts`                       |
| Retryable mutations applied twice                                   | Verified             | `Idempotency-Key` handling: `apps/api/src/common/idempotency/api-idempotency.ts`                                               |
| A job acting for a transaction that rolled back                     | Verified             | Jobs and events dispatch only after commit (ADR 0006)                                                                          |
| Unbounded outbound provider calls                                   | Verified             | AI streaming runs under an `AbortSignal` with a bounded output budget: `apps/api/src/ai/providers/sse-stream.ts`, `apps/api/src/ai/providers/ai-chat-provider.ts` |
| Custom CSS as a branding feature                                    | Verified             | Deliberately **not shipped** — no schema field, no API, no UI. ADR 0014 records the threats and the prerequisites             |
| Rate limits are tiered rather than uniform                          | Verified             | Disjoint IP / user / API-key buckets plus a `:sensitive` sub-bucket: `apps/api/src/common/rate-limit/rate-limit.service.ts`     |
| The authentication path shared the generic sensitive tier           | **Fixed in Part 74** | A dedicated `RATE_LIMIT_AUTH_PER_MINUTE` tier (default 5) with its own `:auth` bucket, so draining it cannot consume a caller's allowance for sensitive application routes: `apps/api/src/auth/auth-rate-limit.middleware.ts` |

## A05 — Security misconfiguration

| Finding                                                                  | Status               | Control and file(s)                                                                                                          |
| ------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| API security headers were helmet's defaults, tuned for HTML              | **Fixed in Part 74** | Explicit helmet config: CSP `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, CORP `same-origin`, `Referrer-Policy: no-referrer`, HSTS production-only: `apps/api/src/main.ts` |
| The web app sent no security response headers                            | **Fixed in Part 74** | Full CSP, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `X-Frame-Options: DENY`, HSTS in production: `apps/web/security-headers.js`, wired through `apps/web/next.config.js` |
| CORS reflecting arbitrary origins                                        | Verified             | An allow-list callback over the configured origins plus verified custom hosts; `credentials: true` with an explicit method, request-header and exposed-header list: `apps/api/src/main.ts`, `apps/api/src/common/verified-hosts.service.ts` |
| Trusting inbound `X-Forwarded-*`                                          | **Fixed in Part 74** | `trust proxy` is driven by `TRUST_PROXY_HOPS`, and Better Auth's IP resolution is pinned to a single private `x-notted-client-ip` header that `main.ts` overwrites unconditionally from `request.ip`: `apps/api/src/main.ts` |
| An unrecognised `Host` reaching route code                                | Verified             | The trusted-host middleware answers `421` before helmet, CORS, Better Auth or any route sees the host: `apps/api/src/domains/trusted-host.middleware.ts` |
| The queue console exposed on the API origin                               | Verified             | Operator authentication for every document, asset and API request; a closed operation allow-list (`404` otherwise); trusted `Origin` and a committed audit row for mutations; its own tighter CSP; `no-store`, `no-referrer`, `noindex`: `apps/api/src/queue/bull-board-policy.ts`, `apps/api/src/auth/platform-operator.service.ts`, `apps/api/src/main.ts` |
| Environment configuration accepting unsafe production values              | Verified             | Config modules validate and refuse at boot; `WEBHOOK_ALLOW_INSECURE_URLS` is forced to `false` when `NODE_ENV=production` regardless of what is set: `apps/api/src/config/security.config.ts`, documented in `docs/environment.md` |
| Web CSP requires `script-src 'unsafe-inline'`                             | **Exception (E1)**   | `apps/web/security-headers.js` — see [Exceptions](#exceptions)                                                                 |
| Container images are scanned for development only                         | **Exception (E4)**   | `scripts/security-scan.mjs` — see [Exceptions](#exceptions)                                                                    |

## A06 — Vulnerable and outdated components

| Finding                                                       | Status               | Control and file(s)                                                                                              |
| ------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| The dependency matrix is pinned and compatibility-tested       | Verified             | ADR 0008 is the authority for exact versions; `pnpm.overrides` in `package.json` pins the transitive fixes             |
| Known advisories in production dependencies                    | **Fixed in Part 74** | `pnpm security:deps` = `pnpm audit --prod --audit-level=high`: `package.json`                                          |
| Container image vulnerabilities                                | **Fixed in Part 74** | `pnpm security:containers` runs Trivy through Docker against the images named in `compose.yaml`: `scripts/security-scan.mjs` |
| Native build scripts run for arbitrary packages                | Verified             | `pnpm.onlyBuiltDependencies` limits post-install builds to `esbuild` and `sharp`: `package.json`                       |
| One advisory is suppressed rather than resolved                | **Exception (E3)**   | `GHSA-36xv-jgw5-4q75` — see [Exceptions](#exceptions)                                                                  |
| `pdfjs-dist` arbitrary JavaScript execution on a malicious PDF | **Exception (E6)**   | `GHSA-hq66-cqwq-w95j` — see [Exceptions](#exceptions)                                                                  |
| Transitive `brace-expansion` and `nanoid` denial of service    | **Exception (E7)**   | `GHSA-mh99-v99m-4gvg`, `GHSA-rgw5-rvv9-x895`, `GHSA-2v37-7h3g-55p8` — see [Exceptions](#exceptions)                     |
| `postcss` source-map path traversal (moderate, unsuppressed)   | Verified             | `GHSA-fxqj-rqcc-2cmp`. **Not** suppressed: `pnpm audit:prod` reports it and exits non-zero, deliberately. It is build-time only (`next>postcss`, `better-auth>vitest>vite>postcss`); no Notted code runs PostCSS over attacker-supplied CSS. The fix is `postcss >= 8.5.23`, which is a `pnpm.overrides` / ADR 0008 matrix change, not a Part 71–74 change |

## A07 — Identification and authentication failures

| Finding                                                                | Status               | Control and file(s)                                                                                                          |
| ---------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Brute force — per-IP flooding of the sign-in path                      | **Fixed in Part 74** | A dedicated per-IP `:auth` token bucket on the Better Auth base path, `RATE_LIMIT_AUTH_PER_MINUTE` (default 5), with `RateLimit-*` and `Retry-After` headers: `apps/api/src/auth/auth-rate-limit.middleware.ts` |
| Brute force — distributed guessing that rotates source addresses       | **Fixed in Part 74** | A per-identifier 60 s budget and account lockout (`AUTH_LOCKOUT_ATTEMPTS`, default 10, within `AUTH_LOCKOUT_SECONDS`, default 900) held in Redis with an atomic `INCR` + `PEXPIRE`, so a replica cannot be used to reset the count: `apps/api/src/auth/auth-lockout.service.ts` |
| Lockout turning into an account-enumeration oracle                     | **Fixed in Part 74** | One identical refusal message and shape for known and unknown identifiers; `429` for the budget and `423` for the lock, both with `Retry-After`: `apps/api/src/auth/auth-lockout.service.ts` |
| Lockout costing a password hash per attempt                            | **Fixed in Part 74** | `assertNotLocked` refuses before any password is verified: `apps/api/src/auth/auth-lockout.service.ts`                          |
| Per-IP limits defeated by a forged `X-Forwarded-For`                   | **Fixed in Part 74** | Better Auth reads only `x-notted-client-ip`, which `main.ts` overwrites unconditionally from Express's `request.ip`: `apps/api/src/main.ts`, `apps/api/src/auth/better-auth.setup.ts` |
| Session fixation — adopting an attacker-supplied identifier            | Verified             | The session cookie set by the provider is the only carrier: no session id is read from a query string, body, or custom header, and the sign-in flow is entirely provider-owned. `cookieCache` is disabled, so every request revalidates against the server-side session store rather than trusting a self-contained cookie: `apps/api/src/auth/better-auth.setup.ts`, `apps/api/src/auth/auth.service.ts`. *Token rotation on sign-in is Better Auth's own behaviour and was not read in the provider's source during this pass.* |
| Session cookie attributes                                              | Verified             | `httpOnly`, `sameSite: "lax"`, `secure` in production, and no `domain` attribute anywhere — every cookie is host-only: `apps/api/src/auth/better-auth.setup.ts`, and the same for the workspace-selection cookie in `apps/web/src/proxy.ts` |
| Re-authentication for high-impact actions                              | Verified             | Freshness required for billing, workspace deletion, membership privilege changes, API-key secret lifecycle, webhook configuration and session revocation: `apps/api/src/auth/auth.service.ts`, `apps/api/src/authorization/authorization-policy.service.ts` |
| Session revocation is authoritative and self-scoped                    | Verified             | Session ids stay selectors; a user can act only on their own server-resolved sessions: `apps/api/src/auth/auth-security.service.ts`                    |
| Second factors and passkeys                                            | Verified             | Two-factor and WebAuthn are provider-owned and challenge-bound: `apps/api/src/auth/better-auth.setup.ts`                       |
| Sessions do not span hostnames                                         | **Exception (E5)**   | See [Exceptions](#exceptions)                                                                                                  |

## A08 — Software and data integrity failures

| Finding                                                       | Status               | Control and file(s)                                                                                                    |
| ------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Outbound deliveries are verifiable by the receiver            | Verified             | HMAC-SHA-256 over `t=<unix seconds>` plus the exact serialised body, as `x-notted-signature`: `apps/api/src/webhooks/webhook-signature.ts` |
| Signature verification leaking through timing                 | Verified             | Constant-time comparison rather than string equality: `apps/api/src/webhooks/webhook-signature.ts`                          |
| The audit trail can be rewritten                              | Verified             | Append-only enforced **in the database** by the `audit_logs_append_only` trigger; UPDATE and DELETE raise `insufficient_privilege`, with two narrow, named exemptions: `apps/api/src/database/schema/audit-logs.ts`, migration `0021_audit_logs_append_only.sql` |
| A job payload asserting authority                             | Verified             | Payloads persist identifiers only and are re-authorized at run time: `apps/api/src/authorization/authorization-adapters.service.ts` |
| Cross-workspace foreign-key combinations                      | Verified             | Composite cross-tenant FKs reject the write at the database layer; see [`docs/tenant-and-retention.md`](../tenant-and-retention.md) §1.4 |
| Migrations applied ad hoc                                     | Verified             | Reviewed, generated migrations only; deployed migrations are never edited: [`docs/database-migrations.md`](../database-migrations.md) |
| Dependency integrity                                          | Verified             | `pnpm-lock.yaml` is committed and `pnpm.overrides` pins the transitive versions the audit requires: `package.json`           |

## A09 — Security logging and monitoring failures

| Finding                                                                 | Status               | Control and file(s)                                                                                                    |
| ----------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Security-relevant actions are recorded                                  | Verified             | `recordAudit` is the only sanctioned writer, and it commits in the same transaction as the mutation: `apps/api/src/audit/audit-record.ts` |
| Audit metadata carrying content, credentials, or signed URLs            | Verified             | The service redacts before insert; the schema documents the prohibition the jsonb column cannot enforce: `apps/api/src/database/schema/audit-logs.ts` |
| Requests are correlatable, including refusals                           | Verified             | A request id is assigned first and echoed on every response and every refusal envelope: `apps/api/src/common/request/request-context.middleware.ts` |
| Log redaction covered only the obvious fields                           | **Fixed in Part 74** | Extended to API keys, signatures, cookies (including `set-cookie`), private keys, webhook secrets, connection strings, and whole error/response header objects: `apps/api/src/common/logging/structured-logger.service.ts` |
| A lockout event identifying the account it locked                       | **Fixed in Part 74** | The warning carries the SHA-256 identifier hash and the failure count, and names nobody: `apps/api/src/auth/auth-lockout.service.ts` |
| A blocked webhook URL reaching the logger with its embedded token       | Verified             | The block is a stable error code that never quotes the URL: `apps/api/src/webhooks/webhook-url-guard.ts` (`WEBHOOK_BLOCKED_ERROR_CODE`) |
| Operational retries are attributable                                    | Verified             | A Bull Board mutation commits an audit row before it touches Redis: `apps/api/src/queue/queue-admin-remediation.service.ts`   |
| Alerting on the signals above                                           | **Deferred, not an exception** | Monitoring and alerting are Part 78's scope; this part produces the signals, not the alerts                     |

## A10 — Server-side request forgery (SSRF)

| Finding                                                                     | Status   | Control and file(s)                                                                                            |
| --------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| Admin-supplied webhook URLs reaching internal network addresses             | Verified | Six layers, each with its own test: scheme allow-list, no embedded credentials, hostname deny-list, address deny-list, pre-flight DNS, connect-time re-check: `apps/api/src/webhooks/webhook-url-guard.ts` |
| Cloud metadata (`169.254.169.254`, `metadata.google.internal`)              | Verified | Blocked by both the hostname deny-list and the link-local range, and the range stays blocked even with the development insecure-URL flag on: `apps/api/src/webhooks/webhook-url-guard.ts` |
| DNS rebinding between validation and connect                                | Verified | L6 re-runs the address filter on the answer the socket is about to dial: `apps/api/src/webhooks/webhook-url-guard.ts` |
| Split round-robin records mixing a public and a private answer              | Verified | Rejects when **any** returned address is blocked, and an empty answer is a rejection too: `apps/api/src/webhooks/webhook-url-guard.ts` |
| IPv6-costume bypasses (`::ffff:`, v4-compatible, NAT64, zone ids, brackets) | Verified | Mapped and v4-compatible forms are unmapped and re-checked against the v4 lists; anything unparseable is blocked: `apps/api/src/webhooks/webhook-url-guard.ts` |
| A webhook endpoint targeting our own API                                    | Verified | `APP_URL` / `API_URL` hostnames are in the deny-list: `apps/api/src/webhooks/webhook-url-guard.ts`                    |
| SSRF or local-file read through an uploaded SVG                             | Verified | External references and `<foreignObject>` are refused before the renderer sees the bytes: `apps/api/src/attachments/svg-safety.ts` |
| Server-side fetch from the web app's host resolution                        | Verified | `proxy.ts` calls only `NEXT_PUBLIC_API_URL` — never the tenant's edge — with a 3 s abort and no credentials: `apps/web/src/proxy.ts` |
| Outbound AI provider calls                                                  | Verified | The endpoints are module-level constants (`https://api.openai.com/…`, `https://api.anthropic.com/…`); no request or stored configuration contributes to the outbound URL, and every call runs under an `AbortSignal`: `apps/api/src/ai/providers/openai-chat.provider.ts`, `apps/api/src/ai/providers/anthropic-chat.provider.ts`, `apps/api/src/ai/providers/sse-stream.ts` |
| DNS verification for custom domains                                         | Verified | Resolution is bounded at 5 s and the resolver is injected; the apex fallback's reliance on the host resolver is documented in the Part 73 record: `apps/api/src/domains/domain-verifier.ts` |

## Exceptions

All seven are owned by **Ankur Patel**. Each deadline is the plan part that closes it, or a
named review point where no part closes it.

Suppression mechanism: advisories that are accepted here — and only those — are listed in
`pnpm.auditConfig.ignoreGhsas` in `package.json`. **Not** `ignoreCves`, and **not** the
`--ignore` CLI flag; both were previously used and both were silently ineffective:

- `pnpm audit --ignore <id>` is not a filter. In pnpm 10.34.5 it switches `audit` into
  *write-the-ignore-list* mode, which prints `No new vulnerabilities were ignored` and **always
  exits 0**. `security:deps` therefore passed unconditionally and was masking four high
  advisories. The flag is gone from `audit:prod` and `security:deps`.
- `pnpm.auditConfig.ignoreCves` matches an advisory's **CVE** identifiers. The entries there
  were GHSA identifiers, so they matched nothing. GHSA identifiers belong in `ignoreGhsas`.

### E1 — The web CSP requires `script-src 'unsafe-inline'`

- **Owner:** Ankur Patel · **Deadline:** **Part 82**
- **Where:** `apps/web/security-headers.js`
- **Why:** Next 16's App Router emits inline flight and bootstrap scripts, and there is no nonce
  seam available without a proxy rewrite that stamps a per-response nonce onto them. Adding
  `'unsafe-inline'` to `script-src` is what makes the rest of the policy deployable at all.
- **Residual risk:** an injected inline `<script>` would execute. Everything around it still
  binds: `default-src 'self'`, `object-src 'none'`, `frame-src 'none'`, `base-uri 'self'`,
  `form-action 'self'`, `frame-ancestors 'none'`, and a `connect-src` restricted to the API and
  WebSocket origins, so exfiltration targets and framing are still constrained. `'unsafe-eval'`
  is development-only.
- **Closure:** Part 82 introduces the reverse proxy the nonce rewrite needs; the same part is
  where the CSP moves to a nonce-based `script-src`.

### E2 — The general API rate-limit store is in-memory and per process

- **Owner:** Ankur Patel · **Deadline:** **Part 80**
- **Where:** `apps/api/src/common/rate-limit/in-memory-rate-limit.store.ts`, consumed by
  `apps/api/src/common/rate-limit/rate-limit.service.ts`
- **Why:** the store is a bounded LRU token bucket in process memory. On a multi-replica
  deployment the effective limit is the configured limit **times the replica count**, and a
  caller who is refused by one replica may be admitted by the next.
- **Scope of the exception:** this covers the general, sensitive, and per-IP authentication
  buckets. It explicitly does **not** cover the Part 74 account lockout, which is held in Redis
  with an atomic `INCR` + `PEXPIRE` precisely so a lockout cannot be reset by landing on another
  replica (`apps/api/src/auth/auth-lockout.service.ts`), nor the realtime limits, which are also
  Redis-backed (`apps/api/src/realtime/realtime-rate-limit.service.ts`).
- **Closure:** Part 80 (production Compose and scaling) is where more than one API replica first
  exists, and is where the store moves to Redis.

### E3 — `GHSA-36xv-jgw5-4q75` is suppressed in `pnpm audit`

- **Owner:** Ankur Patel · **Deadline:** **Part 85** (define and validate the MVP release
  slice), and necessarily at the `@nestjs/core` v11 upgrade, whichever comes first
- **Where:** `package.json` — `pnpm.auditConfig.ignoreGhsas`. (Until Part 71–74 review round 1
  this was `ignoreCves` plus an `--ignore GHSA-36xv-jgw5-4q75` flag on `audit:prod` and
  `security:deps`; neither actually suppressed anything — see the mechanism note above.)
- **Still present:** yes. `pnpm audit --prod` reports it against `@nestjs/core@10.4.22` at
  **moderate** severity, so it is invisible to `security:deps` (`--audit-level=high`) but real.
  It is not obsolete and the entry stays.
- **Why (verified, not assumed):** the ignore was introduced in Part 21 and its reason is
  recorded in `docs/completed-parts/part-21-better-auth-backend.md`: the advisory is a semver
  false positive, because the vulnerable `SseStream` class does not exist in
  `@nestjs/core@10.4.22` and was introduced in v11. The same record shows the other five
  advisories from that pass were resolved with `pnpm.overrides` rather than suppressed.
- **Residual risk:** the suppression is by advisory id and is not scoped to a version range, so
  it would continue to hide the advisory after an upgrade to a `@nestjs/core` line that *does*
  ship `SseStream`. That is the specific thing the re-evaluation must check.

### E4 — Container scanning covers development images only

- **Owner:** Ankur Patel · **Deadline:** **Part 79**
- **Where:** `scripts/security-scan.mjs`, over the images named in `compose.yaml`
- **Why:** production images do not exist yet. `compose.yaml` describes the development and e2e
  stacks, so that is the entire set of images there is to scan.
- **Residual risk:** the images that will actually be deployed are unscanned, because they are
  unbuilt. Development images share most of their base layers, so the scan is a useful early
  signal, but it is not a production attestation.
- **Closure:** Part 79 builds the production images; the same part extends the scan target list
  to them and is where a non-zero-finding gate becomes meaningful.

### E5 — Sessions are per host

- **Owner:** Ankur Patel · **Deadline:** **Part 82**
- **Where:** `apps/api/src/auth/better-auth.setup.ts` (no `domain` attribute on any auth
  cookie), `apps/web/src/proxy.ts` (the workspace-selection cookie, same treatment)
- **Why:** every cookie is host-only and `Lax`. A cookie shared across a registrable domain is a
  cookie one tenant's hostname could influence for another's, so no cross-registrable-domain
  cookie is issued. The cost is that signing in on the primary application host does not sign
  the user in on `notes.acme.example`, and vice versa — a custom domain requires its own
  sign-in.
- **Related consequence:** OAuth, magic-link, and passkey sign-in always complete on the primary
  application host, because provider redirect URIs, magic-link URLs, and the WebAuthn relying-
  party identity are all bound to `APP_URL` / `BETTER_AUTH_URL`.
- **Classification:** this is accepted deliberately. It is an isolation property first and an
  ergonomics cost second, which is why it is an exception with a review date rather than a
  defect.
- **Closure:** Part 82 (reverse proxy and TLS) is where the per-host sign-in experience can be
  addressed properly, if it is addressed at all; the alternative outcome of that review is to
  promote this from an exception to a documented product decision.

### E6 — `pdfjs-dist` arbitrary JavaScript execution on a malicious PDF

- **Owner:** Ankur Patel · **Deadline:** **Part 85** (define and validate the MVP release
  slice), through the ADR 0008 matrix refresh
- **Advisory:** `GHSA-hq66-cqwq-w95j` / `CVE-2026-16633`, high. Vulnerable `>=5.6.83 <6.2.108`;
  installed `5.6.205` (`apps/web/package.json`). Patched in `>=6.2.108`.
- **Why not fixed here:** ADR 0008 is the authority for exact versions and the bump crosses a
  major (5.x → 6.x). Changing it inside a security-hardening part would ship an untested
  runtime change under a security label; it belongs to the matrix refresh that can test it.
- **Mitigation in place:** the viewer only ever renders PDFs that came from Notted's own private
  object storage, streamed to an **authenticated member of the owning workspace** after the
  usual attachment authorization. There is no path that hands the viewer a PDF from an
  arbitrary origin, and the browser sandbox plus the web CSP still bound what executing script
  could reach.
- **Residual risk:** a workspace member who uploads a crafted PDF could execute script in the
  viewing member's page context, within that same workspace's trust boundary.
- **Closure:** Part 85 (define and validate the MVP release slice) is the gate. Bump to
  `pdfjs-dist >= 6.2.108` through the ADR 0008 matrix refresh and delete this entry, or record
  an explicit decision to ship with it. A HIGH advisory must not reach production because a
  deadline named an event that was never scheduled — "the next matrix refresh" gave the release
  checklist nothing to trip on, which is why this is bound to a numbered part instead.

### E7 — Transitive `brace-expansion` and `nanoid` denial-of-service advisories

- **Owner:** Ankur Patel · **Deadline:** **Part 85** (define and validate the MVP release
  slice), through the ADR 0008 matrix refresh
- **Advisories:**
  - `GHSA-mh99-v99m-4gvg` and `GHSA-rgw5-rvv9-x895` (`brace-expansion`, high), reached only via
    `@bull-board/express > ejs > jake > filelist > minimatch > brace-expansion`. `jake` is
    `ejs`'s build-time task runner; the reachable surface is the operator-only Bull Board
    console, which already requires platform-operator authentication and a closed operation
    allow-list.
  - `GHSA-2v37-7h3g-55p8` (`nanoid`, high), reached only via
    `better-auth > vitest > vite > postcss > nanoid`. `vitest` is a **test** dependency that
    `better-auth` declares in a way `pnpm audit --prod` still walks; it is not loaded by the
    running API.
- **Why not fixed here:** each would need a `pnpm.overrides` pin on a package no Notted code
  imports directly, changing the resolved graph under three upstream packages. That is an
  ADR 0008 matrix decision, not a Part 71–74 change.
- **Residual risk:** a denial of service reachable only by an authenticated platform operator
  (Bull Board) or not reachable at runtime at all (`nanoid`).
- **Closure:** Part 85 is the gate. Drop each ignore as soon as the upstream chain resolves to
  a patched version on its own; anything still standing at Part 85 is re-triaged there rather
  than carried silently.

## Revision History

| Date       | Author      | Change                                                    |
| ---------- | ----------- | --------------------------------------------------------- |
| 2026-08-25 | Ankur Patel | Initial OWASP-oriented review and exception log, Part 74. |
| 2026-08-25 | Ankur Patel | Parts 71–74 review round 1: `pnpm audit --ignore` and `auditConfig.ignoreCves` were both no-ops, so `security:deps` had been passing unconditionally while four high advisories stood. Moved suppression to `auditConfig.ignoreGhsas`, triaged the four (E6 `pdfjs-dist`, E7 `brace-expansion` ×2 and `nanoid`), corrected E3 (still present at moderate, not obsolete), and left the `postcss` moderate deliberately unsuppressed. |
| 2026-08-25 | Ankur Patel | Parts 71–74 review round 2: no security findings; revision history brought in line with the round-1 rewrite (the `ignoreGhsas` note and exceptions E6/E7 were added in round 1). |
| 2026-08-29 | Ankur Patel | Audit finding OPT-29: E3, E6 and E7 all had deadlines naming an unscheduled event ("the next dependency refresh"), so a HIGH advisory suppressed in `auditConfig.ignoreGhsas` would reach production by default rather than by decision. All three are now bound to **Part 85**, and `scripts/security-scan.test.mjs` fails if any suppressed GHSA's exception has a deadline that names no Plan part. |
