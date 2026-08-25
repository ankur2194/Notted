# Threat Model

This document records what Notted is protecting, who it is protecting it from, where the trust
boundaries fall, and — per surface — which control actually exists in the tree today and which
file carries it. It is the companion to the
[remediation checklist](remediation-checklist.md), which tracks the OWASP-oriented review and
its accepted exceptions.

**Authority.** [`docs/standards/security.md`](../standards/security.md) sets the posture (deny
by default, validate at trust boundaries, redact everything sensitive from logs).
[ADR 0003](../decisions/0003-authentication-ownership.md) makes Better Auth the only owner of
authentication and shared backend policies the only owner of workspace grants.
[ADR 0007](../decisions/0007-schema-gaps-and-safe-defaults.md) and
[ADR 0009](../decisions/0009-tenant-protection-strategy.md) make the workspace boundary a
repository-layer invariant rather than a convention; the mechanics are in
[`docs/tenant-and-retention.md`](../tenant-and-retention.md). The permission matrix this
document refers to by role is in [`docs/authorization.md`](../authorization.md).

**Scope.** Everything in `apps/api`, `apps/web`, and the container/queue platform they run on,
as the tree stands at Part 74. Controls that are deliberately deferred to a later plan part are
named as such rather than described as present.

## 1. Assets

| Asset                              | Where it lives                                                                                     | Why it is worth attacking                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Note content and versions          | `notes`, `note_versions`, `note_collaboration_updates`, Meilisearch, `note_embeddings`             | The product's substance; often the most confidential thing a workspace holds                   |
| Attachments and image renditions   | MinIO `attachments` bucket, `attachments` rows                                                      | Uploaded documents and images; also the classic vector for stored active content               |
| Workspace membership and roles     | `workspace_members`, `project_access`, `note_shares`                                                 | Escalating Editor to Admin, or joining a workspace at all, is total compromise of that tenant  |
| Credentials and sessions           | Better Auth tables, Redis session storage, session cookies                                          | Direct account takeover; the shortest path to every other asset                                |
| API keys                           | `api_keys.key_hash` (peppered HMAC-SHA-256, no plaintext)                                            | A long-lived, non-interactive credential with server-stored scopes                             |
| Webhook secrets                    | `webhooks.encrypted_secret` (+ key version), never in a DTO                                          | Forging a signed delivery to a tenant's receiver, or replaying one                             |
| Provider and AI credentials        | `ai_provider_config.encrypted_credentials`, SMTP/MinIO/Meilisearch config                            | Billable third-party access and a pivot out of the deployment                                  |
| Encryption keys and pepper         | `AUTH_SECRET` and the derived key material used by the credential/secret services                    | Compromise decrypts every provider secret and forges every API-key hash lookup                 |
| Audit logs                         | `audit_logs` (append-only, DB trigger enforced)                                                     | An attacker's first cleanup target; the trail is the repudiation defence                       |
| Exports                            | `exports` rows and their MinIO objects                                                              | A single archive can contain an entire project's notes and attachments                         |
| Custom-domain claims               | `workspace_domains` (globally unique hostname, verification token)                                   | Squatting a hostname, or rendering another tenant under a name users trust                     |
| Branding assets                    | `workspaces.logo_url`, `workspaces.settings.accentColor`, the logo object                            | The logo GET is deliberately public; the accent colour paints trusted chrome                   |

## 2. Actors

| Actor                       | What it can start with                                                                                    | Assumed capability                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Anonymous internet          | Any unauthenticated HTTP/WS request to the web app, the API, or a custom hostname                          | Full control of method, path, headers (`Host`, `Origin`, `X-Forwarded-*`), body, and timing              |
| Authenticated member        | A valid session and at least one workspace membership as **Owner**, **Admin**, **Editor**, or **Viewer**   | Everything anonymous can do, plus a real cookie; the interesting case is a Viewer or Editor reaching up  |
| API-key integration         | A workspace-bound key with server-stored scopes, over `/api/v1` REST only                                   | Non-interactive, no ambient cookie, no browser; explicitly rejected on tRPC                             |
| Platform operator           | Operator credentials for the Bull Board surface                                                            | Trusted but audited; the surface is deliberately narrow rather than open                                |
| Background worker           | BullMQ jobs consuming persisted payloads                                                                    | Runs with no user present; a payload is data, never authority                                           |
| External provider           | SMTP, an AI provider, MinIO, Meilisearch, Redis, PostgreSQL                                                 | Can be slow, can fail, can return hostile bytes; is not assumed malicious but is not trusted             |
| Custom-hostname DNS holder  | Control of DNS for a hostname pointed at the deployment (Part 73)                                          | Can create, change, and later withdraw records; can point a name it does not own at us                   |

