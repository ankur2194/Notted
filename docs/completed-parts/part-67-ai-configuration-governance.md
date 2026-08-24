# Part 67 — Build provider-neutral AI configuration and governance

## Status

- **State:** In progress — implementation complete, quality gates deferred to the session reviewer
- **Completed on:** Not completed
- **Implemented by:** Claude Code lead-part-engineer session, with three delegated specialist agents (providers, service layer, frontend)
- **Plan reference:** `Plan.md`, Part 67
- **Related records:** [Part 18](part-18-operations-integration-tables.md) (owns the `ai_provider_config` / `ai_usage` schema and names Part 67 as the sole decryptor), [Part 50](part-50-establish-bullmq-queues-workers.md) (`AiProviderRateLimiterService`), [Part 53](part-53-embeddings-semantic-search.md) (the embedding adapter this deliberately does not disturb), [Part 66](part-66-webhooks-and-delivery-logs.md) (the AES-256-GCM blob format copied here)

## Objective

Give a workspace a provider-neutral AI configuration it controls itself: choose OpenAI, Anthropic, or nothing at all; store the provider credential encrypted and never return it; meter what AI costs; and refuse — fail closed — every request that is not covered by an explicit, consented, in-budget configuration. Parts 68–70 build summarize/continue/rewrite, meeting extraction, auto-tagging and grammar checking directly on this module's provider, governance and credential seams, so the shape of those seams is the deliverable as much as the admin screen is.

## Implemented Work

- **Shared contracts.** `packages/shared-types/src/ai.ts` adds `AI_API_PATHS`, `AI_PROVIDER_NAMES`, `AI_FAILURE_CODES`, `AI_PROVIDER_ERROR_CODES` and the `AiConfigView` / `AiUsageSummary` / `AiStatus` projections. `packages/shared-validators/src/ai.schema.ts` adds `aiConfigUpdateSchema` (a whole-configuration replacement, not a patch) plus the response and query schemas, and owns the canonical defaults `AI_DEFAULT_DAILY_TOKEN_QUOTA` (50 000) and `AI_DEFAULT_RATE_LIMIT_PER_MINUTE` (10). Both barrels export them.
- **Two authorization actions.** `ai.configure` (owner/admin, in `HIGH_RISK_ACTIONS`) and `ai.use` (owner/admin/editor, never viewer), both against the `workspace` resource kind. The exhaustive table-driven policy suite covers them automatically; two dedicated cases were added for the fresh-session requirement and for the API-key rule below.
- **Credential at rest.** `AiCredentialService` is a deliberate near-copy of `WebhookSecretService`: AES-256-GCM, one packed base64 column (`[0..12)` nonce, `[12..28)` tag, `[28..)` ciphertext), AAD `notted:ai-credential:v1:{configId}:{keyVersion}`. There is one blob format in this codebase to audit rather than two.
- **Provider adapters, zero SDKs.** `providers/ai-chat-provider.ts` defines `AiChatProvider.stream(request, signal): AsyncIterable<AiChatEvent>` and `AiChatProviderError`; `providers/sse-stream.ts` is a shared line-buffered SSE reader plus the common fetch/error/body-cancel discipline; `openai-chat.provider.ts` and `anthropic-chat.provider.ts` are hand-rolled `fetch` against `/v1/chat/completions` and `/v1/messages`; `AiChatProviderRegistry.resolve()` maps a provider name to an adapter, with `"disabled"` resolving to `null` so the caller must fail closed rather than guess.
- **The governance gate.** `AiGovernanceService.acquire()` runs seven ordered checks — deployment kill-switch, workspace configuration, consent, daily token quota, the workspace's own Redis fixed window, the deployment-wide per-provider allowance, then credential decryption — and returns an `AiRuntimeGrant` carrying the decrypted key and an **exactly-once** `recordUsage()`. Quota and rate-limit refusals write their own `rate_limited` usage row, so an admin sees a workspace hitting its ceiling rather than AI mysteriously not working.
- **The admin surface.** `AiService` owns config read/write (redacted), the usage roll-up, and the deliberately thin member-facing `getStatus`. `AiController` exposes `GET`/`PUT /ai/config`, `GET /ai/usage` and `GET /ai/status` under `workspaces/:workspaceId/ai`, all four documented in `OPENAPI_ROUTES` and regenerated into `docs/openapi.json`.
- **The settings UI.** `AiSettings.tsx` follows the `ApiKeys.tsx` house form pattern (local state, zod `safeParse`, failure-kind copy table, no react-hook-form, no `toast()`): a native `fieldset`/`legend` provider radio group, a password key field whose help text reflects `hasCredentials`, the required consent checkbox with the exact data-retention sentence, quota and rate controls, and a usage table with an empty state. Mounted behind the existing `canManage` gate on the workspace settings page.

