import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { QUEUE_CONFIG, type QueueConfig } from "../config/queue.config";
import { DatabaseService } from "../database/database.service";

import { outboxRuntimeRowSchema, type OutboxRuntimeRow } from "./queue-runtime.types";

import type { QueueFailureCode } from "./queue-errors";

function parseRows(value: unknown): readonly OutboxRuntimeRow[] {
  const rows = (value as { readonly rows?: unknown }).rows;
  return outboxRuntimeRowSchema.array().parse(rows ?? []);
}

@Injectable()
export class QueueOutboxRepository {
  constructor(
    private readonly database: DatabaseService,
    @Inject(QUEUE_CONFIG) private readonly config: QueueConfig,
  ) {}

  async claimBatch(batchSize: number, staleClaimMs: number): Promise<readonly OutboxRuntimeRow[]> {
    const result = await this.database.db.execute(sql`
      with candidates as (
        select id
        from job_outbox
        where (
          (status = 'pending' and available_at <= now())
           or (status = 'dispatching' and locked_at < now() - (${staleClaimMs} * interval '1 millisecond'))
           or (status = 'dispatched' and updated_at < now() - (${staleClaimMs} * interval '1 millisecond'))
        )
        order by available_at, created_at
        for update skip locked
        limit ${batchSize}
      )
      update job_outbox as intent
      set status = 'dispatching', locked_at = now(), updated_at = now()
      from candidates
      where intent.id = candidates.id
      returning intent.id,
        intent.queue_name as "queueName", intent.job_type as "jobType",
        intent.payload_version as "payloadVersion", intent.payload,
        intent.payload_hash as "payloadHash", intent.idempotency_key as "idempotencyKey",
        intent.status, intent.attempt_count as "attemptCount",
        intent.correlation_id as "correlationId"
    `);
    return parseRows(result);
  }

  async load(id: string): Promise<OutboxRuntimeRow | undefined> {
    const result = await this.database.db.execute(sql`
      select id, queue_name as "queueName", job_type as "jobType",
        payload_version as "payloadVersion", payload, payload_hash as "payloadHash",
        idempotency_key as "idempotencyKey", status,
        attempt_count as "attemptCount", correlation_id as "correlationId"
      from job_outbox where id = ${id} limit 1
    `);
    return parseRows(result)[0];
  }

  async releaseUnhandled(id: string, deferMs: number): Promise<void> {
    await this.database.db.execute(sql`
      update job_outbox set status = 'pending', locked_at = null,
        available_at = greatest(available_at, now() + (${deferMs} * interval '1 millisecond')),
        updated_at = now()
      where id = ${id} and status = 'dispatching'
    `);
  }

  async markDispatched(id: string): Promise<void> {
    await this.database.db.execute(sql`
      update job_outbox
      set status = 'dispatched', locked_at = null, dispatched_at = coalesce(dispatched_at, now()),
        updated_at = now()
      where id = ${id} and status = 'dispatching'
    `);
  }

  async recordRetry(id: string, reasonCode: QueueFailureCode): Promise<void> {
    await this.database.db.execute(sql`
      update job_outbox set attempt_count = attempt_count + 1,
        last_error_code = ${reasonCode}, updated_at = now()
      where id = ${id} and status in ('dispatching', 'dispatched')
    `);
  }

  /** Commits replay protection before handler work starts; never holds a DB transaction over I/O. */
  async claimExecution(
    row: OutboxRuntimeRow,
    retentionDays: number,
  ): Promise<"claimed" | "completed" | "reconciliation_required"> {
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`
        insert into job_idempotency (key, queue_name, status, payload_hash, expires_at)
        values (${row.idempotencyKey}, ${row.queueName}, 'pending', ${row.payloadHash},
          now() + (${retentionDays} * interval '1 day'))
        on conflict (key) do nothing
      `);
      const existingResult = await tx.execute(sql`
        select status, payload_hash as "payloadHash"
        from job_idempotency where key = ${row.idempotencyKey}
        for update
      `);
      const existing = (existingResult as { readonly rows?: readonly unknown[] }).rows?.[0] as
        { readonly status?: unknown; readonly payloadHash?: unknown } | undefined;
      if (existing === undefined || existing.payloadHash !== row.payloadHash) {
        throw new Error("QUEUE_IDEMPOTENCY_HASH_MISMATCH");
      }
      if (existing.status === "completed") {
        await tx.execute(sql`
          update job_outbox set status = 'completed', completed_at = coalesce(completed_at, now()),
            locked_at = null, updated_at = now()
          where id = ${row.id}
        `);
        return "completed";
      }
      if (existing.status === "processing" || existing.status === "reconciliation_required") {
        await tx.execute(sql`
          update job_idempotency set status = 'reconciliation_required',
            error_message = 'reconciliation_required', updated_at = now()
          where key = ${row.idempotencyKey}
        `);
        return "reconciliation_required";
      }
      await tx.execute(sql`
        update job_idempotency set status = 'processing', processing_started_at = now(),
          error_message = null, updated_at = now()
        where key = ${row.idempotencyKey}
      `);
      return "claimed";
    });
  }

  async completeExecution(row: OutboxRuntimeRow): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.execute(sql`
        update job_idempotency set status = 'completed', result = ${JSON.stringify({ outcome: "completed" })}::jsonb,
          error_message = null, updated_at = now()
        where key = ${row.idempotencyKey} and status = 'processing'
      `);
      await tx.execute(sql`
        update job_outbox set status = 'completed', completed_at = coalesce(completed_at, now()),
          locked_at = null, last_error_code = null, attempt_count = attempt_count + 1, updated_at = now()
        where id = ${row.id}
      `);
    });
  }

  async releaseExecution(row: OutboxRuntimeRow, reasonCode: QueueFailureCode): Promise<void> {
    await this.database.db.execute(sql`
      update job_idempotency set status = 'pending', error_message = ${reasonCode}, updated_at = now()
      where key = ${row.idempotencyKey} and status = 'processing'
    `);
  }

  async requireReconciliation(row: OutboxRuntimeRow, reasonCode: QueueFailureCode): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.execute(sql`
        update job_idempotency set status = 'reconciliation_required', error_message = ${reasonCode},
          updated_at = now() where key = ${row.idempotencyKey} and status <> 'completed'
      `);
      await tx.execute(sql`
        update job_outbox set status = 'failed', locked_at = null, last_error_code = ${reasonCode},
          attempt_count = attempt_count + 1, updated_at = now()
        where id = ${row.id} and status <> 'completed'
      `);
    });
  }

  async markFailed(row: OutboxRuntimeRow, reasonCode: QueueFailureCode): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.execute(sql`
        insert into job_idempotency (key, queue_name, status, payload_hash, error_message, expires_at)
        values (${row.idempotencyKey}, ${row.queueName}, 'failed', ${row.payloadHash}, ${reasonCode},
          now() + (${this.config.idempotencyRetentionDays} * interval '1 day'))
        on conflict (key) do update set status = 'failed', error_message = excluded.error_message,
          updated_at = now()
        where job_idempotency.status not in ('completed', 'reconciliation_required')
      `);
      await tx.execute(sql`
        update job_outbox set status = 'failed', locked_at = null,
          last_error_code = ${reasonCode}, attempt_count = attempt_count + 1, updated_at = now()
        where id = ${row.id} and status <> 'completed'
      `);
    });
  }
}
