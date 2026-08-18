# Part 65 — Implement public REST API and API key management

## Status

- **State:** Complete — two review rounds passed; full quality gate green on 2026-08-19
- **Completed on:** 2026-08-18
- **Implemented by:** Claude Opus 5 lead agent with five delegated subagents (api-keys module, transport wiring, OpenAPI, web, docs)
- **Plan reference:** `Plan.md`, Part 65
- **Related records:** Part 5 (rate-limit guard, deferred `@darraghor` OpenAPI rules), Part 18 (`api_keys` table), Part 19 (tenant context), Part 24 (authorization policy), Part 62 (export REST-only precedent)

## Objective

Expose a versioned public REST API with hashed, scoped API keys, pagination/filter/sort contracts, OpenAPI documentation, revocation/expiry/last-used tracking, and three independent rate-limit tiers — reusing the same services and policies that serve the first-party client.

## Implemented Work

**The 19 existing `/api/v1` controllers ARE the public API.** No parallel surface was built. An authenticated API key installs a synthetic `AuthenticatedPrincipal` for the key's `created_by_id` user plus a separate `ApiKeyAuthorizationActor` on the request. Scope is decided at the HTTP guard by the already-shipped `decideApiKey()`; the creator's live workspace role is enforced unchanged at the service layer. **Effective permission = scope ∩ creator role**, and it fails closed by itself when the creator is demoted or removed. **Zero controller and zero service changes** outside the new module.

- `apps/api/src/api-keys/` — secret primitives, request-context slot, bearer authenticator, default-deny route guard, management service and controller.
- Credential: `Authorization: Bearer ntd_pk_<32 base64url chars>` (24 random bytes, 192 bits). `key_prefix` is `raw.slice(0, 8)`, exactly what the Part 18 `varchar(8)` comment prescribes. The wire format is gated by `API_KEY_SECRET_PATTERN` before any database round-trip.
- Unknown, revoked, and expired keys all raise **one identical 401** (`UNAUTHENTICATED`, "The API key is invalid.") — no enumeration oracle. The row is **never cached**, because "revoked keys stop immediately" is a Plan verification clause.
- `last_used_at` is a throttled, fire-and-forget conditional `UPDATE` (at most one write per key per minute).
- Three independent rate-limit tiers on already-disjoint bucket keys (`ip:<ip>`, `actor:user:<id>`, `actor:api-key:<id>`), plus a per-route sensitive tier with its own `:sensitive` bucket applied to exactly one route: `POST .../api-keys`.
- `apps/api/src/openapi/` — the document is built by walking **Nest decorator metadata** (`Reflect.getMetadata("imports", AppModule)` → `controllers` → `PATH_METADATA`/`METHOD_METADATA`) without booting the app or touching a database. **93 routes discovered, 93 documented, zero orphans.** Served memoized from `GET /api/v1/openapi.json` and committed to `docs/openapi.json`.
- `apps/web` — `ApiKeys.tsx` in workspace settings with loading, empty, error, permission, one-time-reveal, and list states.

## Important Decisions

