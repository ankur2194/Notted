# Observability and operational diagnostics

Part 78. What Notted measures, where the numbers come from, what is deliberately
**not** measured, how to follow one request from an HTTP header to a queue job
to an audit row, and what to do when each alert fires.

## Scope and non-goals

**In scope.** A Prometheus exposition endpoint, per-signal collection, alert
rules with runbooks, a dashboard, and the correlation chain that ties logs,
jobs and audit rows to a single request.

**Explicitly not in scope, and not by omission:**

- **No Sentry, no OpenTelemetry, no APM agent, no outbound reporting of any
  kind.** Nothing in this part opens a network connection to a third party.
  Error context stays in the process's own structured logs; a stack trace that
  leaves the deployment is note content leaving the deployment.
- **No distributed tracing.** The correlation chain below already answers "what
  did this request do", and a trace backend is a second always-on service on a
  host that has one already (see `ops/README.md`).
- **No monitoring containers.** `compose.yaml` gains no Prometheus and no
  Grafana. An opt-in Compose profile was considered and rejected.
- **No log shipping.** Container logs are bounded by the `x-log-rotation`
  anchor in `compose.yaml` and read with `docker compose logs`. A log pipeline is
  Phase 15's business.

## Exposure model

`GET /metrics` — unversioned, mounted outside the `api/v1` prefix alongside
`/health/live` and `/health/ready`.

| Property | Value |
| --- | --- |
| Authentication | `Authorization: Bearer $METRICS_TOKEN` |
| Unset or wrong token | **`404`**, never `401` |
| Default | `METRICS_TOKEN` unset → the endpoint does not exist |
| Production constraint | token must be ≥ 32 characters or the API refuses to start |
| Rate limiting | exempt (`@RateLimitExempt`) |
| Caching | `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow` |

**Why a bearer token and not the boundary everything else uses.** Three
alternatives were rejected:

- `PlatformOperatorService.requireOperator`, which guards Bull Board, requires a
  **Better Auth cookie session**. A Prometheus scraper has no browser and no way
  to sign in. Unusable.
- Part 65 API keys are **workspace-scoped by construction**, and a platform-wide
  metrics endpoint has no workspace to scope to.
- Network-only exposure (a second listener, or trusting the proxy) is genuine
  defence in depth but is a *deployment* property this repository cannot
  enforce. It is therefore an **additional** control, documented below, not a
  replacement for the token.

**Why 404 and not 401.** A `401` confirms the endpoint exists and is worth
attacking. Combined with the default-off configuration, `404` means there is no
state in which a Notted deployment ships this open, and no state in which its
existence is discoverable by someone without the token. The comparison is
`timingSafeEqual` over SHA-256 digests: constant-time *and* length-independent,
so neither a matching prefix nor the token's length leaks.

> ### ⚠️ `TrustedHostMiddleware` will 421 your scraper
>
> With `CUSTOM_DOMAINS_ENABLED=true`, `TrustedHostMiddleware` refuses any
> unexpected `Host` header with **`421 UNTRUSTED_HOST`**. It exempts
> `/health/live` and `/health/ready` — because orchestrators dial those with
> whatever `Host` they please — and **`/metrics` is deliberately not exempt**:
> the endpoint is protected by a shared token rather than by a session, so it
> keeps every boundary it can.
>
> A scraper configured with `targets: ["10.0.0.5:3001"]` therefore sends
> `Host: 10.0.0.5:3001`, gets a `421`, and Prometheus shows the target **down
> with no obvious cause**. Fix it by scraping a configured hostname, or by adding
> the scrape address to the trusted host list. With custom domains disabled the
> middleware is never installed and this cannot happen.

**The proxy must never route `/metrics` publicly.** See
`docs/standards/operations.md`.

## Signal catalogue

`notted_process_*`, `notted_nodejs_*` are `prom-client`'s default metrics
(event-loop lag, heap, GC, handles, file descriptors), collected with the
`notted_` prefix.

