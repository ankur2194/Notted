// Part 78 — the one Prometheus registry and every metric object in the process.
//
// WHY MODULE-SCOPE CONSTS AND NOT A `MetricsService`. A Prometheus registry is
// process-global by nature: `prom-client` keeps the counters in the module, not
// in a DI container, and a metric is written from places DI cannot reach anyway
// (an Express middleware bound with `app.use`, a BullMQ `worker.on("error")`
// handler). Injecting a service into six feature modules to reach a global
// would add six constructor parameters, six module imports and six test doubles
// and change nothing about the value that is written. The ~7 recording sites
// import the const they need directly; the ONE injectable in this directory is
// `MetricsCollectorsService`, which exists because scrape-time collection needs
// the database, the queue and the readiness cache.
//
// THE LABEL RULE, which is the whole reason `metricLabel`/`httpRouteLabel`
// exist. Every label value on every metric below is either a compile-time
// literal, a value from a bounded enum, or passed through one of the two guards
// in this file. Two independent failures are being prevented:
//
//  1. CARDINALITY. Prometheus stores one time series per distinct label
//     combination and keeps it in memory. An unbounded label — a note id, a
//     workspace id, a raw URL path — turns one metric into millions of series
//     and takes the monitoring system down with the thing it was watching.
//  2. TENANT DISCLOSURE. `/metrics` has a WEAKER auth boundary than the API: a
//     shared bearer token read by a scraper, not a session with a workspace
//     membership behind it. A `workspaceId` or `userId` label would therefore
//     export the tenant graph to anyone holding the scrape token. That is why
//     the AI, storage and export metrics below are deliberately PLATFORM-WIDE:
//     per-workspace numbers already exist, authorized, at
//     `GET /api/v1/ai/usage` and the storage quota endpoints.
//
// The forbidden list is written out in `docs/runbooks/observability.md`. If a
// new metric needs a label that is not a literal or a bounded enum, it is
// almost certainly one of those two failures wearing a different hat.

import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

export const register = new Registry();

// Event-loop lag, heap, GC, handles, fds. These are the numbers that explain a
// slow API when every dependency reports healthy, and `prom-client` collects
// them from `process`/`perf_hooks` with no configuration.
collectDefaultMetrics({ register, prefix: "notted_" });

/**
 * Assign a scrape-time `collect()` callback to a gauge.
 *
 * `prom-client@15` declares `collect` only on the CONFIGURATION interface
 * (`GaugeConfiguration.collect?`), never on the `Gauge` class, even though the
 * registry reads `metric.collect` at scrape time and the property is the
 * documented way to drive a gauge from outside. Passing `collect` to the
 * constructor is not an option here: every collector in this codebase needs
 * `this` from a service that is constructed long after the metric const, and
 * two of them need an object (`server`, the pool) that only exists at runtime.
 * So the cast is confined to this one helper instead of being repeated at each
 * of the seven assignment sites.
 */
export function setCollect<T extends string>(
  metric: Gauge<T>,
  collect: () => void | Promise<void>,
): void {
  (metric as unknown as { collect: () => void | Promise<void> }).collect = collect;
}

/** Conservative label charset: anything a metric label may legitimately be. */
const SAFE_LABEL_PATTERN = /^[A-Za-z\d._:-]+$/u;

/**
 * The value if it is safe to use as a label, otherwise the literal `"other"`.
 *
 * Deliberately total: a caller never has to decide what to do with a hostile or
 * oversized value, because there is exactly one answer and it is applied here.
 */
export function metricLabel(value: string | undefined | null, max = 64): string {
  if (value === undefined || value === null) return "other";
  return value.length > 0 && value.length <= max && SAFE_LABEL_PATTERN.test(value)
    ? value
    : "other";
}