## Important Decisions

- **No AI SDK, by ADR 0008 and by precedent.** Adding `openai` or `@anthropic-ai/sdk` would import a retry policy, a telemetry client and a logger we do not control onto the single code path that handles customer note text and a customer API key. The Part 53 embedding adapter already set the hand-rolled-`fetch` precedent. Zero new npm dependencies were added anywhere in this part.
- **Provider errors are derived from the HTTP status and nothing else.** A provider's error body echoes the request back — the prompt, and with it note content — and often names the account. `AiChatProviderError.fromStatus()` is the only constructor path from a response; the body is never read on the failure path, never logged, and never propagated. A provider test feeds a marker string in the error body and asserts it appears in neither the message nor `String(error)`.
- **`FEATURE_AI_ENABLED` is a kill-switch, never a credential source.** The workspace row is the only place a key comes from. There is deliberately no "fall back to the deployment's own OpenAI key" path, so one workspace can never spend the operator's credential.
- **Every branch fails closed.** A missing row, an unparseable settings blob, an absent Redis client, a `redis.eval` that throws, and a quota query that throws all REFUSE. This is the opposite of the usual availability instinct and is deliberate: the thing being rationed is a metered third-party API, and an outage is exactly when a retry storm arrives.
- **Consent is checked twice, and the second check is the authoritative one.** `aiConfigUpdateSchema` refuses to enable AI without it, but that guards a form. `AiGovernanceService` re-reads it immediately before note content would leave our servers, which is the only check that still holds if the settings blob is hand-edited during an incident.
- **No API key can reach any `ai.*` action, at any scope.** `decideApiKey` denies on the `ai.` prefix before scope evaluation. Configuring AI writes provider key material and using AI spends money against a credential the key's holder did not supply; neither belongs on a long-lived integration token nobody is watching. This is stricter than the `webhook.*`/`settings.*` precedent, which merely requires the `admin` scope.
- **Rotation is lazy, with no batch job.** A row moves onto the active key the next time an admin saves the form — the one moment we are certain nobody is mid-request against it. Decryption always uses the version the ROW names, so pre-rotation rows keep working in the meantime.
- **Disabling clears the ciphertext.** A dangling credential for a provider nobody selected is a secret with no owner and no expiry.
- **A provider switch needs a new key — but only when there is an old key to carry across.** The stored ciphertext is an OpenAI key or an Anthropic key, and carrying it over would store a credential that can only ever fail authentication, silently, until the first request. The delegated implementation refused *any* provider change without a key, including leaving `disabled`, which would have stopped an admin selecting a provider before fetching its key; narrowed during integration to fire only when a credential is actually stored, with a test pinning the loosened branch.
- **`hasCredentials` is computed, never projected.** On the read path it is a SQL `is not null`; on the write path the service already knows the answer because it just decided what the column becomes. The shared selection object contains no ciphertext key at all, so a leak would require adding one rather than forgetting to remove one. The write path was changed during integration to stop putting a `sql<boolean>` expression inside `.returning()`, whose accepted field shapes are narrower than `.select()`'s and for which this repository has no precedent.
- **`ApiErrorCode` was widened by six members.** `ApiHttpException` takes a closed literal union, so the AI codes could not otherwise compile. They were minted rather than folded into `FORBIDDEN`/`CONFLICT`/`RATE_LIMITED` because each has a different remedy — turn the feature on, configure a provider, accept the data notice, wait for the quota to reset, slow down — and the client renders the remedy, not the status.
- **The retry delay does not ride in the error envelope.** `ApiError.details` is typed as a list of validation issues; widening it would cost every client a type change for one number. `AiGovernanceRefusal.retryAfterMs` carries it instead, on a subclass that is still an `ApiHttpException`, so the exception filter is unchanged and Part 68 can set `Retry-After` from it.
- **An unknown model yields a `null` cost, not a guess.** `AI_MODEL_PRICES` is a short static table; `ai_usage.cost_micros` is nullable precisely so the system can abstain. Token counts are always recorded either way, so a missing price never loses the underlying measurement.

