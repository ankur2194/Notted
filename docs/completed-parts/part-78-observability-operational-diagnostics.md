# Part 78 — Add observability and operational diagnostics

## Status

- **State:** Complete
- **Completed on:** 2026-08-26
- **Implemented by:** Claude Opus 5 (backend/platform agent), implement-only session, 2026-08-26; gates and failure injection by the review session and the review-remediation session `3fb3cda0`, 2026-08-26
- **Plan reference:** `Plan.md`, Part 78
- **Related records:** ADR 0006 (transactional outbox), ADR 0008 (`prom-client` dependency review), Part 50 (queue runtime), Part 62/64 (exports), Part 67 (AI governance), Part 71 (audit + request context), Part 73 (trusted host), Part 74 (security hardening)

## Objective

Give the deployment the numbers and the correlation it needs to diagnose an
incident: metrics for HTTP, jobs, websockets and dependencies; queue
depth/failure, database pool saturation, dependency health, AI usage, export
duration and storage growth; alerts with runbooks; and a correlation chain that
identifies the affected tenant and request **without revealing secrets**.

## Implemented Work

### The honest shape of this part

Logging, redaction, correlation *plumbing* and readiness were already strong, so
this part **extends** them rather than rebuilding them. The genuinely missing
pieces were: no metrics of any kind, queue depth never measured
(`getJobCounts()` had zero callers), job durations never recorded, no
`job_outbox` visibility, and — the real defect — **the correlation chain was
broken between HTTP and jobs**: `job_outbox.correlation_id` existed, was indexed
and was consumed all the way to the dead-letter record, but of the **22 services
that insert into `job_outbox` directly, exactly one set it**.

### 1. `prom-client` registry with two label guards

`apps/api/src/metrics/metrics.registry.ts` holds one `Registry`, the
`collectDefaultMetrics({ prefix: "notted_" })` call, and every metric as a
**module-scope exported const**. The ~9 recording sites import the const they
need directly. A `MetricsService` injected into six feature modules to reach a
process-global registry would have added six constructor parameters, six module
imports and six test doubles and changed nothing about the value written — and
two of the recording sites (an Express middleware bound with `app.use`, BullMQ's
`worker.on("error")`) are not inside the DI container at all.

Two guards, unit-tested in `metrics.registry.test.ts`:

- `metricLabel(value, max = 64)` — the value if it matches a conservative
  charset and length, otherwise the literal `"other"`.
- `httpRouteLabel(request)` — buckets `/api/v1/trpc`, `/api/auth` and
  `/admin/queues` whole; otherwise sanitises segment-by-segment (UUID, long-hex
  and all-digit → `:id`), caps depth at 8, and applies a **hard 200-distinct-label
  cap** after which everything is `other`. It does not rely on `request.route`
  being populated (Express only sets it for router-matched handlers), and it is
  **total against a malformed request object** — it runs inside the exception
  filter, where a throwing labeller would turn a handled 404 into a crash.

### 2. HTTP metrics on the existing middleware

`request-context.middleware.ts` already computed `durationMs` in a
`response.once("finish")` handler and is `app.use`'d **first**, ahead of helmet,
CORS, Better Auth, tRPC and Bull Board. The histogram observation went there
rather than into a Nest interceptor, which structurally cannot see tRPC or
Better Auth. Label is `status_class` (`2xx`…`5xx`), never the raw status.

The in-flight gauge decrements on **`close`, not `finish`**: a client that
aborts mid-response never emits `finish`, and a gauge that only counts up is
worse than no gauge.

### 3. `ReadinessService`

`getReadiness`/`evaluateReadiness`/the 1 s cache and in-flight de-duplication
moved out of `HealthController` into `apps/api/src/health/readiness.service.ts`
verbatim; the controller keeps the two route methods. This is not tidying: the
`notted_dependency_up` gauge asks the same question on every scrape, and a
second independent probe path would have **doubled** every dependency check —
an SMTP connection, a MinIO round trip, a Meilisearch call — every 15 seconds.
Cache/de-dup assertions moved to `readiness.service.test.ts`; the 200/503
assertions stayed in the controller test.

### 4. Queue

- `QueueInfrastructureService.jobCounts()` iterates the five physical queues and
  the dead-letter lane, counting each **independently** so one failing queue
  does not blank the other four. Exposed through a new narrow
  `QUEUE_METRICS_SOURCE` token (symbol + one-method interface), mirroring
  `queue-readiness.indicator.ts`. The runtime owner is **not** exported — a
  collector that could reach a `Queue` could also `drain` or `obliterate` one.
