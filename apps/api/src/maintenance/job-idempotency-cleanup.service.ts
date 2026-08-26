import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { QUEUE_CONFIG, type QueueConfig } from "../config/queue.config";
import { DatabaseService } from "../database/database.service";
import { UNCONSUMED_JOB_TYPES } from "../queue/job-registry";

const CLEANUP_BATCH_SIZE = 500;
const MAX_BATCHES_PER_JOB = 10;

@Injectable()
export class JobIdempotencyCleanupRepository {
  constructor(private readonly database: DatabaseService) {}

  async deleteExpiredBatch(batchSize: number): Promise<number> {
    const result = await this.database.db.execute(sql`
       with expired as (
         select replay.id
         from job_idempotency replay
         left join job_outbox intent on intent.idempotency_key = replay.key
         where replay.expires_at <= now()
           and (
             intent.id is null
             or intent.status = 'cancelled'
             or (intent.status = 'completed' and replay.status = 'completed')
           )
         order by replay.expires_at, replay.id
         for update skip locked
         limit ${batchSize}
      )
      delete from job_idempotency as replay
      using expired
      where replay.id = expired.id
      returning replay.id
    `);
    const rows = (result as { readonly rows?: readonly unknown[] }).rows;
    return rows?.length ?? 0;
  }

  /**
   * Retires aged intents of types declared `consumer: "none"`. They are the only
   * rows that can sit non-terminal forever: the dispatcher never claims them, so
   * no other code path will ever move them out of `pending`. `cancelled` is the
   * state the enum has always carried for exactly this, and the replay-key
   * delete above already treats a cancelled intent as prunable.
   *
   * The marker is static per job type, never the per-process handler registry,
   * so a worker-only job type can never be cancelled by an API process that
   * simply does not register its handler.
   */
  async cancelUnconsumedBatch(batchSize: number, retentionDays: number): Promise<number> {
    const result = await this.database.db.execute(sql`
      with aged as (
        select id
        from job_outbox
        where job_type = any(${sql.param([...UNCONSUMED_JOB_TYPES])}::text[])
          and status in ('pending', 'dispatching', 'dispatched')
          and created_at <= now() - (${retentionDays} * interval '1 day')
        order by created_at, id
        for update skip locked
        limit ${batchSize}
      )
      update job_outbox as intent
      set status = 'cancelled', locked_at = null, updated_at = now()
      from aged
      where intent.id = aged.id
      returning intent.id
    `);
    const rows = (result as { readonly rows?: readonly unknown[] }).rows;
    return rows?.length ?? 0;
  }

  /**
   * Bounds ordinary growth. Every successful job leaves a `completed` row and
   * nothing deleted them, so the table grew by one row per mutation forever.
   * Terminal rows only: `failed` is left for operator remediation.
   */
  async deleteTerminalOutboxBatch(batchSize: number, retentionDays: number): Promise<number> {
    const result = await this.database.db.execute(sql`
      with retired as (
        select id
        from job_outbox
        where status in ('completed', 'cancelled')
          and updated_at <= now() - (${retentionDays} * interval '1 day')
        order by updated_at, id
        for update skip locked
        limit ${batchSize}
      )
      delete from job_outbox as intent
      using retired
      where intent.id = retired.id
      returning intent.id
    `);
    const rows = (result as { readonly rows?: readonly unknown[] }).rows;
    return rows?.length ?? 0;
  }
}

/**
 * Bounded queue-table maintenance. Runs in three ordered steps so the replay
 * key is only ever pruned once its intent is gone or terminal, which is the
 * invariant `deleteExpiredBatch` has always enforced through its join:
 *
 *   1. cancel aged intents nothing will ever consume,
 *   2. delete aged terminal intents,
 *   3. delete expired replay records.
 */
@Injectable()
export class JobIdempotencyCleanupService {
  constructor(
    private readonly repository: JobIdempotencyCleanupRepository,
    private readonly logger: StructuredLogger,
    @Inject(QUEUE_CONFIG) private readonly config: QueueConfig,
  ) {}

  private async drain(
    run: (batchSize: number) => Promise<number>,
  ): Promise<{ readonly affected: number; readonly batches: number }> {
    let affected = 0;
    let batches = 0;
    while (batches < MAX_BATCHES_PER_JOB) {
      const batchAffected = await run(CLEANUP_BATCH_SIZE);
      affected += batchAffected;
      batches += 1;
      if (batchAffected < CLEANUP_BATCH_SIZE) break;
    }
    return { affected, batches };
  }

  async deleteExpired(): Promise<number> {
    const retentionDays = this.config.outboxRetentionDays;
    const cancelled = await this.drain((batchSize) =>
      this.repository.cancelUnconsumedBatch(batchSize, retentionDays),
    );
    const retired = await this.drain((batchSize) =>
      this.repository.deleteTerminalOutboxBatch(batchSize, retentionDays),
    );
    const expired = await this.drain((batchSize) => this.repository.deleteExpiredBatch(batchSize));

    this.logger.info(
      {
        maintenance: "job_idempotency",
        outcome: "completed",
        deleted: expired.affected,
        batches: expired.batches,
        outboxCancelled: cancelled.affected,
        outboxDeleted: retired.affected,
        outboxRetentionDays: retentionDays,
      },
      "Expired queue replay records cleaned",
    );
    return expired.affected;
  }
}
