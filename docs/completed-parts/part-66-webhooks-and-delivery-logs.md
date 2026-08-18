# Part 66 — Implement webhooks and delivery logs

## Status

- **State:** Complete — two review rounds passed; full quality gate green on 2026-08-19
- **Completed on:** 2026-08-18
- **Implemented by:** Lead part engineer coordinating five bounded subagents (contracts, foundation/queue-core, primitives, core backend, docs, tests) under the Synchronous Delegation Protocol
- **Plan reference:** `Plan.md`, Part 66
- **Related records:** `part-65-public-rest-api-api-keys.md` (REST surface, API-key auth, OpenAPI generator), `part-62-*` / `part-64-*` (export worker — the failure-philosophy precedent), ADR 0006 (background workers, after-commit dispatch), ADR 0007 (webhook model), ADR 0009 (tenant scoping)

## Objective

Deliver outbound webhooks end to end: workspace-scoped endpoints with encrypted, shown-once signing secrets; signed, bounded, retried HTTP delivery of five domain events; an SSRF-contained HTTP client; an immutable per-attempt delivery log with an admin replay; a REST management surface; and a workspace-settings UI. Part 18 shipped the tables and ADR 0007 the model; nothing had ever written to them.

## Implemented Work

- **Event sourcing via a dedicated `webhook.deliver` outbox intent**, not a handler on the existing `note.*` / `project.*` job types. One intent per (endpoint × event), committed inside the mutation's own transaction and dispatched only after commit (ADR 0006).
- **Three one-line producer call sites**, all inside existing transactions: `NotesService.recordMutation` (`note.created|updated|deleted`), `ProjectsService.recordMutation` (`project.created`), and `MembershipsService.accept` guarded on its existing `joined` boolean (`member.joined`). The producer filters non-subscribable events *before any SQL*, so `note.moved`, `folder.*` and `project.archived` cost zero round trips on the mutation hot path.
- **A five-attempt, per-endpoint retry budget** delivered by two additive queue-core changes rather than a config change.
- **A layered SSRF guard** (scheme allow-list, credential rejection, hostname deny-list, `net.BlockList` address filter, pre-flight DNS, and a connect-time re-check), each layer with its own test.
- **An HTTP client built on `node:https.request` with a custom `lookup`** — no new dependency, no redirect following, a wall-clock timeout, and an 8 KB read cap.
- **AES-256-GCM secret storage** with AAD binding the ciphertext to its row, and a raw secret returned by exactly two routes.
- **A synchronous verification challenge**, an eight-route REST surface, an immutable per-attempt log, an admin replay, and a `WebhookSettings` settings island.

## Important Decisions

- **Dedicated intent over subscribing to existing domain events.** `QueueHandlerRegistry.register` allows exactly one handler per job type, so subscribing would permanently claim four shared types for one feature; and a shared job means one BullMQ retry budget across every endpoint, letting one dead receiver drag healthy ones through retries. One intent per (endpoint × event) gives each endpoint an independent budget. Matches the four existing precedents (`note.search.sync`, `notification.mention`, `email.deliver`, `export.generate`). The pre-existing `*-domain-events` outbox rows stay unhandled and pending — ADR 0006's rollout gate working as designed.
- **`occurredAt` is the one non-identifier payload field.** A deletion's timestamp is not recoverable from the row afterwards. It is schema-validated and covered by `payload_hash`, so it is a bounded, deliberate exception to ADR 0006's identifier-only rule, not a slip. Everything else — title, status, role — is re-read from PostgreSQL by the handler at delivery time.
- **`node:https.request` over `fetch`.** Pinning the resolved IP while keeping TLS SNI and certificate validation correct is impossible with `fetch` without importing `undici`; rewriting the URL to an IP literal breaks certificate validation. `http.request` also never follows redirects and supplies `req.setTimeout` and a byte cap for free.
- **Creator-scope re-authorization.** The worker opens a finite system authority (`workspace.read` only, deliberately unable to read a note) and then re-authorizes the endpoint's `created_by_id` against the **live** resource with `authorizeUserJob`. A restricted-project note therefore never reaches an endpoint whose creator cannot read it; denial records `failed` / `resource_forbidden`.
- **Divergence from Part 61's "ambiguous acceptance never auto-retries".** Part 61 refuses to auto-retry an SMTP send whose acceptance is ambiguous, because a duplicate email cannot be withdrawn. An HTTP delivery **is** safely retryable: it carries a stable `X-Notted-Event-Id` that lets a receiver deduplicate, and delivery is explicitly at-least-once. Retrying here is therefore correct where retrying there was not.
- **Nothing dead-letters for an ordinary bad receiver.** A retryable failure on the final attempt records `failed` and *returns*, so the intent completes. The DLQ stays reserved for platform faults, matching `export.worker.service.ts`.
- **`event_id` has no foreign key to `job_outbox`.** Outbox rows are prunable and a FK would block pruning. A pruned intent yields a clean 409 at replay time instead.
- **Replay keys differ from original keys.** Originals use `webhook-deliver:<webhookId>:<eventId>`; replays use `webhook-deliver:retry:<webhookId>:<eventId>:<newIntentId>`, so an admin can replay the same event more than once while `onConflictDoNothing` still makes a retried transaction a no-op.
- **Zero authorization changes.** Verified, not assumed: `webhook.list|create|update|delete|redeliver`, the `webhook` resource kind, the `HIGH_RISK_ACTIONS` membership, and the editor/viewer denials all already existed from earlier parts.