The two actors worth stating plainly, because most of the design pressure comes from them: an
**authenticated member of workspace A** trying to reach workspace B, and a **workspace Admin**
supplying a value the server will act on (a webhook URL, a hostname, an AI provider base URL).

## 3. Trust boundaries

| #  | Boundary                              | Crossing                                                | Enforcement at the crossing                                                                                            |
| -- | ------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| B1 | Browser → web app                     | HTML/RSC over HTTPS                                     | Response headers from `apps/web/security-headers.js` via `apps/web/next.config.js`; host decision in `apps/web/src/proxy.ts` |
| B2 | Web app → API                         | `/api/v1` REST, tRPC, Better Auth base path             | `apps/api/src/main.ts` (helmet, CORS allow-list, credential middleware, CSRF), `apps/api/src/auth/csrf-origin.middleware.ts` |
| B3 | API → PostgreSQL                      | Drizzle queries inside a tenant context                 | `apps/api/src/tenant/tenant-context.service.ts`, `apps/api/src/tenant/workspace-scope.ts`, composite cross-tenant FKs      |
| B4 | API → Redis / MinIO / Meilisearch     | Session storage, rate-limit state, objects, search      | Private network only; objects are never served directly (downloads proxy through the API)                                 |
| B5 | API → SMTP                            | Outbound mail                                           | `apps/api/src/infrastructure/smtp/`, queued through BullMQ rather than sent on the request path                            |
| B6 | API → AI provider                     | Outbound HTTPS streaming                                | `apps/api/src/ai/providers/sse-stream.ts` under an `AbortSignal`; credentials from `apps/api/src/ai/ai-credential.service.ts` |
| B7 | API → outbound webhook target         | HTTPS to an address a workspace Admin chose             | `apps/api/src/webhooks/webhook-url-guard.ts` (six layers), `apps/api/src/webhooks/webhook-sender.ts`                       |
| B8 | Browser ↔ realtime channel            | Socket.io handshake, room joins, Yjs updates            | `apps/api/src/realtime/realtime-socket.adapter.ts`, `apps/api/src/realtime/realtime.gateway.ts`                            |
| B9 | Operator → Bull Board                 | An HTML operational surface on the API origin           | `apps/api/src/queue/bull-board-policy.ts` + the mount in `apps/api/src/main.ts`                                            |
| B10| Custom hostname → deployment edge     | A tenant-controlled name resolving to us (Part 73)      | `apps/api/src/domains/trusted-host.middleware.ts`, `apps/api/src/common/verified-hosts.service.ts`, `apps/web/src/proxy.ts` |

B10 is the newest and the least self-contained: the TLS certificate for a tenant hostname is
issued by the reverse proxy, which does not exist yet (Parts 79/80/82). Section 4.9 states what
that means for the threats it does and does not currently answer.

## 4. STRIDE by surface

Each row names a control that is in the tree. Where a threat is only partly answered, the row
says so and the residual is carried in §5.

### 4.1 Authentication and session handling