- **Synthetic principal over a bespoke API-key path through every service.** Rewriting 19 controllers to accept two actor kinds would have been the larger, riskier diff and would have needed re-verification of every existing tenant test. The synthetic principal makes an API-key request indistinguishable to a service from its creator's request, which is exactly the desired semantics, and the separate actor object is what carries scope.
- **Deterministic HMAC-SHA256 over argon2/bcrypt.** A per-row salted KDF cannot be used as a lookup key: authentication would require scanning and verifying every candidate row. HMAC keyed by `BETTER_AUTH_SECRET` keeps the unique index `api_keys_key_hash_unique` as the single-probe lookup path, while the pepper means a database-only compromise can neither verify nor forge a key. The secret is 192 bits of CSPRNG output, so the offline-guessing resistance a slow KDF buys is not needed — there is nothing low-entropy to guess. Same pattern as `memberships/invitation-token.service.ts`. **No new environment variable**; the cost is that rotating `BETTER_AUTH_SECRET` invalidates every issued key, documented in `docs/environment.md`.
- **Default-deny route guard.** Because API keys reach the whole router, an `APP_GUARD` refuses any API-key request landing on a handler with no `AUTHORIZATION_HTTP_SPEC` metadata. New routes are therefore closed to API keys until someone deliberately opens them.
- **API-key access to tRPC is rejected by path with 403.** tRPC is the first-party transport and not a compatibility promise.
- **Idempotent replay of create returns 409 `IDEMPOTENT_RESULT_UNAVAILABLE`** rather than a stored result. The raw secret exists only in the original response; returning the summary without it would hand back a key the caller cannot use. The code already exists in `ApiErrorCode` and is already used this way in `notes.service.ts`.
- **`@darraghor/nestjs-typed` OpenAPI lint rules stay disabled** (deferred by Part 5). They assume `@nestjs/swagger` class DTOs; this codebase is Zod-first with `unknown` handler inputs. Enabling them would demand class DTOs for 93 routes and contradict ADR 0002. `eslint.config.mjs` was not touched.
- **Zero new dependencies for OpenAPI.** `zod@4.4.3` ships `z.toJSONSchema`. An `override` callback collapses the recursive TipTap document schema to `{ type: "object" }` — without it the document is ~99 KB of one schema.
- **`parseScopes` filters unknown CSV tokens instead of throwing.** Filtering can only narrow permission; a corrupt row degrades to fewer scopes rather than 500-ing every request presenting that key.
- **No database migration.** `api_keys` is used exactly as Part 18 shipped it.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/src/api-keys/api-key-secret.ts` | Pure secret generation, HMAC hashing, scope CSV round-trip |
| `apps/api/src/api-keys/api-key-context.ts` | Symbol-keyed `ApiKeyAuthorizationActor` slot on the request |
| `apps/api/src/api-keys/api-key-auth.service.ts` | Bearer authentication, single unique-index probe, principal/actor installation, throttled `last_used_at` |
| `apps/api/src/api-keys/api-key-route.guard.ts` | `APP_GUARD` default-deny for handlers without an authorization spec |
| `apps/api/src/api-keys/api-keys.service.ts` | `list`/`create`/`revoke` with tenant scoping, idempotency, in-transaction audit |
| `apps/api/src/api-keys/api-keys.controller.ts` | `/workspaces/:workspaceId/api-keys` transport |
| `apps/api/src/main.ts` | `/api/v1` pre-guard: api-key first, cookie fallback; tRPC rejection; `ApiHttpException`-aware `catch` |
| `apps/api/src/authorization/authorization-http.guard.ts` | Routes api-key requests to `authorizeApiKey`; **enforces key↔route workspace binding** |
| `apps/api/src/auth/auth.service.ts` | CSRF origin check exempts API keys |
| `apps/api/src/common/rate-limit/*` | Three-tier selection, `RateLimitTier` decorator, sensitive bucket |
| `apps/api/src/openapi/*` | Metadata route walker, route documentation map, memoized document endpoint |
| `apps/api/scripts/generate-openapi.ts` | Writes the committed `docs/openapi.json` |
| `packages/shared-types/src/api-key.ts` | `API_KEY_API_PATHS`, `ApiKeySummary` and friends (**no `keyHash`**) |
| `packages/shared-validators/src/api-key.schema.ts` | Wire-format pattern, create/list/response schemas |
| `apps/web/src/components/workspaces/ApiKeys.tsx` | Settings UI including one-time secret reveal |
| `docs/API.md`, `docs/openapi.json` | Public contract, prose and machine-readable |

## Database and Data Changes

**None.** No migration, no schema edit, no seed change. `api_keys` (migration `0006_graceful_blindfold.sql`, Part 18) is used as shipped. Audit rows are written to the existing `audit_logs` table with `entityType: "api_key"`, which that schema already documents.

## API, Configuration, and Operational Changes

- New routes: `GET|POST /api/v1/workspaces/{workspaceId}/api-keys`, `DELETE /api/v1/workspaces/{workspaceId}/api-keys/{apiKeyId}`, and `GET /api/v1/openapi.json`.
- New environment variable: **`RATE_LIMIT_API_KEY_PER_MINUTE`**, default **100**, range 1..1,000,000. Added to `apps/api/.env.example`, `app.config.ts`, `ENVIRONMENT_KEYS`, and `docs/environment.md`. The default is safe for a fresh clone and for production; no deployment step is required.
- `compose.yaml` was deliberately **not** changed. Its raised `RATE_LIMIT_*` values exist so the Playwright stack is not throttled, and no browser spec authenticates with an API key — the UI creates keys over a cookie session, and that route sits on the already-raised sensitive tier.
- New script `pnpm --filter @notted/api openapi:generate` (uses the repo's existing `node --import tsx` runner; `tsx` was already a devDependency). **`docs/openapi.json` must be regenerated after any route or shared-schema change**, and regeneration requires a built `packages/shared-validators`.
- No new `ApiErrorCode` values, no new authorization actions, no new resource kinds. `apiKey.list|create|revoke` and the `apiKey` resource kind already existed; `decideApiKey` already required the `admin` scope for the `apiKey.` prefix.

## Security and Tenant-Isolation Notes

- **A cross-tenant escalation was found and fixed during merge review.** `authorizeMachine` derives its tenant context from `actor.workspaceId` alone and never receives the route's workspace, so the guard's resolved `workspaceId` was being discarded on the api-key branch. A key issued for workspace A reaching a workspace-B path was authorized against A, after which the controller operated on B with the creator's synthetic principal — and any creator belonging to **both** workspaces would have carried the key across the tenant boundary, defeating the ADR 0003 one-workspace binding. `AuthorizationHttpGuard` now rejects a mismatch with **404, never 403**. Regression test: `apps/api/src/authorization/authorization-http.test.ts`. The seeded tenants have disjoint membership, so the e2e cross-workspace case would have passed regardless; that test now carries a comment saying so.
- Raw secrets exist only in the create response and the caller's store. `keyHash` is never projected to any transport, log, or audit row; audit metadata carries `{ keyPrefix, scopes }` only.
- The credential lookup is deliberately un-tenant-scoped — it is what *establishes* the workspace — and is commented as such, matching `AuthorizationRepository.findMembership`.
- The synthetic principal carries `isFresh: false`, so `requireRecentAuthentication` denies API keys with no extra code. Note the separate finding below about `HIGH_RISK_ACTIONS`.
- CSRF origin enforcement is skipped for API keys: a bearer token is not ambient credential material, no browser attaches it cross-site, and integrations send no `Origin`.
- Cross-workspace access answers 404 at both policy and service layers; no existence leaks.

## Verification Evidence

Two independent review rounds ran the full gate serially. Round 1 (2026-08-18) found five blocking findings (all fixed by the one-shot fix wave); round 2 (2026-08-19) confirmed every fix and surfaced one final contract divergence (success responses are not enveloped — resolved by ADR 0013 in favour of the shipped bare-payload shape). Final results below are from the post-ADR-0013 run on 2026-08-19 with the dev stack up and `DATABASE_URL` exported.

| Check | Result | Notes |
|---|---|---|
| `pnpm format:check` | **Pass** | `docs/openapi.json` is now Prettier-ignored; the generator's output is authoritative |
| `pnpm lint` | **Pass** | 0 warnings (`--max-warnings 0`) |
| `pnpm type-check` | **Pass** | 6/6 tasks |
| `pnpm test` | **Pass** | api 178 passed / 23 DB-gated skipped; web 133; validators 14; types 4 |
| `pnpm build` | **Pass** | With the CI `NEXT_PUBLIC_*` production values |
| `pnpm test:ci` | **Pass** | Exit 0. Coverage: api 84.48% stmts / 76.11% branch; web 79.31/72.29; validators 86.87/79.07; types 95.6/95.69 — all thresholds met |
| `apps/api/test/api-keys.e2e.test.ts` | **Pass** | 16/16, incl. REST-vs-service parity, read-key-cannot-write (with row-count proof), revoked-key-immediate-401, raw-key-never-in-database, per-tier 429, freshness-gate 403, share-PUT regression |
| `apps/api/test/openapi.contract.test.ts` | **Pass** | 9/9 — route↔document bijection, bearer scheme, no `keyHash`/`encryptedSecret` leak, `secret` only on minting routes |
| `pnpm --filter @notted/api openapi:generate` | **Pass** | Deterministic (byte-identical on re-run); document matches the committed `docs/openapi.json` |
| Live probes (review rounds) | **Pass** | read key: share-PUT 403, note-copy POST 403, notes GET 200; write key: tag POST 201; cross-tenant GET 404; probe rows cleaned up |

## Known Limitations and Follow-up Work

- **An API key CANNOT perform any high-risk action, and that is a deliberate, security-positive property.** An earlier draft of this record claimed the opposite; it was wrong, and review round 1 disproved it against a running instance. `decideApiKey` does return before the policy's `HIGH_RISK_ACTIONS` freshness gate — but every high-risk action is authorized a SECOND time inside its service through `authorizeUser`, using the synthetic principal the key installs, whose `isFresh` is `false` by construction. That second check reaches the gate and answers **403 `RECENT_AUTHENTICATION_REQUIRED`**. So `apiKey.create`, `apiKey.revoke`, `webhook.create/update/delete`, `member.update`, `member.remove`, `billing.update`, `workspace.delete` and `session.revoke` are all unavailable to a key, however wide its scope: **a stolen admin key cannot mint a successor that outlives revocation of the original.** `apps/api/test/api-keys.e2e.test.ts` and `apps/api/test/webhooks.e2e.test.ts` both assert this. Consequence to keep in mind: key management is a cookie-session-only operation, so an integration cannot rotate its own credential.
- **Fixed in review round 1 (was: "possible pre-existing defect outside this part"):** `apps/api/src/notes/note-shares.controller.ts` declared `note.read` on `PUT /shares/{userId}`, a mutation, while `GET`/`DELETE` declared `note.update`. Because a read-class action is what `decideApiKey` consults, a `read`-scope key could create a delegation grant. The PUT now declares the same management action as its siblings. The general form of the bug — a mutating route whose declared action is read-class, which for an API key is the ONLY scope check on the path because the service's own re-check runs as the key's creator — is now closed at the source: `ApiKeyRouteGuard` refuses any non-safe HTTP method from a key that holds neither `write` nor `admin`.
- Deferred by design, do not build here: `actor_api_key_id` on `audit_logs`; Redis-backed cluster-wide rate limiting (still the Part 5 in-process store, so limits are per API process); API-key access to tRPC (permanently out of scope); per-key scope narrowing below workspace level; key rotation/edit endpoints. The unused `Paginated<T>` in `shared-types/common.ts` is deliberately left alone.
- `last_used_at` writes one `UPDATE` per request that usually matches zero rows; the marked upgrade path is a Redis-batched flush if a key ever gets hot.

## Handoff Notes

**For Part 66 (webhooks), the extension points are deliberate:**
- `apps/api/src/openapi/openapi.routes.ts` is a plain exported map keyed `"<METHOD> <path>"`, grouped by resource. Add webhook entries directly; the contract test fails in both directions if the map and the router disagree.
- `docs/API.md` has a `## Resources` area of uniform `###` subsections with an HTML comment marking where a new resource section goes.
- The settings page renders `{canManage ? <ApiKeys workspaceId={workspace.id} /> : null}` with no wrapper, so `WebhookSettings` is a second identical line beneath it.
- `decideApiKey` already treats `webhook.*` as an admin-scope action, and `webhook` already exists as an authorization action set and resource kind.

**Fragile assumptions:**
- The pre-guard ordering in `main.ts` is load-bearing: actor → trusted principal → synthetic principal. The trusted principal must exist before the global `RateLimitGuard` runs, and installing the auth principal makes any later `AuthService.authenticate` memo-return *before* its own `setTrustedPrincipal({kind:"user"})`, so the api-key tier is never overwritten. Do not reorder. **Round-1 correction:** the memo-return this depends on did not actually happen — `authenticate()` returned `null` on `this.auth === null` *before* consulting the memo, and Better Auth is null on any deployment with `FEATURE_REDIS_ENABLED=false`, so every API-key request 401'd there. The memo check now runs first, which is the whole reason the pre-guard's synthetic principal survives. `advanced-auth.test.ts` pins it.
- `docs/openapi.json` is generated, not authored. Regenerate after any route or schema change, and build `packages/shared-validators` first — a stale `dist/` silently produced a document with missing bodies and schemas during implementation, which is why `assertDeclaredSchemas()` now throws instead of emitting a lying document.
- `getApiKeyActor` is imported from the deep path `../api-keys/api-key-context` in `auth.service.ts` and `authorization-http.guard.ts` to avoid a module cycle through `ApiKeysModule → AuthModule`.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-18 | Claude Opus 5 lead agent | Initial record |
| 2026-08-18 | Claude Opus 5 fix agent | Review round 1 fixes. Corrected the false "an admin key can mint successor keys" limitation — the freshness gate makes every high-risk action unavailable to a key. `PUT /shares/{userId}` now declares the management action, and `ApiKeyRouteGuard` refuses unsafe HTTP methods from read-only keys, closing the whole read-class-action-on-a-mutation class. `AuthService.authenticate` checks the request memo before the Better Auth availability guard. `api-keys.e2e.test.ts` restructured around the gate (mint/revoke through the service with a fresh principal; 403 asserted over REST) and now cleans up its seeded rows. State set to In progress pending re-review. |
| 2026-08-19 | Claude Fable 5 main session | Review round 2 + finalization. ADR 0013 settles the success-payload shape (bare payloads; errors alone enveloped) — six e2e assertions and `docs/API.md` aligned; `docs/openapi.json` Prettier-ignored (generator formatting authoritative). Full gate green: format/lint/type-check/test/build/test:ci, `api-keys.e2e` 16/16, `openapi.contract` 9/9. State set to Complete. |