## Files and Components

| Path | Purpose |
|---|---|
| `packages/shared-types/src/ai.ts` | Path builders, provider/failure/error-code vocabularies, and the three safe projections. No field exists that could carry a credential or a prompt. |
| `packages/shared-validators/src/ai.schema.ts` | `aiConfigUpdateSchema` with its three enable-preconditions, the response/query schemas, and the canonical defaults. |
| `packages/shared-types/src/api.ts` | `ApiErrorCode` widened by the six AI envelope codes. |
| `apps/api/src/authorization/authorization.contracts.ts` | `ai.configure` and `ai.use` added to `AUTHORIZATION_ACTIONS`. |
| `apps/api/src/authorization/authorization-policy.service.ts` | Resource-kind mapping, role branches, `HIGH_RISK_ACTIONS` membership, and the blanket API-key denial for `ai.*`. |
| `apps/api/src/ai/ai.constants.ts` | Audit vocabulary, the `anthropic`→`claude` limiter bridge, Redis key prefix, price table, `estimateCostMicros`, and the defensive `parseAiSettings` / `startOfUtcDay` helpers both services must agree on. |
| `apps/api/src/ai/ai-credential.service.ts` | AES-256-GCM encrypt/decrypt with AAD row binding, and `activeKeyVersion` for lazy migration. |
| `apps/api/src/ai/ai-governance.service.ts` | The fail-closed gate, `AiRuntimeGrant`, exactly-once usage recording, and `AiGovernanceRefusal`. |
| `apps/api/src/ai/ai.service.ts` | Config CRUD with redaction and key lifecycle, the usage roll-up, and the member-facing status. |
| `apps/api/src/ai/ai.controller.ts` | The four REST routes, each with `@RequireAuthorization`; `PUT`/`GET usage` on the `sensitive` rate-limit tier. |
| `apps/api/src/ai/ai.module.ts`, `index.ts` | Wiring; exports `AiService`, `AiGovernanceService`, `AiCredentialService`, `AiChatProviderRegistry` for Part 68. |
| `apps/api/src/ai/providers/ai-chat-provider.ts` | The provider-neutral streaming seam and the status-only error type. |
| `apps/api/src/ai/providers/sse-stream.ts` | Line-buffered SSE reader plus the shared open/narrow wire helpers. |
| `apps/api/src/ai/providers/openai-chat.provider.ts`, `anthropic-chat.provider.ts` | The two adapters. Neither ever sends `tools`. |
| `apps/api/src/ai/providers/ai-provider.registry.ts` | Name → adapter, with `"disabled"` → `null`. |
| `apps/api/src/openapi/openapi.routes.ts`, `docs/openapi.json` | Four documented routes; the committed document regenerated. |
| `apps/web/src/lib/ai/requests.ts` | Browser-side config/usage calls, each response `safeParse`d against the shared schema. |
| `apps/web/src/components/workspaces/AiSettings.tsx` | The admin settings section. |
| `apps/web/src/app/(dashboard)/workspaces/[workspaceId]/settings/page.tsx` | Mounts the section inside the existing `canManage` gate. |
| `apps/api/test/ai.integration.test.ts` | Live-PostgreSQL suite: encryption at rest, rotation, role denials, two-tenant usage isolation, and every governance refusal. |