| Category               | Threat                                                                 | Control                                                                                                                        | File                                                                          |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Spoofing               | Credential stuffing / password guessing against a known address        | Per-identifier 60 s budget plus lockout (`AUTH_LOCKOUT_ATTEMPTS` failures inside `AUTH_LOCKOUT_SECONDS`) held atomically in Redis | `apps/api/src/auth/auth-lockout.service.ts`                                    |
| Spoofing               | Distributed guessing that rotates source addresses                     | The identifier is the axis that cannot be rotated; the per-IP bucket is a second, independent axis                              | `apps/api/src/auth/auth-rate-limit.middleware.ts`                              |
| Spoofing               | Forged `X-Forwarded-For` to escape the per-IP bucket or the audit trail | Better Auth reads exactly one private header, which `main.ts` overwrites unconditionally from Express's `request.ip`             | `apps/api/src/main.ts`, `apps/api/src/auth/better-auth.setup.ts`               |
| Spoofing               | Adopting a session identifier supplied by the attacker (fixation)      | The cookie set by the provider is the only carrier; no session id is read from a query string or body, and `cookieCache` is off so every request revalidates against the store | `apps/api/src/auth/better-auth.setup.ts`, `apps/api/src/auth/auth.service.ts`  |
| Tampering              | Cookie theft or replay across hosts                                    | `httpOnly`, `sameSite: "lax"`, `secure` in production, and **no `domain` attribute** — every cookie is host-only                 | `apps/api/src/auth/better-auth.setup.ts`                                       |
| Repudiation            | "It wasn't me" on a privileged change                                  | Privileged mutations write an append-only audit row in the same transaction                                                     | `apps/api/src/audit/audit-record.ts`, `apps/api/src/database/schema/audit-logs.ts` |
| Information disclosure | Account enumeration through a distinct "locked" or "unknown" answer    | One message and one shape for every refusal, known identifier or not                                                            | `apps/api/src/auth/auth-lockout.service.ts` (`AUTH_LOCKOUT_MESSAGE`)           |
| Information disclosure | An attempted address accumulating in Redis keys or log lines           | Identifiers are SHA-256 hashed before they are keyed or logged; the log names nobody                                            | `apps/api/src/auth/auth-lockout.service.ts`                                    |
| Denial of service      | Password-hash CPU exhaustion                                           | The lockout check refuses **before** any password is verified, so a locked identifier costs no hash                             | `apps/api/src/auth/auth-lockout.service.ts`                                    |
| Denial of service      | Flooding the sign-in path                                              | A dedicated `:auth` token bucket keyed per IP, separate from the general and sensitive tiers                                     | `apps/api/src/auth/auth-rate-limit.middleware.ts`                              |
| Elevation of privilege | Reusing an old session for a high-impact action                        | Freshness (`freshAge` / `recentAuthenticationSeconds`) is required for billing, workspace deletion, membership privilege change, API-key secret lifecycle, webhook configuration and session revocation | `apps/api/src/auth/auth.service.ts`, `apps/api/src/authorization/authorization-policy.service.ts` |
| Elevation of privilege | Cross-site sign-in/sign-out or credential change                       | Every state-changing request to the Better Auth base path must carry a trusted `Origin`                                          | `apps/api/src/main.ts`                                                         |

### 4.2 The versioned REST and tRPC surface

| Category               | Threat                                                                    | Control                                                                                                                     | File                                                                            |
| ---------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Spoofing               | A forged header selecting a privileged rate-limit tier or actor           | Only the two trusted credential resolvers install a principal, and they run ahead of the Nest pipeline in a load-bearing order | `apps/api/src/main.ts`, `apps/api/src/common/rate-limit/trusted-principal.ts`    |
| Spoofing               | An API key used on the first-party transport                              | A `Bearer ntd_…` credential on the tRPC path is rejected `403` rather than silently ignored                                   | `apps/api/src/main.ts`                                                           |
| Tampering              | Cross-site forged mutation riding an ambient cookie                       | Default-deny `Origin` check for every mutating, cookie-authenticated, non-API-key request on `/api/v1`, layered over the per-service `assertTrustedMutationOrigin` calls | `apps/api/src/auth/csrf-origin.middleware.ts`, `apps/api/src/auth/auth.service.ts` |
| Tampering              | SQL injection through a filter, sort, or identifier                       | Every query is a parameterised Drizzle builder; there is no `sql.raw` anywhere in `apps/api/src`                              | `apps/api/src/database/`, service modules                                        |
| Tampering              | Unmodelled or extra fields reaching a service                             | Global `ValidationPipe` with `whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`; shared Zod contracts at the boundary  | `apps/api/src/main.ts`, `packages/shared-validators/`                            |
| Tampering              | A retried mutation applied twice                                          | `Idempotency-Key` handling for retryable side-effecting mutations                                                             | `apps/api/src/common/idempotency/api-idempotency.ts`                             |
| Repudiation            | An untraceable request                                                    | A request id is assigned first and echoed on every response, including refusals                                              | `apps/api/src/common/request/request-context.middleware.ts`                       |
| Information disclosure | Probing whether a resource in another workspace exists                    | Cross-tenant and guessed identifiers return the same concealed `404`; `401` and `403` are reserved for their own cases        | `apps/api/src/authorization/authorization-policy.service.ts`, `apps/api/src/authorization/authorization.errors.ts` |
| Information disclosure | A stack trace, SQL string, or provider detail in an error body            | One stable error envelope; only `safeResponse` reaches the client                                                            | `apps/api/src/common/errors/api-exception.filter.ts`, `apps/api/src/common/errors/api-http.exception.ts` |
| Information disclosure | A hostile web origin reading authenticated responses                      | CORS answers from an allow-list callback (configured origins plus verified custom hosts) rather than reflecting `Origin`      | `apps/api/src/main.ts`, `apps/api/src/common/verified-hosts.service.ts`          |
| Denial of service      | Unbounded request bodies or listings                                      | `requestBodyLimitBytes` on JSON and urlencoded parsing, `parameterLimit`, bounded pagination in the services                  | `apps/api/src/main.ts`                                                           |
| Denial of service      | Request flooding                                                          | Three disjoint token-bucket tiers (IP, user, API key) plus a `:sensitive` sub-bucket                                          | `apps/api/src/common/rate-limit/rate-limit.service.ts`                            |
| Elevation of privilege | A route added later that forgets to authorize                             | `@RequireAuthorization` is required for the guard to admit a request, and `ApiKeyRouteGuard` is default-deny for API-key callers | `apps/api/src/authorization/authorization-http.guard.ts`, `apps/api/src/api-keys/api-key-route.guard.ts` |
| Elevation of privilege | A workspace UUID in the path granting access to that workspace            | The UUID is a selector; only a live `workspace_members` row opens a tenant context, and every subsequent read is scoped        | `apps/api/src/authorization/authorization-entry.service.ts`, `apps/api/src/tenant/workspace-scope.ts` |

