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
  NOTE_VERSION_RETENTION_JOB_DEFINITION,
  NOTE_VERSION_RETENTION_SOURCE_QUEUE_NAME,
} from "../queue/job-registry";
import { PermanentQueueJobError } from "../queue/queue-errors";
import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";

import { NoteVersionRetentionService } from "./note-version-retention.service";

import type { z } from "zod";

export const NOTE_VERSION_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const NOTE_VERSION_RETENTION_KEY_PREFIX = "note-version-retention:" as const;

type RetentionContext = QueueJobContext<
  typeof NOTE_VERSION_RETENTION_JOB_DEFINITION.jobType,
  z.output<typeof NOTE_VERSION_RETENTION_JOB_DEFINITION.payloadSchema>
>;

/** Durable global scheduler and maintenance-lane handler for version retention. */
@Injectable()
export class NoteVersionRetentionQueueService
  implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown
{
  readonly jobType = NOTE_VERSION_RETENTION_JOB_DEFINITION.jobType;
  private unregister?: () => void;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly retention: NoteVersionRetentionService,
    private readonly registry: QueueHandlerRegistry,
    private readonly database: DatabaseService,
    private readonly logger: StructuredLogger,
  ) {}

  onModuleInit(): void {
    this.unregister = this.registry.register(
      defineQueueJobRegistration({
        definition: NOTE_VERSION_RETENTION_JOB_DEFINITION,
        handler: this,
      }),
    );
    this.timer = setInterval(() => this.kick(), NOTE_VERSION_RETENTION_INTERVAL_MS);
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
        { outcome: "error", reason: "note_version_retention_intent" },
        "Note version retention intent scheduling failed",
      );
    });
  }

  private async enqueuePeriod(now: Date): Promise<void> {
    const periodStartMs =
      Math.floor(now.getTime() / NOTE_VERSION_RETENTION_INTERVAL_MS) *
      NOTE_VERSION_RETENTION_INTERVAL_MS;
    const outboxId = randomUUID();
    const payload: JobOutboxPayload = Object.freeze({
      action: NOTE_VERSION_RETENTION_JOB_DEFINITION.jobType,
      intentId: outboxId,
    });
    await this.database.db
      .insert(jobOutbox)
      .values({
        id: outboxId,
        queueName: NOTE_VERSION_RETENTION_SOURCE_QUEUE_NAME,
        jobType: NOTE_VERSION_RETENTION_JOB_DEFINITION.jobType,
        payloadVersion: NOTE_VERSION_RETENTION_JOB_DEFINITION.payloadVersion,
        payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        idempotencyKey: `${NOTE_VERSION_RETENTION_KEY_PREFIX}${periodStartMs}`,
      })
      .onConflictDoNothing({ target: jobOutbox.idempotencyKey });
  }
}