/** Prefix buckets for the three surfaces that are one route from Prometheus's view. */
const ROUTE_BUCKETS: readonly (readonly [string, string])[] = [
  // Every tRPC procedure arrives on one HTTP path; the procedure name rides in
  // the URL and is NOT a bounded set, so the whole surface is one label.
  ["/api/v1/trpc", "trpc"],
  // Better Auth owns dozens of sub-paths and adds more on upgrade.
  // DEFAULT PATH ONLY. `BETTER_AUTH_BASE_PATH` is operator-configurable
  // (`config/auth.config.ts`), and a deployment that changes it loses this
  // bucket: Better Auth is an `express.use` mount, so `request.route` is
  // undefined and those requests fall through to `"other"` rather than
  // minting a series per sub-path. A dead bucket and a blind spot, never a
  // cardinality risk.
  ["/api/auth", "auth"],
  // Bull Board serves an entire single-page app plus its assets.
  ["/admin/queues", "bull-board"],
];

const UUID_SEGMENT = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const HEX_SEGMENT = /^[\da-f]{12,}$/iu;
const DIGIT_SEGMENT = /^\d+$/u;
const MAX_ROUTE_SEGMENTS = 8;

/**
 * The hard ceiling. Sanitising segment-by-segment bounds the SHAPE of a label
 * but not the NUMBER of shapes: a scanner walking `/api/v1/aaa`, `/api/v1/aab`,
 * … mints a new series per request and every one of them survives the segment
 * rules. This cap is what makes the metric's memory cost finite regardless of
 * what arrives. 200 is comfortably above the real route count (the OpenAPI
 * document lists well under a hundred) and far below anything that hurts.
 */
const MAX_DISTINCT_ROUTES = 200;
const seenRoutes = new Set<string>();

/**
 * Whatever the HTTP adapter hands us; only `originalUrl`, `path` and `route`
 * are consulted.
 *
 * `originalUrl` is the one that matters. Express REWRITES `req.url` (and
 * therefore the `req.path` getter derived from it) when it dispatches into a
 * mount created with `app.use(prefix, handler)`, stripping the prefix — and it
 * only restores it in the `next()` callback, which a sub-handler that has
 * already ended the response never calls. Both surfaces this file exists to
 * bucket, `/api/v1/trpc` and `/api/auth`, are exactly such mounts, so by the
 * time the `finish` listener reads `req.path` it sees `/notes.list` or
 * `/sign-up/email` and the prefix buckets below never match. `originalUrl` is
 * never rewritten.
 */
export interface RequestLike {
  readonly originalUrl?: unknown;
  readonly path?: unknown;
  readonly route?: unknown;
}

/**
 * A bounded `route` label for one request.
 *
 * `request.route` is populated by Express only for requests that reached a
 * router-matched handler, which excludes every 404, every middleware-terminated
 * request (CSRF, trusted host, rate limit) and everything mounted with
 * `express.use`. So it is used when present and the URL is sanitised when it is
 * not — the sanitiser has to be correct on its own. Its absence is also what
 * makes a label ineligible to occupy a slot in the distinct-route cap.
 */
export function httpRouteLabel(request: RequestLike): string {
  // Structurally typed and narrowed at runtime rather than trusting `Request`:
  // this runs inside an exception filter, where `request` is whatever the
  // adapter handed the filter. A labeller that can throw would turn a handled
  // 404 into an unhandled crash — the exact inversion of its job.
  // `originalUrl` first, `path` only as a fallback for adapters that do not set
  // it (and for the synthetic requests in unit tests). The query string is cut
  // here: it is unbounded by definition.
  const raw =
    typeof request.originalUrl === "string"
      ? (request.originalUrl.split("?")[0] ?? "")
      : typeof request.path === "string"
        ? request.path
        : "";
  if (raw.length === 0) return "other";
  for (const [prefix, bucket] of ROUTE_BUCKETS) {
    if (raw === prefix || raw.startsWith(`${prefix}/`)) return bucket;
  }

  const route = request.route;
  const matched =
    typeof route === "object" &&
    route !== null &&
    typeof (route as { path?: unknown }).path === "string";
  const template = matched ? (route as { path: string }).path : raw;

  const segments = template.split("/").filter((segment) => segment.length > 0);
  if (segments.length > MAX_ROUTE_SEGMENTS) return "other";
  const normalized = `/${segments
    .map((segment) => {
      if (UUID_SEGMENT.test(segment) || HEX_SEGMENT.test(segment) || DIGIT_SEGMENT.test(segment)) {
        return ":id";
      }
      // Express templates already carry `:name`; anything else must survive the
      // same charset every other label does.
      return segment.startsWith(":") ? ":id" : metricLabel(segment, 48);
    })
    .join("/")}`;

  if (seenRoutes.has(normalized)) return normalized;
  // A path that matched NO route never registers a new label. Without this, an
  // unauthenticated scanner walking `/api/v1/scan1`, `/api/v1/scan2`, … fills
  // the cap with paths that do not exist and permanently forces every route
  // registered afterwards — including real ones — to `other`. The cap alone
  // bounds memory; this bounds who gets to spend it.
  if (!matched) return "other";
  if (seenRoutes.size >= MAX_DISTINCT_ROUTES) return "other";
  seenRoutes.add(normalized);
  return normalized;
}