| Metric | Type | Labels | Source |
| --- | --- | --- | --- |
| `notted_http_request_duration_seconds` | histogram | `method`, `route`, `status_class` | `request-context.middleware.ts`, in the existing `finish` handler |
| `notted_http_requests_in_flight` | gauge | — | same middleware; decremented on `close`, not `finish` |
| `notted_api_errors_total` | counter | `error_type`, `status_class` | `api-exception.filter.ts` |
| `notted_dependency_up` | gauge | `dependency` | `ReadinessService`, through its 1 s cache |
| `notted_database_pool_connections` | gauge | `state` (`total`/`idle`/`waiting`) | `DatabaseService.poolStats()` |
| `notted_database_pool_max` | gauge | — | `DATABASE_POOL_MAX_CONNECTIONS` |
| `notted_queue_jobs` | gauge | `queue`, `state` | `QUEUE_METRICS_SOURCE`, 15 s cache |
| `notted_job_outbox_rows` | gauge | `status`, `consumable` | grouped count over `job_outbox`, 30 s cache. `consumable="no"` means no handler is registered for the row's job type, so it can never drain — see NottedOutboxStuck |
| `notted_queue_job_duration_seconds` | histogram | `queue`, `outcome` | `queue-worker-processor.service.ts` |
| `notted_queue_dead_letter_total` | counter | `queue` | `publishDeadLetter`, the single terminal-failure funnel |
| `notted_queue_client_errors_total` | counter | `queue`, `component` | BullMQ `error` handlers |
| `notted_websocket_connections` | gauge | — | `server.engine.clientsCount`, O(1) at scrape time |
| `notted_websocket_rooms` | gauge | — | `server.sockets.adapter.rooms.size`, this instance's local view |
| `notted_websocket_connections_total` | counter | `outcome` | `handleConnection` success path and its `catch` |
| `notted_ai_requests_total` | counter | `provider`, `model`, `feature`, `status` | `AiGovernanceService.writeUsage` |
| `notted_ai_tokens_total` | counter | `provider`, `model`, `kind` | same |
| `notted_ai_cost_micros_total` | counter | `provider`, `model` | same |
| `notted_export_duration_seconds` | histogram | `format`, `outcome` | `export.worker.service.ts`, measured in process |
| `notted_export_bytes` | histogram | `format` | same, successful artefacts only |
| `notted_storage_bytes` | gauge | `status` | aggregate over `attachments`, 60 s cache |

### Two collection properties worth knowing

**Dependency health rides the readiness cache.** `notted_dependency_up` calls the
same `ReadinessService` that serves `/health/ready`, so a scrape reuses its 1 s
result cache and in-flight de-duplication. A second, independent probe path
would have doubled every dependency check — an SMTP connection, a MinIO round
trip, a Meilisearch call — for two consumers of the same fact.

**Every collector is failure-isolated.** `Registry.metrics()` awaits
`Promise.all` over every metric, so one rejecting collector would turn the whole
scrape into a `500` and Prometheus would record **no sample for any metric** —
including HTTP rate, error rate and event-loop lag — at the exact moment a
dependency is down. Every `collect()` callback is therefore wrapped in
`try`/`catch` and keeps its previous value on failure.

### Export duration is measured in process, on purpose

`exports` has `created_at` and `completed_at` but no `started_at`. A
table-derived duration would measure **queue wait plus generation**, and the
known stuck-`processing` rows (see the `ponytail:` note in
`export.worker.service.ts`) would drag every percentile. Adding a `started_at`
column was considered and rejected; the worker times itself instead and reports
the outcome it already knew at each of its exits.

## Label allow-list and forbidden list

Two independent failures are being prevented, and a label can cause either one
alone:

1. **Cardinality.** Prometheus stores one in-memory time series per distinct
   label combination. An unbounded label turns one metric into millions of
   series and takes down the monitoring system along with the thing it watched.
2. **Tenant disclosure.** `/metrics` has a **weaker auth boundary than the rest
   of the API**: a shared token held by a scraper, not a session with a
   workspace membership behind it. A tenant identifier here is exported to
   everyone holding that token, and to anyone who later reads the metrics store,
   the dashboard or a screenshot of it.