### 4.3 File upload and download

| Category               | Threat                                                                | Control                                                                                                                        | File                                                                     |
| ---------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Spoofing               | A declared `Content-Type` or extension that lies about the bytes      | Type is derived from magic bytes; the declared value is ignored, and the download extension is forced to the sniffed type's canonical one | `apps/api/src/attachments/attachment-admission.ts`, `apps/api/src/attachments/filename.ts` |
| Tampering              | Path traversal through a filename into the object key                 | The raw filename never becomes a key; keys are derived server-side and the user's name survives only as display metadata        | `apps/api/src/attachments/attachment-storage-key.ts`, `apps/api/src/attachments/filename.ts` |
| Tampering              | Bidi/control characters or a double extension disguising a file       | C0/C1, zero-width, and the Unicode bidi overrides are stripped; Windows reserved device names are refused                       | `apps/api/src/attachments/filename.ts`                                    |
| Information disclosure | Reading another workspace's object by guessing a key                  | `authorizeFile` runs a database lookup for every download; an object key is never itself authority                              | `apps/api/src/authorization/authorization-adapters.service.ts`, `apps/api/src/attachments/attachments.controller.ts` |
| Information disclosure | A long-lived bearer URL leaking an attachment                         | Downloads are **proxied** through the API rather than presigned; MinIO stays private and the response is `private, max-age=…, immutable` | `apps/api/src/attachments/attachments.controller.ts`                      |
| Denial of service      | Decompression bomb (huge canvas, deep animation, oversized source)    | `MAX_IMAGE_UPLOAD_BYTES`, `MAX_IMAGE_PIXELS` via Sharp's `limitInputPixels`, and `MAX_IMAGE_ANIMATION_FRAMES`                    | `apps/api/src/config/image-processing.config.ts`, `apps/api/src/attachments/image-processing.service.ts` |
| Denial of service      | A lying `Content-Length` streaming past the ceiling                   | The multipart parser enforces the byte ceiling **during** transfer, not after                                                    | `apps/api/src/attachments/multipart-upload.parser.ts`                     |
| Denial of service      | A pathological SVG (billion laughs, backtracking prescan)             | Entity declarations are refused outright and every prescan pattern is linear, with a wall-clock test asserting it                | `apps/api/src/attachments/svg-safety.ts`                                  |
| Denial of service      | Filling a workspace's storage                                         | Per-workspace quota reserved inside the write transaction, plus the abandoned-upload and orphan sweeps                          | `apps/api/src/storage/storage-quota.service.ts`, `apps/api/src/maintenance/storage-maintenance.service.ts` |
| Elevation of privilege | Stored XSS through an uploaded SVG or HTML-ish file                   | SVG is **rasterized**, never served as `image/svg+xml`; text uploads are stored as `text/plain`; downloads carry `nosniff` and a `Content-Disposition` | `apps/api/src/attachments/svg-safety.ts`, `apps/api/src/attachments/text-safety.ts`, `apps/api/src/attachments/attachments.controller.ts` |
| Elevation of privilege | SSRF or local-file read through an SVG external reference             | External references and `<foreignObject>` are refused before librsvg sees the bytes                                             | `apps/api/src/attachments/svg-safety.ts`                                  |