Colocated unit suites: `ai-credential.service.test.ts`, `ai-governance.service.test.ts`, `ai.service.test.ts`, `ai.controller.test.ts`, `providers/sse-stream.test.ts`, `providers/openai-chat.provider.test.ts`, `providers/anthropic-chat.provider.test.ts`, and `apps/web/src/components/workspaces/ai-settings.test.tsx`.

## Database and Data Changes

**No migration.** `ai_provider_config` and `ai_usage` are used exactly as Part 18 shipped them, including the `settings` jsonb shape that record documented (`dailyTokenQuota`, `rateLimitPerMinute`, `contentConsent`). No seed-data change, no backfill.

`ai_usage` remains append-only and content-free: this part adds no column, and the integration suite asserts that a recorded row carries no prompt-shaped field and no credential (ADR 0007). Retention stays owned by Part 19. Rollback is a code revert; existing rows remain readable as long as their `encryption_key_version` stays present in `DATA_ENCRYPTION_KEYS`.

## API, Configuration, and Operational Changes

Four new REST routes, all under the existing `api/v1` prefix and all documented in `OPENAPI_ROUTES`:

| Route | Action | Notes |
|---|---|---|
| `GET /workspaces/{workspaceId}/ai/config` | `ai.configure` | Never returns the credential. An unconfigured workspace reads as disabled rather than 404. |
| `PUT /workspaces/{workspaceId}/ai/config` | `ai.configure` | `sensitive` tier; whole-configuration replacement; omitting `apiKey` keeps the stored credential. |
| `GET /workspaces/{workspaceId}/ai/usage` | `ai.configure` | `sensitive` tier — it aggregates the whole table over a caller-chosen window. |
| `GET /workspaces/{workspaceId}/ai/status` | `ai.use` | Member-facing: `enabled`, `provider`, `model` and nothing else. |

**No new environment variables.** `FEATURE_AI_ENABLED` (Part 18, default `false`) is reused as the deployment kill-switch, and `DATA_ENCRYPTION_KEYS` (Part 18) supplies the encryption keys. Defaults are safe in both development and production: AI is off deployment-wide by default, off per workspace by default, and unusable without an explicitly stored credential and explicit consent.

No new queue, no new job type, no BullMQ work — every route on this surface is synchronous. `AiModule` imports `RedisModule` directly rather than relying on `QueueModule` re-exporting `REDIS_CLIENT`, which it does not.

Operational note: rotating `DATA_ENCRYPTION_KEYS` requires keeping the superseded version in the list until every workspace has saved its AI configuration once. There is no batch re-encryption job.

## Security and Tenant-Isolation Notes

- **Authorization.** Every handler carries `@RequireAuthorization`; every service method authorizes before any SQL and runs its queries inside `AuthorizationEntryService.run`. `ai.configure` is in `HIGH_RISK_ACTIONS`, so it demands a fresh session. `ai.use` reaches editors but never viewers. No API key can reach either action at any scope.
- **Tenant scoping.** `AiService` scopes every statement with `whereWorkspace`. `AiGovernanceService` deliberately pins `workspace_id` with an explicit `eq` instead, because its callers include a streaming handler and, later, queue workers, where the request-scoped tenant `AsyncLocalStorage` may not be the frame the query runs in — the same guarantee by a route that cannot be lost when the call moves off the request thread. The integration suite proves isolation with alpha and beta usage rows in the same table in the same run.
- **Credential handling.** The plaintext key exists in exactly two moments: the request body that sets it, and the stack of the request that uses it. It is never projected by any read path, never written to an audit row, never logged, and never returned. Ciphertext is bound by AAD to its config row and key version, so a blob copied into another workspace's row fails to decrypt rather than quietly billing that workspace against a key its admin never supplied — asserted directly in the integration suite.
- **Audit.** Configuration writes record provider, model, the booleans and `credentialChanged` — never the key, never a key prefix, never the ciphertext, never the key version. A unit test and an integration test both assert the eight-character head of the key is absent from the serialized metadata.
- **Abuse controls.** Three independent limits stack: the workspace's daily token quota, the workspace's per-minute burst window, and the deployment-wide per-provider allowance. All three deny on failure. `PUT /ai/config` and `GET /ai/usage` sit on the `sensitive` rate-limit tier.
- **Content.** No prompt, note excerpt or model output is stored anywhere by this part, and no provider response body is read on a failure path or written to a log.

