// Part 78 — the only injectable in this directory.
//
// Everything here is a SCRAPE-TIME reading: a number that exists in PostgreSQL,
// Redis or the pool and is not worth pushing into a counter on every write.
// `prom-client` calls `collect()` on each metric while building the response,
// which is why this service exists at all — the recording sites elsewhere in
// the codebase can import a const, but a scrape-time reader needs the database,
// the queue seam and the readiness cache injected.
//
// ═══ THE ONE RULE THIS FILE EXISTS TO ENFORCE ═══
//
// EVERY collect() callback below is wrapped in try/catch and keeps its previous
// value on failure. This is not defensive habit, it is the correctness property
// of the whole endpoint: `Registry.metrics()` awaits `Promise.all` over every
// metric's `get()`, so ONE rejecting collector rejects the entire scrape. The
// endpoint would then return 500 and Prometheus would record NO sample for any
// metric — event-loop lag, HTTP rate, error rate, all of it — at the exact
// moment a dependency is down. Losing every unrelated signal because one
// optional reading failed is the inverse of what monitoring is for.
//
// Caching is a bare `nextAt` timestamp per collector rather than a cache class:
// a gauge already retains its last value between scrapes, so "skip the query
// and return" IS the cache. `nextAt` advances only on success, so a failed read
// is retried on the next scrape instead of being suppressed for a full TTL.

import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { inArray, sql } from "drizzle-orm";

import { DATABASE_CONFIG, type DatabaseConfig } from "../config/database.config";
import { DatabaseService } from "../database/database.service";
import { attachments, jobOutbox } from "../database/schema";
import { ReadinessService } from "../health/readiness.service";
import { QUEUE_METRICS_SOURCE, type QueueMetricsSource } from "../queue/queue-metrics.source";
import { QUOTA_CHARGED_STATUSES } from "../storage/storage-quota";

import {
  databasePoolConnections,
  databasePoolMax,
  dependencyUp,
  jobOutboxRows,
  metricLabel,
  queueJobs,
  setCollect,
  storageBytes,
} from "./metrics.registry";

/**
 * BullMQ counts are a Redis round trip per queue, so 15 s is roughly one read
 * per scrape at the 15 s scrape interval in `ops/prometheus/prometheus.yml`
 * while a second scraper or a manual `curl` costs nothing extra.
 */
const QUEUE_DEPTH_TTL_MS = 15_000;
/** A grouped count over `job_outbox`; cheaper than the queues, still a query. */
const OUTBOX_DEPTH_TTL_MS = 30_000;
/** A `sum()` over every attachment row. Storage growth is a weekly trend. */
const STORAGE_TTL_MS = 60_000;

/**
 * The statuses worth counting. `completed` and `cancelled` are deliberately
 * excluded: they are terminal history that grows without bound and answers no
 * operational question, and excluding them keeps the aggregate on the existing
 * `job_outbox_dispatcher_idx (status, available_at)` index.
 */
const OUTBOX_TRACKED_STATUSES = ["pending", "dispatching", "dispatched", "failed"] as const;

const numeric = (value: string | number | null | undefined): number => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

@Injectable()
export class MetricsCollectorsService implements OnModuleInit {
  private queueNextAt = 0;
  private outboxNextAt = 0;
  private storageNextAt = 0;

  constructor(
    private readonly readiness: ReadinessService,
    @Inject(QUEUE_METRICS_SOURCE) private readonly queues: QueueMetricsSource,
    private readonly database: DatabaseService,
    @Inject(DATABASE_CONFIG) private readonly databaseConfig: DatabaseConfig,
  ) {}

  onModuleInit(): void {
    databasePoolMax.set(this.databaseConfig.poolMaxConnections);

    setCollect(dependencyUp, () => this.safely(() => this.collectDependencies()));
    setCollect(queueJobs, () => this.safely(() => this.collectQueueDepth()));
    setCollect(jobOutboxRows, () => this.safely(() => this.collectOutboxDepth()));
    setCollect(databasePoolConnections, () => this.safely(() => this.collectPool()));
    setCollect(storageBytes, () => this.safely(() => this.collectStorage()));
  }

  /**
   * The guard. A rejected `collect()` fails `register.metrics()` outright, so
   * the failure is swallowed and the gauge keeps whatever it last held. There is
   * deliberately no log here: a collector runs on every scrape, so a persistent
   * dependency outage would write a log line every 15 s forever — and the
   * outage is already visible in `notted_dependency_up` and `/health/ready`.
   */
  private async safely(collect: () => Promise<void>): Promise<void> {
    try {
      await collect();
    } catch {
      // Intentionally silent; see above.
    }
  }