### 4.4 Export generation and download

| Category               | Threat                                                              | Control                                                                                                       | File                                                          |
| ---------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Spoofing               | Requesting an export of a source the requester cannot read          | Export creation authorizes the source, and download re-checks the same requester/source rule                   | `apps/api/src/export/export.service.ts`                        |
| Tampering              | Editing an export record to point at another workspace's objects    | Export rows are workspace-scoped like every other tenant row; object keys are derived, never accepted          | `apps/api/src/export/export.service.ts`, `apps/api/src/tenant/workspace-scope.ts` |
| Repudiation            | An undocumented bulk extraction                                     | Export actions are audited (`export` is one of the audited action families)                                    | `apps/api/src/audit/audit-record.ts`                           |
| Information disclosure | A shareable download URL                                            | Downloads are proxied and authorized per request, with `Cache-Control: private, no-store`                       | `apps/api/src/export/export.controller.ts`                     |
| Information disclosure | An export outliving the access that produced it                     | Retention windows purge export artefacts; see [`docs/tenant-and-retention.md`](../tenant-and-retention.md)      | `apps/api/src/maintenance/storage-maintenance.service.ts`      |
| Denial of service      | An export that pulls unbounded attachment bytes into memory         | `readObject` stops at `maxBytes` rather than buffering first and measuring after                                | `apps/api/src/export/note-export-source.service.ts`            |
| Denial of service      | Export flooding                                                     | Export generation runs on the queue under the shared bounded-retry policy, not on the request path; creation is rate-limited like every other mutation | `apps/api/src/export/export-generation.service.ts`, `apps/api/src/queue/job-registry.ts` |
| Elevation of privilege | A Viewer exporting content they can only read in-app               | The policy treats export as an action over a readable source, evaluated by the same engine as every other action | `apps/api/src/authorization/authorization-policy.service.ts`   |

### 4.5 Outbound webhooks (SSRF)

The destination is chosen by a workspace Admin, so every delivery is a request our server makes
to an address an outsider picked. Containment is layered and each layer has its own test.

| Category               | Threat                                                                      | Control                                                                                                     | File                                                     |
| ---------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Spoofing               | A receiver cannot tell our delivery from a forged one                       | HMAC-SHA-256 over `t=<unix>` plus the exact serialised body, sent as `x-notted-signature`                     | `apps/api/src/webhooks/webhook-signature.ts`              |
| Tampering              | Replaying an old delivery                                                   | The timestamp is inside the signed material and verification is constant-time                                 | `apps/api/src/webhooks/webhook-signature.ts`              |
| Information disclosure | The signing secret readable from the database or an API response            | Stored encrypted with a key version and an AAD bound to the webhook id; `encryptedSecret` is absent from the DTO by construction | `apps/api/src/webhooks/webhook-secret.service.ts`, `apps/api/src/webhooks/webhooks.service.ts` |
| Information disclosure | A URL with an embedded credential landing in logs                           | Credentials in the URL are refused (L2), and the block error is a stable code that never quotes the URL        | `apps/api/src/webhooks/webhook-url-guard.ts`              |
| Denial of service      | Using us as an amplifier, or a hanging receiver stalling the worker         | Bounded retry with backoff and a bounded per-delivery timeout in the sender/worker                             | `apps/api/src/webhooks/webhook-sender.ts`, `apps/api/src/webhooks/webhook-delivery.worker.service.ts` |
| Elevation of privilege | Reaching the cloud metadata endpoint, the database, or our own API          | Six layers: scheme allow-list, no embedded credentials, hostname deny-list (incl. our own hostnames), address deny-list, pre-flight DNS, and a connect-time `lookup` re-check | `apps/api/src/webhooks/webhook-url-guard.ts`              |
| Elevation of privilege | DNS rebinding between validation and connect                                | L6 re-runs the same address filter on the answer the socket is about to dial, which is what closes the check-then-use race | `apps/api/src/webhooks/webhook-url-guard.ts`              |
| Elevation of privilege | IPv6-costume bypasses (`::ffff:127.0.0.1`, `::7f00:1`, NAT64, zone ids)     | Mapped and v4-compatible forms are unmapped and re-checked against the v4 lists; unparseable input is blocked  | `apps/api/src/webhooks/webhook-url-guard.ts`              |

