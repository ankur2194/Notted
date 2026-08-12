import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { DatabaseService } from "../database/database.service";

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
}

/** Bounded replay-record cleanup; durable job_outbox intent is never touched. */
@Injectable()
export class JobIdempotencyCleanupService {
  constructor(
    private readonly repository: JobIdempotencyCleanupRepository,
    private readonly logger: StructuredLogger,
  ) {}

  async deleteExpired(): Promise<number> {
    let deleted = 0;
    let batches = 0;
    while (batches < MAX_BATCHES_PER_JOB) {
      const batchDeleted = await this.repository.deleteExpiredBatch(CLEANUP_BATCH_SIZE);
      deleted += batchDeleted;
      batches += 1;
      if (batchDeleted < CLEANUP_BATCH_SIZE) break;
    }
    this.logger.info(
      { maintenance: "job_idempotency", outcome: "completed", deleted, batches },
      "Expired queue replay records cleaned",
    );
    return deleted;
  }
}