### Allowed

Compile-time literals; bounded enums (`status_class`, queue names, job/export
outcomes, AI feature and status, attachment processing status, dependency
names); and values passed through one of the two guards in
`metrics.registry.ts`:

- `metricLabel(value, max = 64)` — the value if it matches a conservative
  charset and length, otherwise the literal `"other"`. Used for anything
  human-authored, notably `ai_usage.model`, which is an admin-authored
  `varchar(100)`.
- `httpRouteLabel(request)` — buckets `/api/v1/trpc`, `/api/auth` and
  `/admin/queues` whole; otherwise replaces UUID, long-hex and all-digit
  segments with `:id`, caps segment depth, and applies a **hard 200-distinct-label
  cap** after which everything is `other`. The cap is the part that matters: a
  scanner walking `/api/v1/aaa`, `/api/v1/aab`, … mints a new label per request
  and every one of those passes the segment rules.

### Forbidden — never a label, on any metric

| Forbidden | Why |
| --- | --- |
| `workspaceId` | tenant identifier + unbounded |
| `userId` | tenant identifier + unbounded |
| `noteId`, `projectId`, `commentId`, `exportId`, `attachmentId` | tenant identifiers + unbounded |
| `requestId` | unbounded by construction — one series per request |
| email address | personal data + unbounded |
| IP address | personal data + unbounded |
| raw URL path | carries every identifier above |
| raw error message | can quote a note title, an address, an object key |
| object storage key | contains workspace and export identifiers |
| realtime room name | per-note identifier + unbounded |

Consequences deliberately accepted: **AI usage, storage bytes and export
durations are platform-wide with no workspace label.** Per-workspace AI usage
already exists, authorized, at `GET /api/v1/ai/usage`, and per-workspace storage
at the quota surface. `notted_websocket_rooms` is a **count only** — there is no
per-room series.

The regression test for this rule is in `metrics.controller.test.ts`: the scrape
body must contain **no UUID anywhere**.

## Logging

**Format.** JSON via pino, wrapped by `StructuredLogger`. Every line carries
`service: "notted-api"` and `environment`. Level from `LOG_LEVEL` (default
`info`; `compose.yaml` now sets it explicitly so there is a knob to turn).

**Exclusions.** `LogMetadata` accepts **scalars only** — booleans, numbers,
strings. That is load-bearing rather than stylistic: it makes "log the whole
object and let redaction sort it out" impossible to write, so a nested payload
cannot smuggle content past the ~60 redaction paths (`authorization`, `cookie`,
`password`, `email`, `token`, `secret`, `url`, `apiKey`, `set-cookie`,
`connectionString`, provider credentials, …). Never logged: note or comment
content, uploaded bytes, AI prompts and completions, signed URLs, credentials,
session tokens.

`errorSite` on a 5xx log line is the **first stack frame reduced to
`file:line:col`** and nothing else. A raw stack must never reach a log — its
first line is the `Error` message, which routinely quotes the note title or the
object key that caused the failure — and the capture charset excludes slashes,
spaces, quotes and parentheses, so the field is *structurally* incapable of
carrying content while still naming the code to open.

**Retention.** Container logs are bounded by the `x-log-rotation` anchor in
`compose.yaml`: `json-file`, `max-size: 10m`, `max-file: 5` — 50 MB per service,
applied to `api`, `web`, `api-e2e`, `web-e2e`. Docker's default has **no size
limit at all**, so before this a crash loop or a `debug` level could fill the
host disk and take down every other container on the daemon. Long-term retention
and shipping are Phase 15's.

## Correlation walkthrough

One request, end to end. Each hop names the field that carries the link.