### 4.6 The realtime channel (Socket.io / Yjs)

| Category               | Threat                                                                | Control                                                                                                            | File                                                       |
| ---------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Spoofing               | Connecting from a hostile page                                        | The handshake requires exactly one `Origin` header, refuses `null`, requires it to parse back to itself, and matches it against the trusted set | `apps/api/src/realtime/realtime-socket.adapter.ts`          |
| Spoofing               | An unauthenticated or expired socket                                  | The handshake is authenticated from its raw headers, sessions are revalidated, and expiry forces a disconnect         | `apps/api/src/realtime/realtime.gateway.ts`                 |
| Tampering              | A malformed or oversized event payload                                | Every event is parsed by a Zod contract; `maxHttpBufferSize` caps the frame                                          | `apps/api/src/realtime/realtime.contracts.ts`, `apps/api/src/realtime/realtime-socket.adapter.ts` |
| Tampering              | Writing a Yjs update into a note the client may not edit              | `authorizeSocketMessage` runs for every permission-sensitive message; ALS context is never retained on the connection | `apps/api/src/realtime/realtime.gateway.ts`                 |
| Information disclosure | Joining another workspace's room by naming it                         | Room names are selectors; `authorizeSocketJoin` re-authorizes every join against live membership and resource facts   | `apps/api/src/realtime/realtime.gateway.ts`, `apps/api/src/authorization/authorization-adapters.service.ts` |
| Information disclosure | Presence leaking identity or a Redis key leaking an actor id          | Rate-limit and lease keys are HMAC digests of the actor, not the actor; presence lives only in socket data and dies with the process | `apps/api/src/realtime/realtime-rate-limit.service.ts`, `apps/api/src/realtime/realtime.gateway.ts` |
| Denial of service      | Join/update/awareness floods                                          | Per-tier Redis counters (`ip`, `principal`, `join`, `sync`, `update`, `awareness`, `presence`) with disjoint buckets  | `apps/api/src/realtime/realtime-rate-limit.service.ts`      |
| Denial of service      | Opening unbounded sockets per account                                 | A bounded, TTL'd socket lease per actor                                                                              | `apps/api/src/realtime/realtime-rate-limit.service.ts`      |
| Elevation of privilege | Keeping a room after the grant is revoked                             | Membership and resource access are re-evaluated per join and per sensitive message, not cached on the connection      | `apps/api/src/realtime/realtime.gateway.ts`                 |

### 4.7 Background jobs and the Bull Board operational surface

| Category               | Threat                                                                | Control                                                                                                          | File                                                       |
| ---------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Spoofing               | A job payload asserting an actor or a permission                      | Payloads persist identifiers only; `authorizeUserJob` re-checks current membership and resource access at run time  | `apps/api/src/authorization/authorization-adapters.service.ts` |
| Tampering              | A system job acting with wildcard authority                           | System jobs declare a named purpose and finite `allowedActions`/`allowedResourceKinds`, and stay workspace-scoped   | `apps/api/src/authorization/authorization-adapters.service.ts` |
| Tampering              | A job dispatched for a transaction that later rolled back             | Jobs and events are dispatched only after commit (ADR 0006)                                                        | `apps/api/src/queue/`, service transaction boundaries       |
| Repudiation            | An operator retry with no record                                      | A Bull Board mutation commits an audit row before it is allowed to touch Redis                                     | `apps/api/src/queue/queue-admin-remediation.service.ts`     |
| Information disclosure | Job payloads or the board exposing content                            | Structured-log redaction covers secrets, cookies, signatures and connection strings; the board is `no-store`, `no-referrer`, `noindex` | `apps/api/src/common/logging/structured-logger.service.ts`, `apps/api/src/main.ts` |
| Denial of service      | An unbounded retry storm                                              | Retries are bounded with backoff, and repeated failures land in a dead-letter state rather than looping             | `apps/api/src/queue/job-registry.ts`                        |
| Elevation of privilege | Anonymous access to the queue console                                 | Operator authentication for **every** document, asset and API request under the board path, plus the general rate limit | `apps/api/src/auth/platform-operator.service.ts`, `apps/api/src/main.ts` |
| Elevation of privilege | Using the board's own API to do more than retry                       | A closed allow-list: anything outside it answers `404`, and mutations additionally require a trusted `Origin`        | `apps/api/src/queue/bull-board-policy.ts`                   |

