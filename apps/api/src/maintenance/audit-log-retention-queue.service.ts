import { createHash, randomUUID } from "node:crypto";

import {
  Injectable,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { DatabaseService } from "../database/database.service";
import { jobOutbox, type JobOutboxPayload } from "../database/schema";
import { defineQueueJobRegistration, type QueueJobContext } from "../queue/job-contracts";
import {
  AUDIT_LOG_RETENTION_JOB_DEFINITION,
  AUDIT_LOG_RETENTION_SOURCE_QUEUE_NAME,
} from "../queue/job-registry";
import { PermanentQueueJobError } from "../queue/queue-errors";
import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";

import { AuditLogRetentionService } from "./audit-log-retention.service";

import type { z } from "zod";

export const AUDIT_LOG_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const AUDIT_LOG_RETENTION_KEY_PREFIX = "audit-log-retention:" as const;

type RetentionContext = QueueJobContext<
  typeof AUDIT_LOG_RETENTION_JOB_DEFINITION.jobType,
  z.output<typeof AUDIT_LOG_RETENTION_JOB_DEFINITION.payloadSchema>
>;

/** Durable global scheduler and maintenance-lane handler for audit log retention. */
@Injectable()
export class AuditLogRetentionQueueService
  implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown
{
  readonly jobType = AUDIT_LOG_RETENTION_JOB_DEFINITION.jobType;
  private unregister?: () => void;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly retention: AuditLogRetentionService,
    private readonly registry: QueueHandlerRegistry,
    private readonly database: DatabaseService,
    private readonly logger: StructuredLogger,
  ) {}

  onModuleInit(): void {
    this.unregister = this.registry.register(
      defineQueueJobRegistration({
        definition: AUDIT_LOG_RETENTION_JOB_DEFINITION,
        handler: this,
      }),
    );
    this.timer = setInterval(() => this.kick(), AUDIT_LOG_RETENTION_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  async handle(context: RetentionContext): Promise<void> {
    if (context.payload.intentId !== context.outboxIntentId) {
      throw new PermanentQueueJobError("payload_invalid");
    }
    await this.retention.purgeExpired();
  }

  kick(now = new Date()): void {
    void this.enqueuePeriod(now).catch(() => {
      this.logger.failure(
        { outcome: "error", reason: "audit_log_retention_intent" },
        "Audit log retention intent scheduling failed",
      );
    });
  }

  private async enqueuePeriod(now: Date): Promise<void> {
    const periodStartMs =
      Math.floor(now.getTime() / AUDIT_LOG_RETENTION_INTERVAL_MS) * AUDIT_LOG_RETENTION_INTERVAL_MS;
    const outboxId = randomUUID();
    const payload: JobOutboxPayload = Object.freeze({
      action: AUDIT_LOG_RETENTION_JOB_DEFINITION.jobType,
      intentId: outboxId,
    });
    await this.database.db
      .insert(jobOutbox)
      .values({
        id: outboxId,
        queueName: AUDIT_LOG_RETENTION_SOURCE_QUEUE_NAME,
        jobType: AUDIT_LOG_RETENTION_JOB_DEFINITION.jobType,
        payloadVersion: AUDIT_LOG_RETENTION_JOB_DEFINITION.payloadVersion,
        payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        idempotencyKey: `${AUDIT_LOG_RETENTION_KEY_PREFIX}${periodStartMs}`,
      })
      .onConflictDoNothing({ target: jobOutbox.idempotencyKey });
  }
}
