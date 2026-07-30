import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { and, asc, eq, lte, sql } from "drizzle-orm";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import {
  AUTH_EMAIL_QUEUE_CONFIG,
  type AuthEmailQueueConfig,
} from "../config/auth-email-queue.config";
import { FEATURES_CONFIG, type FeaturesConfig } from "../config/features.config";
import { DatabaseService } from "../database/database.service";
import { jobOutbox } from "../database/schema";

import { AuthEmailQueueService } from "./auth-email-queue.service";
import { AUTH_EMAIL_JOB_TYPE } from "./auth-email.types";

@Injectable()
export class AuthEmailDispatcherService implements OnModuleInit, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly queue: AuthEmailQueueService,
    private readonly logger: StructuredLogger,
    @Inject(AUTH_EMAIL_QUEUE_CONFIG) private readonly config: AuthEmailQueueConfig,
    @Inject(FEATURES_CONFIG) private readonly features: FeaturesConfig,
  ) {}

  onModuleInit(): void {
    if (!this.features.emailEnabled) {
      return;
    }
    this.timer = setInterval(() => this.kick(), this.config.dispatcherIntervalMs);
    this.timer.unref();
    this.kick();
  }

  kick(): void {
    if (this.running || !this.features.emailEnabled) {
      return;
    }
    this.running = true;
    void this.dispatchPending().finally(() => {
      this.running = false;
    });
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
    }
  }

  private async dispatchPending(): Promise<void> {
    try {
      const staleBefore = new Date(Date.now() - 5 * 60 * 1_000);
      await this.database.db
        .update(jobOutbox)
        .set({
          status: "pending",
          lockedAt: null,
          lastErrorCode: "STALE_DISPATCH_RECLAIMED",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(jobOutbox.queueName, this.config.queueName),
            eq(jobOutbox.status, "dispatching"),
            lte(jobOutbox.lockedAt, staleBefore),
          ),
        );
      const pending = await this.database.db
        .select({ id: jobOutbox.id, payload: jobOutbox.payload })
        .from(jobOutbox)
        .where(
          and(
            eq(jobOutbox.queueName, this.config.queueName),
            eq(jobOutbox.jobType, AUTH_EMAIL_JOB_TYPE),
            eq(jobOutbox.status, "pending"),
            lte(jobOutbox.availableAt, new Date()),
          ),
        )
        .orderBy(asc(jobOutbox.availableAt))
        .limit(25);

      for (const intent of pending) {
        const intentId = intent.payload.intentId;
        if (typeof intentId !== "string") {
          await this.markFailed(intent.id, "INVALID_IDENTIFIER_PAYLOAD");
          continue;
        }
        const claimed = await this.database.db
          .update(jobOutbox)
          .set({
            status: "dispatching",
            lockedAt: new Date(),
            attemptCount: sql`${jobOutbox.attemptCount} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(jobOutbox.id, intent.id), eq(jobOutbox.status, "pending")))
          .returning({ id: jobOutbox.id });
        if (claimed.length === 0) {
          continue;
        }
        try {
          await this.queue.enqueue(intent.id, { intentId });
          await this.database.db
            .update(jobOutbox)
            .set({ status: "dispatched", dispatchedAt: new Date(), updatedAt: new Date() })
            .where(eq(jobOutbox.id, intent.id));
        } catch {
          await this.database.db
            .update(jobOutbox)
            .set({
              status: "pending",
              lockedAt: null,
              lastErrorCode: "QUEUE_UNAVAILABLE",
              updatedAt: new Date(),
            })
            .where(eq(jobOutbox.id, intent.id));
        }
      }
    } catch {
      this.logger.failure(
        { queue: this.config.queueName, outcome: "error", reason: "dispatch" },
        "Auth email dispatch failed",
      );
    }
  }

  private async markFailed(id: string, errorCode: string): Promise<void> {
    await this.database.db
      .update(jobOutbox)
      .set({ status: "failed", lastErrorCode: errorCode, updatedAt: new Date() })
      .where(eq(jobOutbox.id, id));
  }
}