```
client                 ──▶  X-Request-Id: 9f6d… (or generated by the middleware)
RequestContextMiddleware ─▶  validates/mints a UUIDv4, echoes X-Request-Id,
                             enters an AsyncLocalStorage, and logs
                             { requestId, method, path, statusCode, durationMs, outcome }
service (in a tx)      ──▶  INSERT job_outbox (…)  →  correlation_id defaults to
                             getRequestContext()?.requestId
OutboxDispatcher       ──▶  claimBatch() carries correlation_id to BullMQ
QueueWorkerProcessor   ──▶  logs { queue, jobId, correlationId, outcome, durationMs }
handler                ──▶  QueueJobContext.correlationId → authorization,
                             email producer, dead-letter record
audit                  ──▶  audit_logs rows written under the same request store
```

**The fix this part made.** The column, its index and every consumer already
existed — but **22 services insert into `job_outbox` directly and exactly one
set `correlationId`**, so the header→job half of the chain was broken for the
other 21. `job_outbox.correlation_id` now carries
a `$defaultFn` returning `getRequestContext()?.requestId` (or an SQL `null`), which runs
JS-side **only when the caller omits the key**: the explicit producer still
wins, every future producer is covered by construction, and it emits **no DDL**
(`pnpm db:check` must report no pending migration). A sweep, a worker or a CLI
script has no request store and writes `NULL` — which is the truth.

### Pivot query

Given a request id from a client, a log line or an `X-Request-Id` response
header:

```sql
-- Every durable side effect the request committed.
SELECT id, job_type, queue_name, status, attempt_count, last_error_code,
       created_at, dispatched_at, completed_at
  FROM job_outbox
 WHERE correlation_id = '00000000-0000-4000-8000-000000000000'
 ORDER BY created_at;

-- What the request changed, and which tenant it belonged to.
SELECT workspace_id, actor_user_id, action, entity_type, entity_id, created_at
  FROM audit_logs
 WHERE created_at BETWEEN $start AND $end
 ORDER BY created_at;
```

Then, for the job ids returned:

```sh
docker compose -p notted-dev logs api | grep '"jobId":"<id>"'
docker compose -p notted-dev logs api | grep '"requestId":"<request-id>"'
```

**Which tenant was affected is answered from the database and the logs, never
from `/metrics`.** That separation is the point: diagnostic context identifies
the tenant, metrics never do.

## Failure-injection procedures

Run against the development stack. `$API` is the published API port
(`NOTTED_API_PORT`, `3101` on this host), the Compose project is `notted-dev`,
and PostgreSQL/Redis are reachable on `5433`/`6380` only while
`docker/compose.debug-ports.yml` is layered in (`pnpm infra:up:ports`).

Export the token first:

```sh
export METRICS_TOKEN=…                       # same value the API container has
m() { curl -s -H "Authorization: Bearer $METRICS_TOKEN" localhost:3101/metrics; }
```

### 1. Redis down

```sh
docker compose -p notted-dev stop redis
```

| | |
| --- | --- |
| Metric | `notted_dependency_up{dependency="redis"}` → `0`; `queue` follows; `notted_queue_jobs` stops updating and holds its last value |
| Alert | `NottedDependencyDown` (critical) after 5 m |
| Log | `{"msg":"Dependency client error","dependency":"redis","status":"down"}` and `"Queue client error"` |
| Also | `GET /health/ready` → `503` |

Recover with `docker compose -p notted-dev start redis`.

### 2. Meilisearch down

```sh
docker compose -p notted-dev stop meilisearch
```

| | |
| --- | --- |
| Metric | `notted_dependency_up{dependency="meilisearch"}` → `0` |
| Alert | `NottedDependencyDown` after 5 m |
| Log | readiness failure line for the dependency; **no secret and no index name** |
| Note | With search disabled by feature flag the gauge reads `1` (`disabled`), and that is correct — a switched-off dependency is not an outage |

### 3. MinIO down

```sh
docker compose -p notted-dev stop minio
```

| | |
| --- | --- |
| Metric | `notted_dependency_up{dependency="minio"}` → `0`; new exports settle `storage_unavailable`, visible on `notted_export_duration_seconds_count{outcome="storage_unavailable"}` |
| Alert | `NottedDependencyDown`; `NottedExportFailureRate` if exports keep being requested |
| Log | `"Export artefact could not be stored"` with `errorClass` only — never the object key, never the endpoint |

### 4. Failed export