/** `2xx`…`5xx`, never the raw status: 40 statuses × routes is 40× the series. */
export function statusClassLabel(statusCode: number): string {
  const hundreds = Math.floor(statusCode / 100);
  return hundreds >= 1 && hundreds <= 5 ? `${hundreds}xx` : "other";
}

// Test-only: the distinct-route cap is process-global state, so a test that
// fills it would poison every later test in the same worker.
export function resetRouteLabelCacheForTests(): void {
  seenRoutes.clear();
}

// ----------------------------------------------------------------------- HTTP

/**
 * Buckets are in SECONDS (the Prometheus convention) and are chosen around the
 * Part 77 API budget rather than `prom-client`'s defaults, so the p95 the
 * budget is written in terms of falls inside a bucket boundary instead of being
 * interpolated across a 2.5 s gap.
 */
export const httpRequestDurationSeconds = new Histogram({
  name: "notted_http_request_duration_seconds",
  help: "HTTP request duration in seconds.",
  labelNames: ["method", "route", "status_class"] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const httpRequestsInFlight = new Gauge({
  name: "notted_http_requests_in_flight",
  help: "HTTP requests currently being served.",
  registers: [register],
});

export const apiErrorsTotal = new Counter({
  name: "notted_api_errors_total",
  help: "Exceptions handled by the API exception filter, by error class.",
  labelNames: ["error_type", "status_class"] as const,
  registers: [register],
});

// --------------------------------------------------------------- dependencies

/**
 * 1 = up, 0 = down. A DISABLED dependency reports 1, matching
 * `/health/ready` exactly: a deployment that switched search off has not got an
 * outage, and a `dependency_up == 0` alert that pages for a deliberate
 * configuration choice is the noisy alert this part is supposed to avoid.
 */
export const dependencyUp = new Gauge({
  name: "notted_dependency_up",
  help: "Readiness of one dependency (1 = up or disabled, 0 = down).",
  labelNames: ["dependency"] as const,
  registers: [register],
});

// -------------------------------------------------------------- database pool

export const databasePoolConnections = new Gauge({
  name: "notted_database_pool_connections",
  help: "PostgreSQL pool clients by state (total, idle, waiting).",
  labelNames: ["state"] as const,
  registers: [register],
});

export const databasePoolMax = new Gauge({
  name: "notted_database_pool_max",
  help: "Configured maximum PostgreSQL pool size (DATABASE_POOL_MAX_CONNECTIONS).",
  registers: [register],
});

// ---------------------------------------------------------------------- queue

export const queueJobs = new Gauge({
  name: "notted_queue_jobs",
  help: "BullMQ job count per physical queue and state.",
  labelNames: ["queue", "state"] as const,
  registers: [register],
});

/**
 * The signal no BullMQ metric can produce. `job_outbox` is the DURABLE intent
 * (ADR 0006); a dispatcher that has stopped publishing leaves rows piling up at
 * `pending` while every BullMQ queue reads empty and every health check reads
 * up. Without this gauge that failure is invisible.
 */
export const jobOutboxRows = new Gauge({
  name: "notted_job_outbox_rows",
  help: "Rows in job_outbox by non-terminal status and whether a consumer exists.",
  // `consumable` is two values, never a job type: labelling by type would put
  // the domain event catalogue into the metric and grow with every new job.
  // The only question an alert asks is "can this row ever drain?", and that is
  // a boolean. `no` means no handler is registered for the row's job type, so
  // `OutboxDispatcherService`'s rollout safety gate re-defers it forever — a
  // permanent backlog that is not a stalled dispatcher.
  labelNames: ["status", "consumable"] as const,
  registers: [register],
});

export const queueJobDurationSeconds = new Histogram({
  name: "notted_queue_job_duration_seconds",
  help: "Queue job processing duration in seconds.",
  labelNames: ["queue", "outcome"] as const,
  buckets: [0.05, 0.25, 1, 5, 15, 30, 60, 300],
  registers: [register],
});

export const queueDeadLetterTotal = new Counter({
  name: "notted_queue_dead_letter_total",
  help: "Jobs published to the dead-letter queue.",
  labelNames: ["queue"] as const,
  registers: [register],
});

export const queueClientErrorsTotal = new Counter({
  name: "notted_queue_client_errors_total",
  help: "BullMQ client errors, by owning component.",
  labelNames: ["queue", "component"] as const,
  registers: [register],
});

// ----------------------------------------------------------------- websockets

export const websocketConnections = new Gauge({
  name: "notted_websocket_connections",
  help: "Realtime sockets currently connected to this instance.",
  registers: [register],
});

/**
 * Room COUNT only. There is deliberately no per-room gauge: a room name is a
 * per-note identifier, so labelling by room would be unbounded cardinality AND
 * a tenant-shaped identifier on the weakest-authenticated surface in the API.
 */
export const websocketRooms = new Gauge({
  name: "notted_websocket_rooms",
  help: "Realtime rooms currently held by this instance's adapter.",
  registers: [register],
});

export const websocketConnectionsTotal = new Counter({
  name: "notted_websocket_connections_total",
  help: "Realtime connection attempts by outcome.",
  labelNames: ["outcome"] as const,
  registers: [register],
});

// ------------------------------------------------------------------------- AI

export const aiRequestsTotal = new Counter({
  name: "notted_ai_requests_total",
  help: "AI provider requests recorded by the governance gate.",
  labelNames: ["provider", "model", "feature", "status"] as const,
  registers: [register],
});

export const aiTokensTotal = new Counter({
  name: "notted_ai_tokens_total",
  help: "AI tokens metered, by direction.",
  labelNames: ["provider", "model", "kind"] as const,
  registers: [register],
});

export const aiCostMicrosTotal = new Counter({
  name: "notted_ai_cost_micros_total",
  help: "Estimated AI cost in micros.",
  labelNames: ["provider", "model"] as const,
  registers: [register],
});

// -------------------------------------------------------------------- exports

/**
 * MEASURED IN PROCESS, NOT DERIVED FROM THE TABLE. `exports` has `created_at`
 * and `completed_at` but no `started_at`, so a table-derived duration would be
 * queue wait plus generation — and the known stuck-`processing` rows (see the
 * `ponytail:` note in `export.worker.service.ts`) would drag every percentile.
 * A `started_at` column was considered and rejected for exactly that reason.
 */
export const exportDurationSeconds = new Histogram({
  name: "notted_export_duration_seconds",
  help: "Export generation duration in seconds, from claim to settled outcome.",
  labelNames: ["format", "outcome"] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [register],
});

export const exportBytes = new Histogram({
  name: "notted_export_bytes",
  help: "Size in bytes of successfully generated export artefacts.",
  labelNames: ["format"] as const,
  buckets: [1_024, 16_384, 262_144, 1_048_576, 8_388_608, 33_554_432, 134_217_728],
  registers: [register],
});

// -------------------------------------------------------------------- storage

/**
 * BYTES ONLY, and one metric rather than two. A companion object-count gauge
 * was written and removed: a metric with no `collect()` of its own would be
 * serialized concurrently with — and therefore one scrape behind — the gauge
 * whose collector fills it, and giving it its own collector would run the same
 * aggregate twice per scrape. No alert needs the count.
 */
export const storageBytes = new Gauge({
  name: "notted_storage_bytes",
  help: "Attachment bytes charged against quota, platform-wide, by processing status.",
  labelNames: ["status"] as const,
  registers: [register],
});