  /**
   * Reuses `ReadinessService`, so a scrape rides the same 1 s cache and
   * in-flight de-duplication `/health/ready` uses instead of opening a second
   * SMTP connection and a second MinIO round trip every 15 s.
   */
  private async collectDependencies(): Promise<void> {
    const readiness = await this.readiness.getReadiness();
    for (const check of readiness.checks) {
      // `disabled` reports 1: a switched-off dependency is a configuration
      // choice, not an outage, and `/health/ready` agrees.
      dependencyUp.set(
        { dependency: metricLabel(check.name, 32) },
        check.status === "down" ? 0 : 1,
      );
    }
  }

  private async collectQueueDepth(): Promise<void> {
    if (Date.now() < this.queueNextAt) return;
    const samples = await this.queues.jobCounts();
    for (const sample of samples) {
      const queue = metricLabel(sample.queue, 32);
      queueJobs.set({ queue, state: "waiting" }, sample.waiting);
      queueJobs.set({ queue, state: "active" }, sample.active);
      queueJobs.set({ queue, state: "delayed" }, sample.delayed);
      queueJobs.set({ queue, state: "failed" }, sample.failed);
    }
    this.queueNextAt = Date.now() + QUEUE_DEPTH_TTL_MS;
  }

  /**
   * The stalled-dispatcher signal. BullMQ can report every queue empty and
   * every dependency up while `job_outbox` fills with `pending` rows, because
   * the intent is durable in PostgreSQL and publication is a separate step
   * (ADR 0006). Nothing else in the system can see that failure.
   */
  private async collectOutboxDepth(): Promise<void> {
    if (Date.now() < this.outboxNextAt) return;
    const rows = await this.database.db
      .select({
        status: jobOutbox.status,
        jobType: jobOutbox.jobType,
        rows: sql<string>`count(*)`,
      })
      .from(jobOutbox)
      .where(inArray(jobOutbox.status, [...OUTBOX_TRACKED_STATUSES]))
      .groupBy(jobOutbox.status, jobOutbox.jobType);

    // The consumer set is read once per collection, not once per row: it is a
    // process-local Map and cannot change mid-scrape.
    const consumable = new Set(this.queues.consumableJobTypes());
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = `${row.status}\u0000${consumable.has(row.jobType) ? "yes" : "no"}`;
      counts.set(key, (counts.get(key) ?? 0) + numeric(row.rows));
    }

    // Every tracked status is written on every pass, in BOTH `consumable`
    // variants, including the ones the query returned nothing for: a series
    // that drops to zero must report zero rather than keep its last non-zero
    // value forever.
    for (const status of OUTBOX_TRACKED_STATUSES) {
      for (const flag of ["yes", "no"] as const) {
        jobOutboxRows.set({ status, consumable: flag }, counts.get(`${status}\u0000${flag}`) ?? 0);
      }
    }
    this.outboxNextAt = Date.now() + OUTBOX_DEPTH_TTL_MS;
  }

  /** In-memory `pg` counters; no query, no cache, no failure mode worth a TTL. */
  private collectPool(): Promise<void> {
    const stats = this.database.poolStats();
    databasePoolConnections.set({ state: "total" }, stats.total);
    databasePoolConnections.set({ state: "idle" }, stats.idle);
    // The saturation signal: clients queued because `max` is exhausted.
    databasePoolConnections.set({ state: "waiting" }, stats.waiting);
    return Promise.resolve();
  }

  /**
   * PLATFORM-WIDE, with no workspace label. Per-workspace usage is already
   * available (authorized) through the storage quota surface; exporting it here
   * would put every tenant's size behind the scrape token and mint one series
   * per workspace. The statuses come from `QUOTA_CHARGED_STATUSES` rather than
   * being re-listed, so "which bytes count" has exactly one definition.
   */
  private async collectStorage(): Promise<void> {
    if (Date.now() < this.storageNextAt) return;
    const rows = await this.database.db
      .select({
        status: attachments.processingStatus,
        bytes: sql<string>`coalesce(sum(${attachments.sizeBytes}), 0)`,
      })
      .from(attachments)
      .where(inArray(attachments.processingStatus, [...QUOTA_CHARGED_STATUSES]))
      .groupBy(attachments.processingStatus);

    const byStatus = new Map(rows.map((row) => [row.status, numeric(row.bytes)]));
    // Written for every charged status, including ones the query skipped: a
    // status that empties must report 0, not its last non-zero value.
    for (const status of QUOTA_CHARGED_STATUSES) {
      storageBytes.set({ status }, byStatus.get(status) ?? 0);
    }
    this.storageNextAt = Date.now() + STORAGE_TTL_MS;
  }
}