Request an export, then revoke the requester's access to the source note (or
delete the note) before the job runs.

| | |
| --- | --- |
| Metric | `notted_export_duration_seconds_count{outcome="source_forbidden"}` (or `source_unavailable`) increments; `notted_export_bytes` does **not** |
| Alert | `NottedExportFailureRate` (warning) once failures pass 20 % over 30 m |
| Log | export worker line with `outcome` and `errorClass`; the row records the same `error_code` |

### 5. Database pool saturation

Restart the API with `DATABASE_POOL_MAX_CONNECTIONS=1` and issue concurrent
requests:

```sh
# Any database-backed route; the readiness probe takes the pool too.
for i in $(seq 1 25); do curl -s "localhost:3101/health/ready" >/dev/null & done; wait
m | grep notted_database_pool_connections
```

| | |
| --- | --- |
| Metric | `notted_database_pool_connections{state="waiting"} > 0`; `notted_database_pool_max` reads `1` |
| Alert | `NottedDatabasePoolSaturated` (critical) after 5 m |
| Log | request lines with `durationMs` climbing while `statusCode` stays `200` — the signature of queueing rather than failing |

### 6. Forced 500

Point a request at a handler that throws (or stop PostgreSQL and issue any
database-backed request):

| | |
| --- | --- |
| Metric | `notted_api_errors_total{error_type="…",status_class="5xx"}` increments; `notted_http_request_duration_seconds_count{status_class="5xx"}` follows |
| Alert | `NottedHighErrorRate` (critical) once 5xx passes 5 % over 10 m |
| Log | `"Unhandled HTTP exception"` with `requestId`, `method`, the **bounded** `route`, `statusCode`, `errorType` and `errorSite` — no message, no stack, no path parameters |

### Confirm no secrets are exposed

Both greps must print `0`:

```sh
m | grep -Eic 'secret|password|redis://|postgres://'   # expect 0
m | grep -Ec  '[0-9a-f]{8}-[0-9a-f]{4}-'               # expect 0
```

---

# Alert reference

One section per rule in `ops/prometheus/alerts.yml`.

## Critical

### NottedApiDown

**Meaning.** Prometheus cannot scrape the instance at all. `up` is synthesized by
Prometheus itself, so this fires even when the process is too broken to serve
`/metrics` — the one case no application metric can cover.

**First checks.** `docker compose -p notted-dev ps api` · `curl -sf
localhost:3101/health/live` · Prometheus → Targets, read the scrape error.

**Likely causes.** Process down or crash-looping · wrong port or address in
`static_configs` · `METRICS_TOKEN` changed on one side only (the scrape gets a
`404`) · `421 UNTRUSTED_HOST` from `TrustedHostMiddleware` (see the warning
above) · the host's network policy.

**Remediation.** If `/health/live` answers, this is a scrape problem, not an
outage: fix the target, the token file or the `Host`. If it does not answer,
`docker compose -p notted-dev logs --tail=200 api` and treat it as a normal
process incident.

### NottedDependencyDown

**Meaning.** One dependency has failed readiness on **every** instance for five
minutes. The rule uses `max by (dependency)` because dependency health is a
global fact — one instance briefly failing a probe is not an outage.

**First checks.** `curl -s localhost:3101/health/ready | jq` names the
dependency and gives per-check `durationMs` · `docker compose -p notted-dev ps`.

**Likely causes.** The service is down or restarting · credentials or endpoint
misconfigured after a deploy · a network partition · the dependency is healthy
but slow enough to time out the probe.

**Remediation.** Restart or repair the dependency. Readiness has already taken
the instance out of rotation, so there is no traffic action to take. The five
minute window exists so a Redis failover or a MinIO restart does not page —
if this fires, it is not a blip.

### NottedHighErrorRate

**Meaning.** More than 5 % of HTTP responses have been `5xx` for ten minutes.

**First checks.** `sum by (error_type) (rate(notted_api_errors_total[5m]))`
names the exception class · `sum by (route) (rate(...{status_class="5xx"}[5m]))`
names the surface · then `grep '"errorSite"' `on the API logs for the file and
line.

