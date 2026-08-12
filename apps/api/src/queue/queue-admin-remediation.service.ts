import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { DatabaseService } from "../database/database.service";

import { registeredJobDefinition } from "./job-registry";
import { QueueInfrastructureService } from "./queue-infrastructure.service";
import { PHYSICAL_QUEUE_NAMES, type PhysicalQueueName } from "./queue-names";

import type { AuthenticatedPrincipal } from "@notted/shared-types";

export interface QueueRetryAudit {
  readonly requestId: string;
  readonly auditId: string;
}

interface RetryOutboxRow {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly jobType: string;
}

@Injectable()
export class QueueAdminRemediationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly infrastructure: QueueInfrastructureService,
  ) {}

  async prepareRetry(input: {
    readonly queueName: string;
    readonly jobId: string;
    readonly requestId: string;
    readonly operator: AuthenticatedPrincipal;
  }): Promise<QueueRetryAudit> {
    if (!Object.values(PHYSICAL_QUEUE_NAMES).includes(input.queueName as PhysicalQueueName)) {
      throw new Error("QUEUE_ADMIN_RETRY_DENIED");
    }
    const state = await this.infrastructure.administrativeJobState(
      input.queueName as PhysicalQueueName,
      input.jobId,
    );
    if (state !== "failed") throw new Error("QUEUE_ADMIN_RETRY_DENIED");

    return this.database.transaction(async (tx) => {
      const result = await tx.execute(sql`
        select o.id, o.idempotency_key as "idempotencyKey", o.job_type as "jobType"
        from job_outbox o
        left join job_idempotency i on i.key = o.idempotency_key
        where o.id = ${input.jobId} and (
          (o.status = 'failed' and i.status in ('failed', 'reconciliation_required'))
          or (o.status = 'dispatched' and i.status = 'pending')
        )
        for update
      `);
      const row = rowsOf<RetryOutboxRow>(result)[0];
      if (row === undefined) throw new Error("QUEUE_ADMIN_RETRY_DENIED");
      const definition = registeredJobDefinition(row.jobType);
      if (definition?.route.physicalQueueName !== input.queueName) {
        throw new Error("QUEUE_ADMIN_RETRY_DENIED");
      }
      const auditIdResult = await tx.execute(sql`
        insert into platform_admin_audits
          (operator_user_id, action, queue_name, job_id, request_id, phase, outcome)
        values (${input.operator.userId}, 'queue.retry', ${input.queueName}, ${input.jobId},
          ${input.requestId}, 'attempt', 'authorized') returning id
      `);
      const auditId = rowsOf<{ readonly id: string }>(auditIdResult)[0]?.id;
      if (auditId === undefined) throw new Error("QUEUE_ADMIN_AUDIT_FAILED");
      await tx.execute(sql`
        update job_idempotency set status = 'pending', error_message = null, updated_at = now()
        where key = ${row.idempotencyKey} and status in ('failed', 'reconciliation_required')
      `);
      await tx.execute(sql`
        update job_outbox set status = 'dispatched', last_error_code = null, updated_at = now()
        where id = ${row.id}
      `);
      return { requestId: input.requestId, auditId };
    });
  }

  async recordOutcome(audit: QueueRetryAudit, outcome: "succeeded" | "failed"): Promise<void> {
    const result = await this.database.db.execute(sql`
      insert into platform_admin_audits
        (operator_user_id, action, queue_name, job_id, request_id, phase, outcome, related_audit_id)
      select operator_user_id, action, queue_name, job_id, request_id, 'outcome', ${outcome}, ${audit.auditId}
      from platform_admin_audits where id = ${audit.auditId} and request_id = ${audit.requestId}
      returning id
    `);
    if (rowsOf<{ readonly id: string }>(result).length !== 1) {
      throw new Error("QUEUE_ADMIN_AUDIT_FAILED");
    }
  }

  async retry(input: {
    readonly queueName: string;
    readonly jobId: string;
    readonly requestId: string;
    readonly operator: AuthenticatedPrincipal;
  }): Promise<void> {
    const audit = await this.prepareRetry(input);
    try {
      await this.infrastructure.administrativeRetry(
        input.queueName as PhysicalQueueName,
        input.jobId,
      );
    } catch {
      await this.recordOutcome(audit, "failed");
      throw new Error("QUEUE_ADMIN_RETRY_FAILED");
    }
    await this.recordOutcome(audit, "succeeded");
  }
}

function rowsOf<T>(result: unknown): readonly T[] {
  if (typeof result !== "object" || result === null || !("rows" in result)) return [];
  const rows = (result as { readonly rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as readonly T[]) : [];
}
