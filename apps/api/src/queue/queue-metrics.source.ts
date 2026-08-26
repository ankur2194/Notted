/**
 * Part 78 — the narrow read-only seam Prometheus collection uses.
 *
 * Mirrors `queue-readiness.indicator.ts` deliberately. `QueueModule` keeps the
 * BullMQ `Queue` clients, the Redis connections and `QueueInfrastructureService`
 * itself private, and that boundary is worth more than the convenience of
 * exporting the owner: a metrics collector that could reach a `Queue` could
 * also `add`, `drain` or `obliterate` one. This interface can only count.
 */
export const QUEUE_METRICS_SOURCE = Symbol("QUEUE_METRICS_SOURCE");

/** Counts for one physical queue. Names come from `PHYSICAL_QUEUE_NAMES`. */
export interface QueueDepthSample {
  readonly queue: string;
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly failed: number;
}

export interface QueueMetricsSource {
  /** Empty when Redis is absent or the runtime is shutting down. */
  jobCounts(): Promise<readonly QueueDepthSample[]>;

  /**
   * Job types with a concrete consumer registered in THIS process.
   *
   * A `job_outbox` row whose type is absent here can never drain: the
   * dispatcher's rollout safety gate re-claims and re-defers it every
   * `staleClaimMs` forever. Splitting the outbox gauge on this is what keeps
   * `NottedOutboxStuck` a signal about the dispatcher rather than a permanent
   * alarm about intents nothing consumes yet.
   */
  consumableJobTypes(): readonly string[];
}