## Files and Components

| Path | Purpose |
|---|---|
| `packages/shared-types/src/webhook.ts` | New. Paths, event catalog, endpoint/delivery/result types, closed error-code set. |
| `packages/shared-validators/src/webhook.schema.ts` (+ `.test.ts`) | New. Request/response schemas. `webhookUrlSchema` is **syntax only**. |
| `packages/shared-types/src/api.ts` | +3 `ApiErrorCode` values. |
| `apps/api/src/database/schema/webhooks.ts` | `webhookDeliveries.eventId` + `(webhook_id, event_id)` index. |
| `apps/api/src/database/migrations/0020_happy_epoch.sql` | New. Adds `event_id`, backfills, drops the default. |
| `apps/api/src/queue/job-contracts.ts` | `OutboxJobDefinition.maximumAttempts?`; `QueueJobContext.attempt` / `.maximumAttempts`. |
| `apps/api/src/queue/queue-infrastructure.service.ts` | `publish()` honours the per-definition attempt budget. |
| `apps/api/src/queue/job-registry.ts` | `WEBHOOK_DELIVER_JOB_DEFINITION` (`maximumAttempts: 5`, `authority: "system"`). |
| `apps/api/src/webhooks/webhook-signature.ts` | Pure. Body serialization, HMAC, `t=…,v1=…` header, constant-time verify. |
| `apps/api/src/webhooks/webhook-url-guard.ts` | Pure. SSRF layers L1–L6. |
| `apps/api/src/webhooks/webhook-sender.ts` | The HTTP client. No redirects, timeout, byte cap, closed error codes. |
| `apps/api/src/webhooks/webhook-secret.service.ts` | AES-256-GCM pack/unpack with row-bound AAD. |
| `apps/api/src/webhooks/webhook-delivery.producer.ts` | Transaction-scoped fan-out + replay scheduling. |
| `apps/api/src/webhooks/webhook-delivery.worker.service.ts` | Re-reads, re-authorizes, signs, sends, records one attempt row. |
| `apps/api/src/webhooks/webhooks.service.ts` | Tenant-scoped CRUD, verification challenge, rotation, replay. |
| `apps/api/src/webhooks/webhooks.controller.ts` | Eight routes, every one `@RequireAuthorization`-decorated. |
| `apps/web/src/lib/webhooks/requests.ts` | Browser client with hand-written trust-boundary parsers. |
| `apps/web/src/components/workspaces/WebhookSettings.tsx` | Settings island, rendered beside `<ApiKeys />` under `canManage`. |
| `docs/API.md`, `docs/openapi.json`, `apps/api/src/openapi/openapi.routes.ts` | Public integration documentation. |

## Database and Data Changes

Migration **`0020_happy_epoch.sql`**: adds `webhook_deliveries.event_id uuid NOT NULL` and index `webhook_deliveries_webhook_event_idx (webhook_id, event_id)`.

The generator emitted a bare `ADD COLUMN … NOT NULL`, which aborts on a non-empty table. It was hand-edited to the standard two-step — `ADD COLUMN … DEFAULT gen_random_uuid() NOT NULL`, then `ALTER COLUMN … DROP DEFAULT` — so existing rows backfill with distinct ids and the end state still matches the `0020` snapshot exactly (no drift, so the next `db:generate` emits nothing spurious). The Drizzle schema deliberately keeps `event_id` **required at insert**: a permanent `.defaultRandom()` would make optional a value whose whole purpose is being stable across retries. Hand-editing a generated migration with an explanatory header is precedented (0013, 0014).

