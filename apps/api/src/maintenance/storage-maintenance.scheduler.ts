import { createHash, randomUUID } from "node:crypto";

import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { STORAGE_CONFIG, type StorageConfig } from "../config/storage.config";
import { DatabaseService } from "../database/database.service";
import { jobOutbox, type JobOutboxPayload } from "../database/schema";
import {
  STORAGE_MAINTENANCE_JOB_DEFINITION,
  STORAGE_MAINTENANCE_SOURCE_QUEUE_NAME,
} from "../queue/job-registry";

export const STORAGE_MAINTENANCE_IDEMPOTENCY_PREFIX = "storage-maintenance-sweep:" as const;

/** Periodic durable-intent producer; it never executes maintenance directly. */
@Injectable()
export class StorageMaintenanceScheduler implements OnModuleInit, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly database: DatabaseService,
    private readonly logger: StructuredLogger,
    @Inject(STORAGE_CONFIG) private readonly config: StorageConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.maintenanceEnabled) return;
    this.timer = setInterval(() => this.kick(), this.config.maintenanceIntervalMs);
    this.timer.unref();
  }

  kick(now = new Date()): void {
    if (!this.config.maintenanceEnabled) return;
    void this.enqueuePeriod(now).catch(() => {
      this.logger.failure(
        { outcome: "error", reason: "storage_maintenance_intent" },
        "Storage maintenance intent scheduling failed",
      );
    });
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  private async enqueuePeriod(now: Date): Promise<void> {
    const periodStartMs =
      Math.floor(now.getTime() / this.config.maintenanceIntervalMs) *
      this.config.maintenanceIntervalMs;
    const outboxId = randomUUID();
    const payload: JobOutboxPayload = Object.freeze({
      action: STORAGE_MAINTENANCE_JOB_DEFINITION.jobType,
      intentId: outboxId,
    });
    await this.database.db
      .insert(jobOutbox)
      .values({
        id: outboxId,
        queueName: STORAGE_MAINTENANCE_SOURCE_QUEUE_NAME,
        jobType: STORAGE_MAINTENANCE_JOB_DEFINITION.jobType,
        payloadVersion: STORAGE_MAINTENANCE_JOB_DEFINITION.payloadVersion,
        payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        idempotencyKey: `${STORAGE_MAINTENANCE_IDEMPOTENCY_PREFIX}${periodStartMs}`,
      })
      .onConflictDoNothing({ target: jobOutbox.idempotencyKey });
  }
}