- `publishDeadLetter` — the single terminal-failure funnel — increments a
  counter *before* the `add`, since a dead letter that cannot be published is
  the worse incident.
- Both BullMQ `error` handlers increment a client-error counter.
- `queue-worker-processor.service.ts` takes **one** `performance.now()` at the
  top of `process()` and uses the duration twice: the job histogram *and* a new
  `durationMs` field on both existing log lines, which previously carried none.
- An **outbox depth** gauge over `job_outbox`, restricted to the four
  non-terminal statuses so it stays on the existing dispatcher index. A stalled
  dispatcher is the one queue failure no BullMQ metric and no health check can
  see, because the jobs never reach BullMQ.

### 5. Collectors — the failure-isolation requirement

`apps/api/src/metrics/metrics-collectors.service.ts` is the only injectable in
the directory. It attaches `collect()` callbacks for dependency health (through
`ReadinessService`), queue depth (15 s), outbox depth (30 s), the `pg` pool
(no cache), and platform-wide attachment storage (60 s, reusing
`QUOTA_CHARGED_STATUSES`).

**Every callback is wrapped in try/catch and keeps its previous value.**
`Registry.metrics()` awaits `Promise.all` over every metric, so one rejecting
collector would make the whole scrape a 500 and Prometheus would record **no
sample for any metric** — HTTP rate, error rate, event-loop lag, all of it — at
the exact moment a dependency is down. `metrics-collectors.service.test.ts`
proves it with three simultaneously-failing sources, including one that throws a
`TypeError` rather than a rehearsed rejection.

Caching is a bare `nextAt` timestamp per collector rather than a cache class: a
gauge already retains its value between scrapes, so "skip the query and return"
*is* the cache. `nextAt` advances only on success.

### 6–8. Websockets, AI, export