**Likely causes.** A dependency outage surfacing as 500s · a bad deploy · an
unhandled exception on a hot path · pool exhaustion (check
`NottedDatabasePoolSaturated` alongside).

**Remediation.** `errorType` + `errorSite` together are usually enough to find
the code without reading a stack. If the errors began at a deploy, roll back
first and diagnose after.

### NottedDatabasePoolSaturated

**Meaning.** Requests have been queueing for a PostgreSQL connection for five
minutes. This is a latency **cliff**, not a gradual slowdown: everything past
the pool waits.

**First checks.** Compare `notted_database_pool_connections{state="waiting"}`
with `notted_database_pool_max` · `notted_http_request_duration_seconds` p95 ·
`SELECT state, count(*) FROM pg_stat_activity GROUP BY state`.

**Likely causes.** A slow or unindexed query holding connections · a long
transaction · `DATABASE_POOL_MAX_CONNECTIONS` too low for the workload · a
connection leak (a `transaction()` that never settles).

**Remediation.** Find the long-running statements in `pg_stat_activity` first —
raising `max` on a leak just delays the same alert. Raise the ceiling only once
the queries are understood, and remember PostgreSQL's own `max_connections`
bounds every instance's pool put together.

## Warning

### NottedQueueBacklog

**Meaning.** One physical queue has held more than 500 waiting jobs for fifteen
minutes. Not necessarily an incident — a bulk import legitimately produces a
backlog that drains.

**First checks.** Is throughput non-zero?
`sum by (queue) (rate(notted_queue_job_duration_seconds_count[15m]))` · is the
backlog shrinking? · Bull Board at `/admin/queues` (operator session required).

**Likely causes.** A genuine burst · worker concurrency too low for the lane · a
slow handler (check the duration histogram for that queue) · retries recycling
the same jobs.

**Remediation.** If throughput is healthy and the depth is falling, wait. If the
depth is flat, this is really `NottedQueueStalled` — read that section.

### NottedQueueStalled

**Meaning.** **The failure no health check sees.** Work is waiting and *nothing
is completing*. Redis is up, the queue client is connected, `/health/ready` is
green. Depth alone cannot express this (a busy queue is also deep) and
throughput alone cannot either (an idle queue also has zero throughput) — the
conjunction is the signal.

**First checks.** `docker compose -p notted-dev logs api | grep "Queue job"` —
silence is the confirmation · `notted_queue_client_errors_total` · are workers
registered for that lane at all?

**Likely causes.** Workers never started or were paused during a shutdown that
did not finish · every job failing before the completion log line · a handler
deadlocked past its timeout · the lane has no registered handler.

**Remediation.** Restart the API to re-establish workers, then confirm
`notted_queue_job_duration_seconds_count` starts moving. If jobs are failing
rather than hanging, `NottedDeadLettersRising` should be firing too — follow
that instead.

### NottedDeadLettersRising

**Meaning.** More than five jobs reached terminal failure in fifteen minutes.
Every one is a side effect that will **not** be retried.

**First checks.** The dead-letter queue in Bull Board · `SELECT job_type,
last_error_code, count(*) FROM job_outbox WHERE status = 'failed' GROUP BY 1, 2`
· the worker log lines carry `reason` and `correlationId`.

**Likely causes.** A permanent handler error (`payload_invalid`,
`version_unsupported`, `handler_missing`) after a deploy that changed a payload
shape · a dependency that stayed down past the retry budget · a poison job.

**Remediation.** Group by `last_error_code` first — one code across many jobs is
a code problem, many codes is an infrastructure problem. Replay through the Bull
Board retry path once the cause is fixed; every handler is idempotent by
contract.

### NottedOutboxStuck

**Meaning.** Durable intents are committing but never being published. **No
BullMQ metric can see this** — the jobs never reach BullMQ at all — which is why
this gauge exists.

