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
  JOB_IDEMPOTENCY_CLEANUP_DEFINITION,
  JOB_IDEMPOTENCY_CLEANUP_SOURCE_QUEUE_NAME,
} from "../queue/job-registry";
import { PermanentQueueJobError } from "../queue/queue-errors";
import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";

import { JobIdempotencyCleanupService } from "./job-idempotency-cleanup.service";

import type { z } from "zod";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
export const JOB_IDEMPOTENCY_CLEANUP_KEY_PREFIX = "queue-idempotency-cleanup:" as const;

type CleanupContext = QueueJobContext<
  typeof JOB_IDEMPOTENCY_CLEANUP_DEFINITION.jobType,
  z.output<typeof JOB_IDEMPOTENCY_CLEANUP_DEFINITION.payloadSchema>
>;

/** Independent durable scheduler/handler so storage maintenance remains optional. */
@Injectable()
export class JobIdempotencyCleanupQueueService
  implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown
{
  readonly jobType = JOB_IDEMPOTENCY_CLEANUP_DEFINITION.jobType;
  private unregister?: () => void;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly cleanup: JobIdempotencyCleanupService,
    private readonly registry: QueueHandlerRegistry,
    private readonly database: DatabaseService,
    private readonly logger: StructuredLogger,
  ) {}

  onModuleInit(): void {
    this.unregister = this.registry.register(
      defineQueueJobRegistration({ definition: JOB_IDEMPOTENCY_CLEANUP_DEFINITION, handler: this }),
    );
    this.timer = setInterval(() => this.kick(), CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  async handle(context: CleanupContext): Promise<void> {
    if (context.payload.intentId !== context.outboxIntentId) {
      throw new PermanentQueueJobError("payload_invalid");
    }
    await this.cleanup.deleteExpired();
  }

  kick(now = new Date()): void {
    void this.enqueuePeriod(now).catch(() => {
      this.logger.failure(
        { outcome: "error", reason: "job_idempotency_cleanup_intent" },
        "Queue replay cleanup intent scheduling failed",
      );
    });
  }

  private async enqueuePeriod(now: Date): Promise<void> {
    const periodStartMs = Math.floor(now.getTime() / CLEANUP_INTERVAL_MS) * CLEANUP_INTERVAL_MS;
    const outboxId = randomUUID();
    const payload: JobOutboxPayload = Object.freeze({
      action: JOB_IDEMPOTENCY_CLEANUP_DEFINITION.jobType,
      intentId: outboxId,
    });
    await this.database.db
      .insert(jobOutbox)
      .values({
        id: outboxId,
        queueName: JOB_IDEMPOTENCY_CLEANUP_SOURCE_QUEUE_NAME,
        jobType: JOB_IDEMPOTENCY_CLEANUP_DEFINITION.jobType,
        payloadVersion: JOB_IDEMPOTENCY_CLEANUP_DEFINITION.payloadVersion,
        payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        idempotencyKey: `${JOB_IDEMPOTENCY_CLEANUP_KEY_PREFIX}${periodStartMs}`,
      })
      .onConflictDoNothing({ target: jobOutbox.idempotencyKey });
  }
}