- `realtime.gateway.ts`: connection and room gauges read O(1) at scrape time
  from `server.engine.clientsCount` and `server.sockets.adapter.rooms.size`
  (closing over `afterInit`'s `server`, which is provably non-null), plus an
  accepted/rejected counter. **No per-room gauge** — a room name is a per-note
  identifier, so it is unbounded cardinality *and* a tenant-shaped label.
- `ai-governance.service.ts`: three counters in `writeUsage` after the
  successful insert, so the counters and `ai_usage` agree. `model` (admin-authored
  `varchar(100)`) passes through `metricLabel`. **No workspace label.**
- `export.worker.service.ts`: the worker already knew its outcome at all seven
  exits and discarded it; `generate` now returns `{ outcome, format, byteLength? }`
  and `handle` observes duration and bytes. **No `started_at` column and no
  migration**: `created→completed` would measure queue wait too, and the known
  stuck-`processing` rows would poison any table-derived percentile.

### 9. Errors

`api-exception.filter.ts` gains an `errorType` × `status_class` counter, and the
5xx log line gains `method`, the **bounded** `route` (never `request.path`,
which carries identifiers), and `errorSite` — the first stack frame reduced by
regex to `file:line:col`. No stack string reaches `LogMetadata`: a frame can
quote a note title and the stack's first line is the `Error` message, so the
message line is skipped outright and the capture charset excludes slashes,
spaces, quotes and parentheses. No Sentry, no OTel, no outbound reporting.

### 10. Job correlation — one line

```ts
correlationId: uuid("correlation_id").$defaultFn(
  () => getRequestContext()?.requestId ?? sql`null`,
),
```

`$defaultFn` runs JS-side and **only when the caller omits the key**, so the one
explicit producer still wins, all 22 producers are fixed at once, every future
producer is covered by construction, and **it emits no DDL** (drizzle's own docs
state `$defaultFn` "does not affect the `drizzle-kit` behavior"). Sweeps,
workers and CLI scripts have no request store and keep writing `NULL`, which is
the truth.

### 11. Endpoint, auth and configuration

`GET /metrics` at the root (added to `setGlobalPrefix`'s exclude list beside the
health probes). `@RateLimitExempt()` — the global `RateLimitGuard` would
otherwise throttle a scraper into gaps in the very series used to diagnose the
throttling. `Content-Type` from `register.contentType`, `Cache-Control:
no-store`, `X-Robots-Tag: noindex, nofollow`.

Auth is a `METRICS_TOKEN` bearer compared with `timingSafeEqual` over SHA-256
digests (constant-time *and* length-independent), answering **404 — never 401 —**
when the variable is unset or the token is wrong. Production requires ≥ 32
characters *at startup*, rather than silently disabling the endpoint.

### 12–14. Compose, `ops/`, docs

`compose.yaml` gains `LOG_LEVEL` (never set before) and `METRICS_TOKEN` on the
`x-api-environment` anchor, plus an `x-log-rotation` anchor referenced from
`api`, `web`, `api-e2e`, `web-e2e`. **No monitoring service.**

New top-level `ops/` (sibling of `docker/` and `scripts/`; holds no JS so it is
not a workspace package) with `README.md`, `prometheus/prometheus.yml`,
`prometheus/alerts.yml` (14 rules), `prometheus/alerts_test.yml` (12 promtool
test blocks), and `grafana/notted-overview.json` (15 panels, `uid:
notted-overview`, `DS_PROMETHEUS` variable, no `__inputs`).

New `docs/runbooks/observability.md`; extensions to
`docs/standards/observability.md`, `docs/standards/operations.md`,
`docs/environment.md`, and ADR 0008.

## Important Decisions

- **No monitoring container, and no opt-in Compose profile.** A monitoring stack
  that only runs when the thing it watches runs is useless during the outage it
  exists for; Prometheus + Grafana is roughly a gigabyte of RSS on a host that
  already carries a Chromium; and a profile nobody enables is dead configuration
  that rots. `ops/` is configuration for an existing installation.
- **404, not 401, and default-off.** A 401 confirms the endpoint exists and is
  worth attacking. With the token unset by default there is no state in which a
  Notted deployment ships this open, and no state in which the endpoint's
  existence is discoverable without the token.
- **A shared bearer token is a real downgrade from every other surface, and the
  label rules are the compensation.** `PlatformOperatorService.requireOperator`
  (Bull Board's guard) needs a Better Auth **cookie session**, which a scraper
  cannot have; Part 65 API keys are workspace-scoped by construction. Network
  isolation is genuine defence in depth but is a deployment property this
  repository cannot enforce, so it is documented as an **additional** control.
  Because the boundary is weaker, no metric may carry a tenant identifier.
- **`DATABASE_POOL` was NOT exported from `DatabaseModule`.** The brief assumed
  a `@Global()` module makes its providers global; it makes its **exports**
  global, and `DATABASE_POOL` is a private provider. Rather than widen the
  module's public surface to hand a metrics collector a live `Pool` (which can
  `connect`, `query` and `end`), `DatabaseService` gained a three-line
  `poolStats()` — the same count-only-seam reasoning as `QUEUE_METRICS_SOURCE`.
- **`$defaultFn` returns `sql\`null\`` rather than `null`.** It is typed
  `() => T['data'] | SQL`, and a `uuid` column's data type is `string`. Drizzle
  inlines an `SQL` result into the VALUES list as-is, so the emitted statement is
  the same explicit NULL the nullable column already accepted.
- **`OPENAPI_ROUTES` and `PREFIX_EXCLUDED` had to be updated.** The OpenAPI
  builder mirrors `main.ts`'s prefix exclusions and the contract test asserts
  every Nest-registered route is documented, so a new controller that was not
  registered would have failed `openapi.contract.test.ts` and left
  `docs/openapi.json` stale. Both were updated and the document regenerated
  (15 added lines, `GET /metrics` only).
- **`/metrics` is deliberately NOT exempt from `TrustedHostMiddleware`.** The
  health probes are exempt because orchestrators dial them with arbitrary
  `Host`; `/metrics` is token-gated and keeps every boundary it can. The
  consequence — a scraper on a raw IP gets `421` when custom domains are enabled
  — is documented in three places rather than engineered away.
- **A companion `notted_storage_objects` gauge was written and removed.** A
  metric with no `collect()` of its own is serialized concurrently with the one
  whose collector fills it and is therefore one scrape behind; giving it its own
  collector would run the same aggregate twice per scrape. No alert needed it.
- **`sum` vs `max by()` is a documented authoring rule, not a style choice.**
  Global facts read from a shared store (queue depth, outbox, storage,
  dependency health) are reported identically by every instance; `sum` over three
  replicas fires the backlog alert at one third of the real threshold, and moves
  that threshold whenever the replica count changes. `alerts_test.yml` has a
  dedicated negative test for it.
- **`NottedStorageGrowth` ships with a calibration knob, commented as one.**
  Every deployment's normal differs; the threshold is a guess and says so.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/src/metrics/metrics.registry.ts` | The one `Registry`, every metric const, `metricLabel`, `httpRouteLabel`, `statusClassLabel`, and the label rationale. |
| `apps/api/src/metrics/metrics.registry.test.ts` | Label-guard unit tests, including the 200-distinct-route cap and the no-path case. |
| `apps/api/src/metrics/metrics-collectors.service.ts` | The only injectable: scrape-time collectors, each failure-isolated and TTL-gated. |
| `apps/api/src/metrics/metrics-collectors.service.test.ts` | The load-bearing test — three failing sources, gauges keep previous values, scrape survives. |
| `apps/api/src/metrics/metrics.controller.ts` | `GET /metrics`, bearer auth, 404-not-401, headers. |
| `apps/api/src/metrics/metrics.controller.test.ts` | 404 unset / 404 wrong / 200 + content-type / no UUID anywhere / rejecting collector still 200. |
| `apps/api/src/metrics/metrics.module.ts` | Imports `DatabaseModule`, `HealthModule`, `QueueModule`; nothing imports it. |
| `apps/api/src/health/readiness.service.ts` | Readiness evaluation, 1 s cache, in-flight de-dup — moved verbatim from the controller. |
| `apps/api/src/health/readiness.service.test.ts` | Cache/de-dup/redaction assertions moved out of the controller test. |
| `apps/api/src/health/health.controller.ts` | Two route methods only; delegates. |
| `apps/api/src/health/health.controller.test.ts` | 200/503 only. |
| `apps/api/src/health/health.module.ts` | Provides and exports `ReadinessService`. |
| `apps/api/src/queue/queue-metrics.source.ts` | `QUEUE_METRICS_SOURCE` token + one-method interface. |
| `apps/api/src/queue/queue-infrastructure.service.ts` | `jobCounts()`, dead-letter counter, client-error counters. |
| `apps/api/src/queue/queue.module.ts` | Registers/exports the new token; owner stays private. |
| `apps/api/src/queue/queue-worker-processor.service.ts` | One clock reading → job histogram + `durationMs` on both log lines. |
| `apps/api/src/common/request/request-context.middleware.ts` | HTTP histogram + in-flight gauge on the existing handler. |
| `apps/api/src/common/errors/api-exception.filter.ts` | Error counter, `method`/`route`/`errorSite` on the 5xx log. |
| `apps/api/src/realtime/realtime.gateway.ts` | Connection/room gauges and the accepted/rejected counter. |
| `apps/api/src/ai/ai-governance.service.ts` | Request/token/cost counters after the `ai_usage` insert. |
| `apps/api/src/export/export.worker.service.ts` | Returns its outcome; duration and bytes histograms. |
| `apps/api/src/database/schema/job-outbox.ts` | `correlation_id` client-side default — the 22-producer fix, no DDL. |
| `apps/api/src/database/database.service.ts` | `poolStats()` count-only seam. |
| `apps/api/src/config/app.config.ts` | `metricsToken`, with the production length rule. |
| `apps/api/src/config/environment-contract.test.ts` | Default-off and weak-token-in-production assertions. |
| `apps/api/src/openapi/openapi.builder.ts` | `/metrics` added to the prefix-exclusion mirror. |
| `apps/api/src/openapi/openapi.routes.ts` | `GET /metrics` documented. |
| `apps/api/src/main.ts` | `/metrics` excluded from the `api/v1` prefix. |
| `apps/api/src/app.module.ts` | Declares `MetricsModule`. |
| `apps/api/package.json` | `prom-client` 15.1.3, exact-pinned. |
| `apps/api/.env.example` | `METRICS_TOKEN` with generation guidance. |
| `compose.yaml` | `LOG_LEVEL`, `METRICS_TOKEN`, `x-log-rotation` on four services. |
| `ops/README.md` | How to point an existing Prometheus/Grafana at these files; why no container. |
| `ops/prometheus/prometheus.yml` | 15 s scrape, `rule_files`, bearer via `credentials_file`. |
| `ops/prometheus/alerts.yml` | 14 rules with `for:` and `runbook_url`; the aggregation rule commented in place. |
| `ops/prometheus/alerts_test.yml` | 12 promtool test blocks replaying the injection conditions. |
| `ops/grafana/notted-overview.json` | 15-panel dashboard. |
| `docs/runbooks/observability.md` | Signal catalogue, label allow/forbidden lists, exposure model, correlation walkthrough, logging/retention, one section per alert, failure-injection procedures. |
| `docs/standards/observability.md` | Extended with the Part 78 implementation rules. |
| `docs/standards/operations.md` | Proxy must never route `/metrics` publicly; bound container logs. |
| `docs/environment.md` | New "Observability values" section (`LOG_LEVEL`, `METRICS_TOKEN`). |
| `docs/decisions/0008-runtime-and-package-compatibility.md` | `prom-client` four-point review + rejected alternatives + validation evidence. |
| `docs/openapi.json` | Regenerated; `GET /metrics` only (15 added lines). |

## Database and Data Changes

**No migration, and this is a load-bearing claim.** The only schema-file change
is `job_outbox.correlation_id` gaining `$defaultFn`, which drizzle documents as
runtime-only and explicitly *not* affecting drizzle-kit. `pnpm db:check` must
report **no pending migration** — see Verification below. No column was added,
no index changed, no backfill, no retention effect. Rollback is deleting the
`$defaultFn` call.

## API, Configuration, and Operational Changes

- **New route:** `GET /metrics` (unversioned, outside `api/v1`). Bearer
  `METRICS_TOKEN`; 404 when unset or wrong; Prometheus text exposition.
- **New environment variable:** `METRICS_TOKEN` — unset by default (endpoint
  404s), ≥ 32 characters required in production or startup fails.
  `scripts/validate-env.ts` needed no change: it calls `validateApiEnvironment`,
  which calls `parseAppConfig`.
- **`LOG_LEVEL`** is now set explicitly in `compose.yaml` (it never was), so the
  development stack has a visible knob.
- **Container logs are now bounded** at 10 MB × 5 per application service.
  Docker's default `json-file` driver has no limit at all, so a crash loop could
  fill the host disk and take down every container on the daemon.
- **No new port, no new service, no new container.** Defaults are safe for both
  development and production: the endpoint does not exist until an operator
  turns it on.

## Security and Tenant-Isolation Notes

- `/metrics` is authenticated (`timingSafeEqual` over SHA-256 digests),
  rate-limit exempt by design, `no-store`, `noindex`. Wrong or missing token →
  404, so the route is not discoverable.
- **No metric carries a tenant identifier.** The forbidden list (`workspaceId`,
  `userId`, any entity id, `requestId`, email, IP, raw path, raw error message,
  object key, room name) is enforced by construction — every label is a literal,
  a bounded enum, or a `metricLabel`/`httpRouteLabel` result — and asserted by a
  test that fails if a UUID appears anywhere in the scrape body.
- AI usage, storage and export metrics are **platform-wide with no workspace
  label**. Per-workspace numbers stay on their authorized endpoints.
- `errorSite` is `file:line:col` only; the `Error` message line is never read
  and the capture charset structurally cannot carry content.
- `LogMetadata` remains scalars-only. No redaction path was removed; none was
  needed for the new fields (`method`, `route`, `errorSite`, `durationMs` are
  all bounded or derived).
- `/metrics` is **not** exempt from the trusted-host check, keeping the Part 73
  boundary intact for a surface with weaker authentication.
- No new authorization surface, no tenant query, no cross-workspace read. The
  two database aggregates (`job_outbox`, `attachments`) are deliberately
  platform-wide counts with no per-tenant breakdown reaching the endpoint.

## Verification Evidence

The implementing session ran nothing. The rows below name **which session** produced each result: the
independent **review session**, or the **remediation session** (`3fb3cda0`) that fixed what the review
found. Nothing is marked passed that was not observed.

| Check | Result | Session | Notes |
|---|---|---|---|
| `pnpm install` | Pass | implementing | `prom-client@15.1.3`, `+17 -12` packages, no peer errors. |
| `node --import tsx apps/api/scripts/generate-openapi.ts` | Pass | implementing | Regenerated `docs/openapi.json`; diff is 15 added lines, `GET /metrics` only. |
| `pnpm lint` | **Pass** | remediation | Two errors first: an unused import and an `import-x/order` violation, both in this part's files. |
| `pnpm format:check` | **Pass** | remediation | |
| `pnpm type-check` | **Pass** | remediation | **Failed with 7 errors before remediation** — see "This part did not compile" below. |
| `pnpm test` | **Pass** | remediation | |
| `pnpm test:ci` (dev API container, `CI=true`) | **Pass** | remediation | 235 files passed, 2 skipped, 0 failed; coverage thresholds met. |
| `pnpm build` | **Pass** | remediation | With the `NEXT_PUBLIC_*` production prefixes. **Failed before remediation**, same 7 errors. |
| `pnpm infra:up:ports` reaches healthy | **Pass** | remediation | The `api` container was `Up (unhealthy)` before remediation, for the same reason. |
| `pnpm --filter @notted/api db:check` | Pass | review | No pending migration. |
| `promtool check rules` / `promtool test rules` (×3) | Pass | review | |
| `promtool test rules` after the `NottedOutboxStuck` rescope | **Pass — SUCCESS** | round-2 remediation | Includes a new case asserting that 3,000 rows at `consumable="no"` produce **no** alert. |
| Live `/metrics`, `consumable` split | **Verified** | round-2 remediation | On the developer's own database: `pending,consumable="no"` **2,863**, `pending,consumable="yes"` **0**. The pre-fix expression `max(pending) > 100` evaluated to 2,863 and would have fired forever; the scoped expression evaluates to 0. |
| Live `/metrics`, route bucketing | **Verified** | round-2 remediation | `route="trpc"` and `route="auth"` both present, closing round 1's finding that these bucketed as `/notes.list` and `/sign-up/email`. Round-2 review could not check this without a token; it was checked here with a throwaway one, and the API was recreated without it afterwards. |
| `/metrics` without a token | **404** | round-2 remediation | Default-off confirmed unchanged by the rescope. |
| `GET /metrics` auth matrix (no token / wrong token / right token) | **Pass — 404 / 404 / 200** | remediation | Re-observed after the `setCollect` refactor. |
| Every collector fires on a live scrape | **Pass** | remediation | `dependency_up` 8 samples, `queue_jobs` 20, `job_outbox_rows` 4, `database_pool_connections` 3 + `_max` 1, `storage_bytes` 3, `websocket_connections`/`_rooms` 1 each. |
| Secret and identifier greps on the scrape body | **Pass — 0 / 0** | remediation | Zero UUID-shaped strings; the only `token` match in the whole body is the word inside `# HELP notted_ai_tokens_total`. |
| Route-label bucketing | **Pass** | remediation | `route="trpc"`, `route="auth"`, `route="other"` — see "The buckets never fired" below. |
| Redis down keeps the scrape at 200 | Pass | review | The collector-isolation guarantee. |
| `X-Request-Id` → `job_outbox.correlation_id` | Pass | review | End-to-end correlation. |
| Distinct-route cardinality cap | Pass | review | 230 probed paths produced 201 labels with `other` absorbing the rest. |
| Failure injection (Meilisearch/MinIO/export/pool/500) | Pass | review | Procedures in `docs/runbooks/observability.md`. |
| Grafana dashboard rendered | **Not performed** | — | Still unverified; see Known Limitations. |

### This part did not compile

`pnpm type-check`, `pnpm build` and the dev `api` container all failed with the same **7 errors**, and
`pnpm infra:up:ports` exited 1 with `dependency api failed to start`. Seven call sites assigned
`gauge.collect = …`. In `prom-client@15.1.3` `collect` is declared **only on the configuration
interface** (`GaugeConfiguration.collect?`), never on the `Gauge` class — so it works at run time, which
is why the live behaviour was provably correct while `tsc` rejected the code outright.

The fix is one exported helper, `setCollect(metric, collect)` in `metrics.registry.ts`, used at all seven
sites, with the cast confined to it. Moving `collect` into the gauge constructors was considered and
rejected: every collector needs `this` from a service constructed long after the metric const, and two of
them need an object (`server`, the pool) that only exists at run time.

### The buckets never fired

`httpRouteLabel` read `request.path`, and Express **rewrites `req.url`** — and therefore the `req.path`
getter derived from it — when it dispatches into an `app.use(prefix, handler)` mount, restoring it only
in the `next()` callback that a sub-handler which has already ended the response never calls. Both
surfaces the prefix buckets exist for are exactly such mounts, so the `finish` listener saw
`/notes.list` and `/sign-up/email`:

```
notted_http_request_duration_seconds_count{method="POST",route="/sign-up/email",...} 1
notted_http_request_duration_seconds_count{method="GET",route="/notes.list",...}    1
```

Every tRPC procedure and every Better Auth sub-path was minting its own time series — the precise
unbounded-cardinality failure this file's header claims to prevent. The label is now derived from
`originalUrl`, which Express never rewrites, and the same correction was applied to the structured HTTP
log line in `request-context.middleware.ts`, which had been recording truncated paths since it was
written. After the fix, on a live stack:

```
notted_http_request_duration_seconds_count{method="POST",route="auth",...}  1
notted_http_request_duration_seconds_count{method="GET",route="trpc",...}   1
notted_http_request_duration_seconds_count{method="GET",route="other",...}  2
```

### The route-label set was poisonable

The 200-distinct-label cap worked, but *any* path could spend a slot — including one that matched no
route. An unauthenticated scanner walking `/api/v1/scan1`, `/api/v1/scan2`, … could therefore fill the
cap with paths that do not exist and permanently force every route registered afterwards, including real
ones, into `other`. A new label is now registered **only when `request.route` is present**; an unmatched
path becomes `other` immediately. A label already registered still resolves for a middleware-terminated
request, so a rate-limited or CSRF-rejected call to a real route lands on that route's series rather than
on `other`. Unit-tested both ways. This also settles the `api-exception.filter.ts` observation that the
filter computes a route label it uses only for logging: it can no longer mutate the shared set.

### Reviewer's verification sequence

Development ports on this host: API `3101`, PostgreSQL `5433`, Redis `6380`;
Compose project `notted-dev`.

```sh
pnpm install
pnpm lint && pnpm format:check && pnpm type-check
pnpm --filter @notted/api db:check          # expect: no pending migration
pnpm --filter @notted/api test              # metrics, readiness, config, openapi contract
NEXT_PUBLIC_APP_URL=https://app.local.notted.invalid \
NEXT_PUBLIC_API_URL=https://api.local.notted.invalid \
NEXT_PUBLIC_WS_URL=wss://api.local.notted.invalid pnpm build

# Endpoint, live.
echo "METRICS_TOKEN=$(openssl rand -hex 32)" >> .env
pnpm infra:up:ports
export METRICS_TOKEN=$(grep '^METRICS_TOKEN=' .env | cut -d= -f2)
curl -s -o /dev/null -w '%{http_code}\n' localhost:3101/metrics                       # 404
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer wrong" localhost:3101/metrics   # 404
curl -s -D- -o /dev/null -H "Authorization: Bearer $METRICS_TOKEN" localhost:3101/metrics | head -5  # 200 + text/plain

# The two `expect: 0` greps that are the literal evidence for
# "identify the affected tenant/request WITHOUT revealing secrets".
curl -s -H "Authorization: Bearer $METRICS_TOKEN" localhost:3101/metrics | grep -Eic 'secret|password|redis://|postgres://'   # 0
curl -s -H "Authorization: Bearer $METRICS_TOKEN" localhost:3101/metrics | grep -Ec '[0-9a-f]{8}-[0-9a-f]{4}-'                # 0

# Correlation, end to end.
curl -s -D- -o /dev/null localhost:3101/health/ready | grep -i x-request-id
docker compose -p notted-dev logs api | grep '"requestId"' | tail -3
psql "postgres://notted:notted_dev_password@127.0.0.1:5433/notted_dev" \
  -c "select id, job_type, status, correlation_id from job_outbox order by created_at desc limit 5;"
```

Then the six failure-injection procedures in
`docs/runbooks/observability.md#failure-injection-procedures`, each of which
names its expected metric change, alert, and log line.

## Known Limitations and Follow-up Work

**`NottedOutboxStuck` was wrong on day one, and the fix is a label, not a threshold.** Round-2 review
crossed this part's alerts with Part 77's outbox residual and found that
`max(notted_job_outbox_rows{status="pending"}) > 100` evaluates to ~2,800 on an ordinary database and
never falls: a job type with no registered consumer is re-claimed and re-deferred by
`OutboxDispatcherService`'s rollout safety gate forever, by design. The alert would have fired fifteen
minutes into any deployment and never cleared, and its runbook's remediation — restart the API, then
look for rows stuck in `dispatching` — could not work, because pending would not fall and nothing would
be stuck. That is the alert-fatigue failure mode the rest of `alerts.yml` is written to avoid.

The gauge now carries a `consumable` label (two values, never a job type — the domain event catalogue
does not belong in a metric) sourced from `QueueHandlerRegistry.registeredJobTypes()` through the
existing `QUEUE_METRICS_SOURCE` seam, and the alert is scoped to `consumable="yes"`. The runbook gained
the saturation case as a named likely cause. `alerts_test.yml` gained a case asserting that 3,000
unconsumable rows produce no alert, so the regression cannot return silently.

**Update 2026-08-26.** The underlying backlog is now fixed too: types declared `consumer: "none"` are
excluded from `claimBatch`, and the `queue.idempotency.cleanup` sweep retires them past
`QUEUE_OUTBOX_RETENTION_DAYS`. The saturation case the runbook named as a likely cause is therefore no
longer reachable, and that section documents it as history rather than as a live diagnosis. **The alert,
the `consumable` label and the `alerts_test.yml` case are all unchanged and all still load-bearing**: the
marked rows still report under `consumable="no"` until the sweep retires them, and the label remains the
only thing separating a stalled dispatcher from a backlog nobody consumes.


- ~~**Nothing was executed.**~~ Closed: every gate, the scrape, the alert evaluation and the injection
  matrix have now run. See the Verification Evidence table for which session produced each row.
- ~~**`promtool` may not be installed on this host.**~~ Closed: three `promtool` runs passed in the review
  session.
- **`METRICS_TOKEN` is not set on this host's stacks.** It was set temporarily to observe the endpoint and
  then removed, leaving `GET /metrics` at its default 404. Nothing in the repository sets it, which is the
  intended default-off posture.
- **The Grafana dashboard has never been rendered.** Panel expressions are the
  same PromQL the alert rules use, but layout and unit choices are unverified.
- **`NottedStorageGrowth` is uncalibrated by design** — 5 GiB/day is a
  placeholder that every deployment must re-derive from its own baseline. It is
  commented as such in `alerts.yml` and in the runbook.
- **`notted_websocket_rooms` is a per-instance local view.** With the Redis
  adapter, `sum()` across instances over-counts rooms held on more than one.
  The dashboard panel says so; no alert uses it.
- **`prom-client` enables a `perf_hooks` event-loop-delay histogram at module
  load.** It is expected to be unref'd and not to hold the process open, but if
  `pnpm test` ever hangs on teardown, this is the first suspect.
- **No log shipping, no retention beyond Docker's rotation, no alert routing.**
  Alertmanager configuration is deliberately out of scope — routing is a
  deployment decision. Phase 15 owns the production stack.
- **`GET /metrics` appears in the public OpenAPI document.** That is forced by
  `openapi.contract.test.ts` (every registered route must be documented) and is
  consistent with the health probes. It does not weaken the runtime 404: the
  document says the route exists in the *code*, not that it is enabled in *your*
  deployment.

## Handoff Notes

- **Use `setCollect(metric, fn)`, never `metric.collect = fn`.** `prom-client@15` declares `collect` only
  on the configuration interface, so the direct assignment type-checks nowhere and the direct constructor
  argument cannot see `this`. The single cast lives in that helper; keep it there.
- **`httpRouteLabel` must read `originalUrl`, not `path`.** Express strips the mount prefix from `req.url`
  for `app.use(prefix, …)` mounts, which is every surface the prefix buckets exist for. Reading `path`
  silently un-buckets tRPC and Better Auth.
- **`metrics.registry.ts` is process-global state on purpose.** Adding a metric
  means adding a const there and importing it at the call site. Do **not**
  introduce a `MetricsService` — read the header comment first.
- **Every new label must be a literal, a bounded enum, or a `metricLabel()` /
  `httpRouteLabel()` result.** If a label seems to need a workspace, user, note
  or request id, the answer is an authorized API endpoint, not a metric.
- **Every new `collect()` callback must be try/caught.** One rejection is a 500
  for the entire scrape. There is a test for this; do not weaken it.
- **`sum` vs `max by()`**: read the block comment at the top of `alerts.yml`
  before writing a rule. `alerts_test.yml` has a negative test that fails if the
  queue-depth rule is switched to `sum`.
- **`OPENAPI_ROUTES` + `PREFIX_EXCLUDED` + `docs/openapi.json`** move together
  with any new controller. Regenerate with
  `pnpm --filter @notted/api openapi:generate`.
- **`ops/` holds no JavaScript**, so it is not a pnpm workspace package and
  nothing builds it. Keep it that way.
- If a future part adds a `started_at` column to `exports`, it must not be
  justified by metrics — the in-process histogram already answers that question
  and is more accurate.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-26 | Claude Opus 5 (backend/platform agent) | Initial record. Implementation complete; no gate executed. |
| 2026-08-26 | Review-remediation session `3fb3cda0` | Fixed the seven `Gauge.collect` type errors that stopped the whole repository compiling, fixed `httpRouteLabel` reading a path Express had already rewritten (so the tRPC and Better Auth buckets never fired), stopped unmatched paths from spending slots in the distinct-route cap, and corrected the structured HTTP log's truncated `path`. Re-observed the scrape, the collectors, the secret greps and the route labels on a live stack. **State → Complete.** |