**The alert is scoped to `consumable="yes"`, and that is not a detail.** A
`job_outbox` row whose job type has no registered handler is re-claimed and
re-deferred by `OutboxDispatcherService`'s rollout safety gate *forever*, by
design. Those rows are permanently `pending` and are **not** evidence of a
stalled dispatcher — an unfiltered expression would fire fifteen minutes into
any deployment and never clear. If this alert is firing, the backlog is rows
that genuinely have a consumer and genuinely are not draining.

**First checks.** `SELECT status, count(*) FROM job_outbox GROUP BY status` ·
`SELECT job_type, count(*) FROM job_outbox WHERE status = 'pending' GROUP BY 1
ORDER BY 2 DESC` — the split matters, see below ·
`SELECT min(created_at) FROM job_outbox WHERE status = 'pending'` — how far
behind · are BullMQ queues *empty* while this is deep? That combination is the
diagnosis.

**Likely causes.** The dispatcher is not running · it cannot reach Redis while
PostgreSQL stays healthy · rows are locked by an interrupted claim · publication
is throwing before it reaches the queue.

**The saturation case, and why it can no longer happen.** The dispatcher claims
`batchSize` rows every `intervalMs` — 100 per second by default. It used to
claim rows of every job type, including those no process consumes, and re-defer
each one by `staleClaimMs` (30 s). That draws `count / staleClaimMs` rows per
second from the budget, so past roughly
`batchSize × staleClaimMs / intervalMs` = **3,000** unconsumable pending rows
the dispatcher had nothing left for real work and consumable jobs starved behind
them — with no stuck `dispatching` row and no effect from restarting the API, so
it looked like every other cause. It is why the `consumable` label exists.

Two changes closed it, and both are load-bearing:

- job types declared `consumer: "none"` (`OutboxJobDefinition.consumer`, set for
  the 27 `note.*` / `folder.*` / `project.*` / `tag.*` / `task.*` /
  `attachment.*` domain events) are excluded from the claim query itself, so
  they cost no capacity at any depth;
- the `queue.idempotency.cleanup` sweep cancels those rows past
  `QUEUE_OUTBOX_RETENTION_DAYS` (30 by default) and deletes terminal
  `job_outbox` rows past the same age, which is also the only thing bounding
  ordinary `completed` growth.

The marker is static per job type and deliberately not read from
`QueueHandlerRegistry`: that set is per process, so a registry-driven rule would
strand or cancel intents another process handles. A rollout that ships a
producer before its consumer is unaffected — those types carry no marker, so the
dispatcher still claims and re-defers them, holding the intent intact until the
consumer deploys.

**Remediation.** Restart the API to restart the dispatcher and watch
`notted_job_outbox_rows{status="pending", consumable="yes"}` fall. If it does
not, look for rows stuck in `dispatching` with an old `locked_at` — that is a
claim that never released. `consumable="no"` being large is expected and is not
this alert's concern; if it is *growing without bound*, check that the
maintenance lane is draining `queue.idempotency.cleanup` at all.

### NottedExportSlow

**Meaning.** p95 export generation has exceeded 60 s for fifteen minutes.
Measured in process from claim to settled outcome, so it excludes queue wait.

**First checks.** Split by format —
`histogram_quantile(0.95, sum by (le, format) (rate(...[30m])))`. PDF invokes
Chromium and is expected to be the slowest · `notted_export_bytes` p95 · host
CPU and memory.

**Likely causes.** Very large notes or ZIP exports with many attachments · a
Chromium that is starved of memory · MinIO uploads slow · export concurrency
contending with the rest of the API.

**Remediation.** If the size histogram moved with the duration, it is the input,
not a regression. If duration rose while size did not, look at the host and at
Chromium.

### NottedExportFailureRate

**Meaning.** More than 20 % of export jobs settled with a failure outcome over
thirty minutes. The selector is `outcome!~"ready|replayed"` so a new outcome is
counted as a failure by default rather than being silently excluded.

**First checks.** `sum by (outcome) (rate(notted_export_duration_seconds_count[30m]))`
names it directly. `source_forbidden`/`source_unavailable` are **user
behaviour**, not incidents; `storage_unavailable`/`generation_failed` are.