## Verification Evidence

**Review #1 (2026-08-24) ran every gate and returned FAIL.** Fixes applied in a follow-up commit for this part: `ai.service.test.ts` `expectNoCredentialLeak` widened from `Readonly<Record<string, unknown>>` to `object` (TS2345, `AiConfigView` has no index signature); `test/ai.integration.test.ts` import order corrected; and `json-repair.ts` `describeIssues` now strips zod path segments to `[A-Za-z0-9_.[\]]` so a future `z.record()` schema cannot inject into the repair prompt. **`apps/api/test/ai.integration.test.ts` has now been executed for the first time: 17 passed, 0 failed** (`pnpm infra:up:ports`, `DATABASE_URL=postgres://notted:notted_dev_password@127.0.0.1:5432/notted_dev pnpm --filter @notted/api exec vitest run test/ai.integration.test.ts`). It covers cross-workspace usage isolation, `ai.configure` denied to an editor, `ai.use` denied to a viewer, and every governance refusal branch. `pnpm --filter @notted/api exec tsc --noEmit` is clean.

**From the implementing session, superseded by the note above:** quality gates for this part were deliberately deferred to the session reviewer and were not run there. This session's mandate was implementation only; `pnpm lint`, `pnpm format:check`, `pnpm type-check`, `pnpm test`, `pnpm test:ci` and `pnpm build` were not executed, and no test in this part has ever been run. Nothing below should be read as evidence that the suites pass.

| Check | Result | Notes |
|---|---|---|
| `pnpm --filter @notted/shared-types build` | Pass | `tsc -p tsconfig.build.json` clean — incidentally type-checks the new `ai.ts` and the widened `ApiErrorCode`. Run only because the OpenAPI generator needs the built package. |
| `pnpm --filter @notted/shared-validators build` | Pass | `tsc -p tsconfig.build.json` clean — incidentally type-checks `ai.schema.ts`. |
| `pnpm --filter @notted/api openapi:generate` | Pass | Wrote `docs/openapi.json`; `git diff --stat` shows 428 insertions and 0 deletions, with the four AI routes present and nothing else drifted. |
| `pnpm exec prettier --write` (new and touched files) | Pass | Formatting normalized. This is the writer, not `format:check`; it is not a gate result. |
| `pnpm lint` | **Not run** | Deferred to the session reviewer. |
| `pnpm format:check` | **Not run** | Deferred to the session reviewer. |
| `pnpm type-check` | **Not run** | Deferred to the session reviewer. The API package was never type-checked; only the two shared packages were compiled. |
| `pnpm test` / `pnpm test:ci` | **Not run** | Deferred to the session reviewer. Every unit suite and `ai.integration.test.ts` is authored but unexecuted. |
| `pnpm build` | **Not run** | Deferred to the session reviewer. |
| Playwright e2e | **Not run** | No spec was written for this part — see follow-ups. |

Specific unexecuted risks the reviewer should look at first: the drizzle `sql` aggregate shapes in `AiService.getUsage`, zod 4's `.catch()` semantics for missing (not merely invalid) fields in `parseAiSettings`, the accessible-name lookups in `ai-settings.test.tsx` that depend on a `<caption>` naming its table, and whether the integration suite's fake Redis reply shape satisfies the real `ioredis` type.

## Known Limitations and Follow-up Work