### 4.8 The Part 72 branding surface

| Category               | Threat                                                                     | Control                                                                                                     | File                                                        |
| ---------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Spoofing               | Guessing a logo URL to read a workspace's branding                         | A 128-bit random token is both the object-key suffix and the path segment, compared with `timingSafeEqual`     | `apps/api/src/workspaces/workspace-logo.service.ts`          |
| Tampering              | Uploading a logo without the right to change settings                      | `POST`/`DELETE` carry `@RequireAuthorization({ action: "settings.update" })` and `assertTrustedMutationOrigin`; only the `GET` is unauthenticated | `apps/api/src/workspaces/workspace-logo.controller.ts`       |
| Tampering              | Reaching the image pipeline before authorization                           | The multipart body is read **after** authorization, so no byte is consumed for a caller who may not write      | `apps/api/src/workspaces/workspace-logo.controller.ts`       |
| Repudiation            | An unexplained brand change                                                | Logo set/remove commits an audit row in the same transaction as the `logo_url` write                           | `apps/api/src/workspaces/workspace-logo.service.ts`          |
| Information disclosure | The public GET distinguishing "wrong token" from "no logo"                 | Malformed token, wrong token, and absent object all answer the same `404`                                       | `apps/api/src/workspaces/workspace-logo.service.ts`          |
| Information disclosure | A superseded logo staying readable                                         | Replacing or deleting mints a new token, so the old URL stops resolving                                        | `apps/api/src/workspaces/workspace-logo.service.ts`          |
| Denial of service      | An oversized or hostile image on a public-facing route                     | 2 MiB ceiling enforced during transfer, and every stored logo is re-encoded to a 200 px WebP                    | `apps/api/src/workspaces/workspace-logo.service.ts`          |
| Elevation of privilege | Active content in branding (`<style>`, `url()` exfiltration, chrome spoof) | **Custom CSS is not shipped** — no field, no API, no UI. The accent colour is a validated `#rrggbb` re-checked immediately before it becomes CSS, and a malformed value emits no style attribute at all | `packages/shared-validators/src/color-contrast.ts`, `apps/web/src/lib/shell/accent-style.ts` |
| Elevation of privilege | An accent colour that makes the trusted chrome unreadable                  | A server-side 3:1 contrast floor (`ACCENT_CONTRAST_TOO_LOW`) refuses the write                                  | `apps/api/src/workspaces/workspaces.service.ts`              |

The unshipped custom-CSS feature is the important row: ADR 0014 records the three threats
(exfiltration through `url()`/`@import` on attribute selectors, spoofing the trusted chrome, and
locking an administrator out of their own workspace) and the prerequisites for ever shipping it,
of which a `style-src` allow-list is one. Part 74's web CSP now supplies that allow-list, but the
remaining prerequisites — a server-side sanitiser, a scoped root, and a safe-mode escape hatch —
are not built.

### 4.9 The Part 73 custom-domain surface