**Likely causes.** MinIO down (`storage_unavailable`) · a renderer bug
(`generation_failed`) · a burst of exports for notes that were deleted or whose
access was revoked.

**Remediation.** If the dominant outcome is `source_*`, close the alert and
consider whether the threshold suits this deployment's usage. Otherwise treat it
as the underlying dependency or renderer incident.

### NottedAiRefusals

**Meaning.** The governance gate has been refusing requests for thirty minutes.
A refusal is a **real usage event** — `recordRefusal` writes an `ai_usage` row —
so this says a workspace is hitting its ceiling, not that AI "stopped working".
Warning, never critical: refusing is the gate working.

**First checks.** `sum by (feature) (rate(notted_ai_requests_total{status="rate_limited"}[15m]))`
· per-workspace detail through the authorized `GET /api/v1/ai/usage`, **not**
through metrics · `notted_ai_tokens_total` for the trend.

**Likely causes.** A workspace hit its daily token quota · the provider rate
limiter is saturated · an automation retrying a refused request in a loop.

**Remediation.** Confirm which workspace through the API, then either raise its
quota or find the retry loop. If Redis is down the limiter **denies by design**
— check `notted_dependency_up{dependency="redis"}` before touching quotas.

### NottedStorageGrowth

**Meaning.** Ready attachment bytes grew by more than the configured threshold
in 24 hours.

> **⚠️ This is a calibration knob, not a default.** 5 GiB/day is a guess. A
> single-team deployment will page the day someone imports a photo library; a
> deployment used for scanned documents will sit above it permanently and the
> rule becomes noise in week one. Watch `notted_storage_bytes` for a fortnight,
> take the ordinary daily delta, set the threshold to roughly **three times** it.
> What is being detected is a *runaway* — a retry loop re-uploading, a sweep that
> stopped reclaiming — not growth as such.

**First checks.** `max by (status) (notted_storage_bytes)` — growth in
`pending`/`processing` rather than `ready` means uploads are not completing ·
per-workspace usage through the quota surface · MinIO's own disk usage.

**Likely causes.** Legitimate bulk upload · a client retry loop re-uploading ·
the Part 45 sweep not reclaiming · a threshold that was never calibrated.

**Remediation.** Recalibrate first if it has never been tuned. Otherwise find the
workspace through the authorized quota surface and check whether its uploads are
completing.

### NottedEventLoopLag

**Meaning.** p99 event-loop lag on **one instance** has exceeded 250 ms for ten
minutes — something is blocking the loop. Deliberately not aggregated: one
wedged instance is the incident, and an average across the fleet would hide it.

**First checks.** `notted_nodejs_eventloop_lag_p99_seconds` by instance ·
`notted_process_cpu_user_seconds_total` rate · `notted_nodejs_heap_size_used_bytes`
· is an export or an image conversion running on that instance?

**Likely causes.** Synchronous CPU work on the request thread (rendering, image
processing, a large JSON parse) · GC pressure from a leak · the host is
oversubscribed.

**Remediation.** Correlate with the queue and export metrics — heavy work is
supposed to be in a worker, so a lagging API instance usually means something
ran in-process that should not have. If heap is climbing monotonically, restart
to restore service and then hunt the leak.

### NottedWebsocketRejections

**Meaning.** More than half of realtime connection attempts have been refused
for fifteen minutes. Rejections cover unauthenticated, rate-limited,
over-concurrent-lease and Redis-unavailable alike — the counter has no reason
label because half of the reasons are client-controlled.

**First checks.** `notted_dependency_up{dependency="realtime"}` and `redis` —
the gateway refuses every connection when the Redis adapter is not ready ·
`notted_websocket_connections` (is anyone connected at all?) · auth error rates.

**Likely causes.** The Redis adapter is not ready · sessions expiring en masse ·
a client reconnect storm hitting the per-principal limit · the concurrent socket
lease ceiling reached.

**Remediation.** If Redis is the cause, this is a symptom of
`NottedDependencyDown` and resolves with it. If Redis is healthy, look for a
client retrying without backoff — the limiter is doing its job.