Rollback: dropping the column and index is safe; no other table references it.

## API, Configuration, and Operational Changes

Eight REST routes under `/api/v1/workspaces/:workspaceId/webhooks` (list, create, patch, delete, rotate-secret, verify, deliveries, retry). No tRPC subrouter. No `Idempotency-Key` requirement. `DELETE` answers **200 with a body**, matching `api-keys` and `tags`.

New job type `webhook.deliver` on source queue `webhook-deliver`, riding the existing `notted-default` lane with `maximumAttempts: 5`.

Two new environment variables, both optional and API-side: `WEBHOOK_REQUEST_TIMEOUT_MS` (default 10000, range 1000–30000) and `WEBHOOK_ALLOW_INSECURE_URLS` (default false, **forced false when `NODE_ENV=production` — not read there at all**). The flag unblocks the `http:` scheme and loopback **IP literals** only; it does **not** unblock the hostname `localhost`, which the L3 deny-list refuses unconditionally, so a local receiver must be addressed as `http://127.0.0.1:<port>/…`. Defaults are safe in both development and production.

`compose.yaml` passes `WEBHOOK_ALLOW_INSECURE_URLS` through the `x-api-environment` anchor, which `api-e2e` inherits by merge key.

## Security and Tenant-Isolation Notes

- **SSRF containment is layered and each layer is separately tested** (Part 63's explicit review lesson: a comment is not containment). Scheme allow-list; credential rejection; hostname deny-list including Notted's own hostnames; a `net.BlockList` covering the documented v4/v6 private, loopback, link-local, CGNAT, multicast and documentation ranges with `::ffff:` unmapping; a pre-flight DNS check that rejects if **any** returned address is blocked (defeating split round-robin); and a **connect-time re-check** so a TTL-0 rebind between validation and connect cannot land on a private IP.
- **Tenant scope**: every statement carries `whereWorkspace`, every single-row statement also pins the id, and a cross-tenant read answers **404, never 403**.
- **Secrets**: AES-256-GCM with AAD `notted:webhook-secret:v1:<webhookId>:<keyVersion>`, so a ciphertext copied to another row fails to decrypt. The raw secret leaves the process only in the create and rotate responses; the DTO projection excludes the column by construction. The OpenAPI contract test now enforces an explicit allow-list of the three routes that may expose a `secret`, and asserts `encryptedSecret` / `encryptionKeyVersion` appear nowhere in the document.
- **Redaction**: `error_message` comes from a closed code set — never Node's `error.message`. Stored snippets are text/JSON only, control-stripped, ≤500 chars. **The endpoint URL is never logged** (admin-supplied, routinely carries a bearer token in path or query); nor is the signature, body, or secret. Audit metadata records the **hostname only**.
- **Payload minimization**: identifiers and cheap metadata only — never note content, never an email address. Note `title` and project `name` are included as the one human-readable field that makes a delivery legible.

## Verification Evidence

Implementation-wave checks are listed first (what the implementers actually ran); the authoritative final gate follows. Two independent review rounds ran the full gate serially; round 2 plus the post-ADR-0013 run on 2026-08-19 (dev stack up, `DATABASE_URL` exported, migration `0020` applied to `notted_dev`) delivered the final results:

| Final gate check | Result | Notes |
|---|---|---|
| `pnpm format:check` / `pnpm lint` / `pnpm type-check` | **Pass** | Lint at `--max-warnings 0` |
| `pnpm test` | **Pass** | api 178 / web 133 / validators 14 / types 4 |
| `pnpm build` | **Pass** | CI `NEXT_PUBLIC_*` production values |
| `pnpm test:ci` | **Pass** | Exit 0; all coverage thresholds met (api 84.48% stmts / 76.11% branch) |
| `apps/api/test/webhooks.integration.test.ts` | **Pass** | 10/10 with the dev `api` container running (the very exposure that caused the round-1 duplicate-row failure); silent-receiver test stable across 3 runs |
| `apps/api/test/webhooks.e2e.test.ts` | **Pass** | 11/11 — editor/viewer 403, cross-tenant 404, secret shown exactly once, `WEBHOOK_NOT_VERIFIED`, freshness-gate 403 for api-key mutations |
| Migration `0020` executed against PostgreSQL | **Pass** | Applied to `notted_dev`; `event_id uuid NOT NULL` + `webhook_deliveries_webhook_event_idx` verified via `psql \\d` |
| `pnpm --filter @notted/api openapi:generate` | **Pass** | Deterministic; matches the committed document (now Prettier-ignored, generator output authoritative) |

Implementation-wave record (kept for history):

| Check | Result | Notes |
|---|---|---|
| `npx tsc --noEmit -p apps/api/tsconfig.json` | **Pass** | Clean. Started at 63 errors — see below. |
| `npx tsc --noEmit -p apps/web/tsconfig.json` | **Pass** | Clean after rebuilding `shared-types`. |
| `npx tsc --noEmit` (`packages/shared-validators`) | **Pass** | Clean after removing a `URL` global the package's lib does not provide. |
| `npx vitest run src/webhooks` (apps/api) | **Pass** | 9 files, **221 passed** (includes 59 service tests). |
| `npx vitest run test/openapi.contract.test.ts` | **Pass** | 9 passed, after updating the secret-exposure allow-list. |
| `npx vitest run src/webhook.schema.test.ts` (validators) | **Pass** | 13 passed. |
| `npx vitest run src/api-paths.test.ts` (shared-types) | **Pass** | 5 passed. |
| `npx vitest run src/lib/webhooks …/webhook-settings.test.tsx` (web) | **Pass** | 30 passed. |
| `pnpm --filter @notted/api openapi:generate` | **Pass** | 8 operations across 6 paths under `/api/v1`. |
| `pnpm --filter @notted/api db:generate` | **Pass** | Emitted `0020`, journal entry, snapshot. |
| `docker compose config` | **Pass** | Valid (run by the foundation agent). |
| Queue/config/maintenance focused suites | **Pass** | 39 + 7 + 4 + 2 passed (run by the foundation agent). |
| `apps/api/test/webhooks.integration.test.ts` | Not run in this wave | Green in the final gate above |
| `apps/api/test/webhooks.e2e.test.ts` | Not run in this wave | Green in the final gate above |
| Migration `0020` executed against PostgreSQL | Not run in this wave | Verified in the final gate above |
| `pnpm lint` / `format:check` / `test` / `test:ci` / `build` | Not run in this wave | Green in the final gate above; Playwright deliberately out of scope for this part |

**Defects found and fixed during reconciliation** (each was a genuine break, not a cosmetic tidy):

1. `webhook.schema.ts` used the `URL` global, which does not exist under this package's `"lib": ["ES2022"]` — it broke `type-check` and `build` for the whole repo. Replaced with zod's own `z.url({ protocol })` plus one regex for embedded credentials.
2. Making `QueueJobContext.attempt` / `.maximumAttempts` required broke **62 call sites across 8 existing test files** that the foundation agent did not sweep. All fixed.
3. `webhooks.controller.test.ts` asserted `await expect(...).rejects` on handlers that validate **synchronously**, so the throw escaped before a promise existed — 6 false failures. Rewritten to the thunk form the sibling `api-keys.controller.test.ts` uses.
4. The OpenAPI contract test's secret-exposure allow-list rejected the two new secret-minting routes. Widened deliberately, with the allow-list's purpose documented.
5. `deleteWebhook` in the web client hand-rolled a `fetch` on the false premise that `DELETE` answers 204. It answers 200 with a body; ~35 lines replaced with the standard `requestJson` path.
6. `docs/environment.md` claimed the insecure-URL flag unblocks `localhost`; the guard blocks that hostname unconditionally. Corrected.
7. **Pre-existing, unrelated to Part 66**: `apps/api/src/api-keys/api-keys.service.test.ts` (Part 65, untracked) failed `type-check` on a literal-type widening. Fixed one line, because leaving it meant the reviewer could not type-check anything.

## Known Limitations and Follow-up Work

- **The two DB-backed suites have never been executed.** They are the primary evidence for three Plan clauses (timeouts do not block writes, retries are idempotent, private IPs rejected). Run them first.
- **CONFIRMED in review round 1, and it is the shipped policy:** five of the eight routes are unreachable by *any* API key. `webhook.create|update|delete` are `HIGH_RISK_ACTIONS`, and the synthetic API-key principal is `isFresh: false`, so the freshness gate fires on the service-layer `authorizeUser` *after* `decideApiKey` has already passed the guard — 403 `RECENT_AUTHENTICATION_REQUIRED`. The same reasoning did make Part 65's `api-keys.e2e.test.ts` red; that suite has been restructured around the gate rather than the gate being weakened. See `part-65-public-rest-api-api-keys.md` → Known Limitations for the full statement.
- **Both comment-vs-code mismatches in `webhooks.service.ts` are now fixed in the COMMENT, with the behaviour left as it is** (the tests assert what the code does):
  1. `create`'s endpoint cap is best-effort under concurrency and now says so. Two concurrent creates at READ COMMITTED can both count nine and both commit a tenth. It is a fair-use guard on an admin-only action, not an invariant; making it exact would put lock contention and retry handling on every create. The named upgrade path is a counter column with a `CHECK`, not a wider isolation level.
  2. `verify` writes the audit row even when the conditional `is_verified` UPDATE matched zero rows, and that is intended: a re-verification really did send a live challenge and read the answer, so it belongs in the audit trail. The audit records "an admin verified this endpoint", not "the flag changed".
- **Outbound-request oracle, bounded**: `POST /webhooks/{id}/verify` makes the server issue an HTTP request to an admin-chosen URL and returns the status code and a ≤500-character response snippet. That is a deliberate, contained side channel — admin-only (`webhook.update`, and unreachable by API keys per the gate above), restricted to the same layered SSRF guard as delivery (public addresses only, no redirects, no credentials in the URL), and the snippet is text/JSON only and control-stripped. It is the price of letting an admin diagnose their own endpoint; the residual risk is that a workspace admin can use the server to probe reachability of arbitrary PUBLIC hosts and read a truncated response.
- Rotation signs in-flight retries with the **new** secret. Documented, not solved; receivers should accept both briefly during a rotation.
- `graphify update .` was not run — several agents were writing concurrently.
- **Deferred by design, do not build without a plan part**: per-event payload scopes/filters; endpoint-level rate limiting; automatic disable after N consecutive failures; a separate `test-send` endpoint (`POST /verify` is the re-runnable ping); bulk secret re-encryption on key rotation (Part 67); a `job_outbox` retention policy for webhook intents.
- `// ponytail:` markers left deliberately: the per-mutation endpoint SELECT (add a cache only if a profile shows it) and the shared `notted-default` lane (split only if a noisy tenant starves email/mentions).

## Handoff Notes

- **`webhookBody`'s key order is part of the signed contract.** Reordering that object literal silently invalidates every receiver's signature. The same applies to each event's `data` literal.
- **Serialize once.** The exact string that is signed must be the exact string that is sent; never re-serialize between signing and writing.
- **Every `webhookDeliveries` insert must supply `eventId`** — it is `NOT NULL` with no default.
- **Every new webhook route needs an `OPENAPI_ROUTES` entry and a `@RequireAuthorization` decorator.** The contract test enforces the first; Part 65's default-deny `ApiKeyRouteGuard` makes the second the difference between a working route and a 403 for API keys.
- `docs/openapi.json` is **generated**. Never hand-edit it; run `pnpm --filter @notted/api openapi:generate`, which needs a built `packages/shared-validators`.
- Local receivers must be addressed as `127.0.0.1`, never `localhost`.
- `logger.warn(metadata, …)` silently discards fields in this codebase — use `logger.warning`.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-18 | Lead part engineer | Initial record |
| 2026-08-18 | Claude Opus 5 fix agent | Review round 1 fixes. Confirmed and restated the API-key freshness gate. Sender now latches the timeout outcome BEFORE destroying the socket and disables Happy Eyeballs, so a silent receiver classifies `timeout` deterministically instead of racing its own teardown to `connection_failed`. `guardedLookup` honours the requested address family. SSRF v4 list gained `192.88.99.0/24`; `unmapIpv4` now covers the v4-compatible `::a.b.c.d` / `::x:y` forms. Endpoint-cap and verify-audit comments corrected to match behaviour. Verify endpoint added to the residual-risk list. `webhooks.integration.test.ts` now claims its own outbox intent so a running development API container's dispatcher cannot deliver the same event a second time. Migration 0020's comment now states the full-table-rewrite cost. State set to In progress pending re-review. |
| 2026-08-19 | Claude Fable 5 main session | Review round 2 + finalization. Non-compressed v4-compatible IPv6 spellings denied via an explicit `::/96` check (canonical `::`/`::1` carve-outs keep loopback relaxation intact); a family miss now reports `ENOTFOUND` rather than a false SSRF denial. Envelope assertions aligned with ADR 0013. Full gate green: `webhooks.integration` 10/10 (dev API container running), `webhooks.e2e` 11/11, migration 0020 verified applied. State set to Complete. |