- **Nothing here has been executed.** The single largest risk in this record.
- **No test-connection endpoint.** An admin cannot confirm a key works without triggering a real AI feature; a wrong key surfaces as a failure at first use. Deliberately skipped; a natural addition once Part 68 has a live call path.
- **No tRPC router.** REST only, matching the decision that `apps/web` has no tRPC client. Not a gap unless a first-party typed client appears.
- **No Playwright e2e spec.** The configure → consent → save → usage journey is unproven in a browser. Candidate for the Part 70 e2e sweep.
- **Naming deviation:** `apps/web/src/lib/ai/` and the AI component placement are not named in `Notted.md`, which describes no frontend AI surface. Recorded here as a deliberate deviation, following the Part 58 precedent.
- **No `fetchAiStatus` wrapper on the client.** Nothing in this part reads `/ai/status`; Part 68 adds the first consumer.
- **Concurrent admin saves race** on the `ai_provider_config` unique index, and one gets a constraint error. Accepted for an admin-only action; an upsert is not available because `ON CONFLICT DO UPDATE` would break the AAD binding.
- **Anthropic error frames map narrowly:** only `overloaded_error` becomes `overloaded`; everything else becomes `network`. Richer retry advice is a Part 68 concern if it wants it.
- **`FormStatus` lacks `aria-atomic="true"`** (it renders `role="status" aria-live="polite"` only). Not patched here because every existing auth form depends on it; worth a one-line change to `form-controls.tsx` in its own right.
- **Server-side prompt/response inspection is impossible by design.** Debugging a bad completion means reproducing it, because nothing is retained. This is ADR 0007 working as intended, not a defect.

## Handoff Notes

**Part 68 builds directly on four exported symbols.** `AiModule` exports `AiService`, `AiGovernanceService`, `AiCredentialService` and `AiChatProviderRegistry`; import the module, do not reconstruct any of them.

The intended shape of a streaming endpoint is: authorize `ai.use` → `AiGovernanceService.acquire({workspaceId, userId, feature})` → catch `AiGovernanceRefusal` and answer JSON **before** switching to SSE → `AiChatProviderRegistry.resolve(grant.provider)` → `provider.stream(request, signal)` → `finally { await grant.recordUsage(outcome) }`. `recordUsage` is idempotent by construction and never throws outward, so a `finally` that races an explicit call is safe and a metering failure cannot fail a request whose answer the user already has.

Fragile assumptions worth knowing before changing this area:

- **The config row id is an input to the encryption, not a result of it.** It is minted with `randomUUID()` before the insert. Anything that lets PostgreSQL's `DEFAULT` assign it breaks every credential in that row, silently, until the next decrypt.
- **`AI_LIMITER_PROVIDER` is the one place** the database's `anthropic` becomes the queue's `claude`. Do not spell either literal at a call site.
- **`parseAiSettings` and `startOfUtcDay` are shared on purpose.** If the admin screen's `tokensUsedToday` and the gate's quota comparison ever use different helpers, the screen and the gate will disagree and the disagreement will look like a bug in whichever one the reader trusts less.
- **Adding a route means adding an `OPENAPI_ROUTES` entry and regenerating `docs/openapi.json`.** `apps/api/test/openapi.contract.test.ts` fails in both directions. Regeneration needs the shared packages built first: `pnpm --filter @notted/shared-types build && pnpm --filter @notted/shared-validators build && pnpm --filter @notted/api openapi:generate`.
- **`ai.integration.test.ts` needs `DATABASE_URL` and the dev stack** (`pnpm infra:up:ports`); without it the suite skips silently rather than failing, which is easy to mistake for a pass.
- **Never send `tools`.** Note text is untrusted input reaching a model, and a model that cannot call a tool cannot be talked into calling one. Both adapters assert the absence of `tools`/`tool_choice`/`functions` in their serialized bodies.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-24 | Claude Code lead-part-engineer session | Initial record. Implementation complete; all quality gates deferred to the session reviewer and unrun. |
| 2026-08-24 | Claude Code review-fix session | Review #1 findings resolved; state still In progress pending Review #2 |
