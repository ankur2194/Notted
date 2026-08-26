# Observability Standard

- Emit structured logs with service, environment, request/job ID, safe entity IDs, duration, and outcome.
- Never log secrets, authorization headers, cookies, raw content, uploaded contents, or full AI prompts.
- Separate liveness from dependency-aware readiness.
- Measure HTTP, database pools, queues, WebSockets, dependencies, exports, storage, and AI quota usage.
- Make alerts actionable with runbooks and avoid noisy transient paging.
- Preserve correlation across requests, transactions, jobs, webhooks, and emails.

## Part 78 — implementation

- Metrics are Prometheus text exposition on `GET /metrics`, unversioned beside the health
  probes, authenticated with a `METRICS_TOKEN` bearer and answering **404** — never 401 —
  when the token is unset or wrong. No monitoring container is added; `ops/` holds the
  scrape config, alert rules, their `promtool` unit tests, and one Grafana dashboard.
- **Labels are an allow-list.** Compile-time literals, bounded enums, or a value passed
  through `metricLabel()` / `httpRouteLabel()`. `workspaceId`, `userId`, any entity id,
  `requestId`, email, IP, raw path, raw error message, object key and realtime room name
  are forbidden on every metric — for cardinality *and* because `/metrics` has a weaker
  auth boundary than the API. Per-tenant numbers stay on their authorized endpoints.
- **Every scrape-time collector is failure-isolated.** `Registry.metrics()` awaits
  `Promise.all`, so one rejecting `collect()` would 500 the whole scrape and lose every
  unrelated signal exactly when a dependency is down. Each keeps its previous value.
- Dependency gauges reuse `ReadinessService` and its 1 s cache rather than probing
  separately, so monitoring does not double the load every dependency check imposes.
- Correlation is one id end to end: `X-Request-Id` → request log → an
  `AsyncLocalStorage` → `job_outbox.correlation_id` (defaulted in the schema, so all 22
  producers are covered) → job logs → dead-letter record → audit rows.
- `LogMetadata` is scalars-only by design; a 5xx line carries `errorSite` reduced to
  `file:line:col`, never a stack or a message. Container logs are size-bounded in
  `compose.yaml` (10 MB × 5 per service).
- Every alert has a `for:` duration and a `runbook_url`. Signals read from a **shared
  store** (queue depth, outbox, storage, dependency health) aggregate with `max by()`;
  per-instance signals use `sum()`. Getting that backwards moves the threshold by the
  replica count.
- Full reference: [`docs/runbooks/observability.md`](../runbooks/observability.md).