| Category               | Threat                                                                          | Control                                                                                                        | File                                                       |
| ---------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Spoofing               | Claiming a hostname the workspace does not own                                  | Two required DNS proofs: a `_notted-verify.<host>` TXT token and a CNAME to the configured target (apex fallback), each bounded at 5 s | `apps/api/src/domains/domain-verifier.ts`                   |
| Spoofing               | Squatting a hostname another tenant will later want                             | `workspace_domains.hostname` is globally unique, and every unique violation collapses to one indistinguishable `409 DOMAIN_TAKEN` | `apps/api/src/domains/domains.service.ts`                   |
| Spoofing               | Host-header injection poisoning generated links or caches                       | The trusted-host middleware refuses an unrecognised host with `421` before helmet, CORS, Better Auth, or any route sees it | `apps/api/src/domains/trusted-host.middleware.ts`            |
| Tampering              | A forged `X-Forwarded-Host`                                                     | `request.hostname` honours the forwarded host **only** when `TRUST_PROXY_HOPS` configures it; otherwise the header is ignored | `apps/api/src/domains/trusted-host.middleware.ts`, `apps/api/src/main.ts` |
| Repudiation            | An untracked domain claim or removal                                            | Claim, verification, and removal each commit an audit row in the same transaction as the row and mirror write     | `apps/api/src/domains/domains.service.ts`                    |
| Information disclosure | An unverified hostname rendering a workspace shell                              | `proxy.ts` resolves the host server-side against the API and returns `404` for anything not verified — including on timeout or error | `apps/web/src/proxy.ts`, `apps/api/src/domains/domain-resolve.controller.ts` |
| Information disclosure | One tenant's hostname rendering another tenant's workspace                      | The resolve answer, not the cookie, decides the workspace; the selection cookie is host-only, `httpOnly`, `Lax`   | `apps/web/src/proxy.ts`, `apps/web/src/lib/domains/custom-host.ts` |
| Information disclosure | A tenant's cookie travelling to the primary host or to another tenant's host    | No cookie carries a `domain` attribute anywhere in the product; sessions are consequently **per host**             | `apps/api/src/auth/better-auth.setup.ts`, `apps/web/src/proxy.ts` |
| Denial of service      | Resolve lookups on every asset request                                          | Static assets are excluded by the proxy matcher; answers are cached 60 s and the call carries a 3 s abort          | `apps/web/src/proxy.ts`                                      |
| Denial of service      | DNS verification hanging a request                                              | Every lookup is bounded by `DNS_TIMEOUT_MS` through a `Promise.race`, and verification runs before the transaction opens | `apps/api/src/domains/domain-verifier.ts`                    |
| Elevation of privilege | Treating "arrived on the tenant's host" as authorization                        | The proxy is explicitly not an authorization boundary; every API route re-authorizes membership server-side        | `apps/web/src/proxy.ts`, `apps/api/src/authorization/authorization-entry.service.ts` |

**Certificate and edge assumptions, stated rather than assumed.** Part 73 ships the *ask* seam
(`GET /domains/resolve`) and nothing else: there is no ACME client, no certificate store, and no
renewal schedule in this tree. Everything above assumes a reverse proxy terminates TLS for the
tenant hostname and sets `X-Forwarded-*` consistently with `TRUST_PROXY_HOPS`. That proxy is
Parts 79/80/82. Two consequences hold today: HSTS is emitted only when `NODE_ENV=production`
(sending it from a local `http://` origin would durably pin a developer's browser), and a
verified hostname is only as trustworthy as the edge that presents its certificate. Also note
that verification is on demand: a domain whose DNS is later withdrawn stays `verified` until an
administrator re-verifies, and the verified-host cache is per process with a 60 s positive TTL,
so a freshly verified host can behave intermittently for up to a minute on a multi-process
deployment.

## 5. Residual risk

Five risks are accepted rather than mitigated in this part. They are not restated here; each is
recorded as a numbered exception in
[`remediation-checklist.md`](remediation-checklist.md#exceptions), with an owner and a plan part
that closes it:

- **E1** — the web CSP needs `script-src 'unsafe-inline'` (closes at Part 82).
- **E2** — the general API rate-limit store is per process, so limits are per replica (Part 80).
- **E3** — one advisory is suppressed in `pnpm audit` (re-evaluated at the next dependency refresh).
- **E4** — container scanning covers development images only (Part 79).
- **E5** — sessions are per host, so a custom domain needs its own sign-in (Part 82).
- **E6** — `pdfjs-dist` carries a high advisory that only a major bump fixes (next dependency-matrix refresh).
- **E7** — transitive `brace-expansion` and `nanoid` denial-of-service advisories (next dependency-matrix refresh).

Two further limitations are documented in their own completed-part records rather than as
exceptions, because they are deliberate product boundaries rather than accepted security debt:
custom CSS is absent (Part 72), and one hostname per workspace with manual re-verification
(Part 73).

## Revision History

| Date       | Author      | Change                                       |
| ---------- | ----------- | -------------------------------------------- |
| 2026-08-25 | Ankur Patel | Initial threat model, produced for Part 74.   |
