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

import { InvitationEmailQueueService } from "./invitation-email-queue.service";
import { invitationEmailJobPayloadSchema } from "./invitation-email.types";
import { INVITATION_EMAIL_JOB_TYPE, INVITATION_EMAIL_QUEUE_NAME } from "./memberships.constants";

@Injectable()
export class InvitationEmailDispatcherService implements OnModuleInit, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly queue: InvitationEmailQueueService,
    private readonly logger: StructuredLogger,
    @Inject(AUTH_EMAIL_QUEUE_CONFIG) private readonly config: AuthEmailQueueConfig,
    @Inject(FEATURES_CONFIG) private readonly features: FeaturesConfig,
  ) {}

  onModuleInit(): void {
    if (!this.features.emailEnabled) return;
    this.timer = setInterval(() => this.kick(), this.config.dispatcherIntervalMs);
    this.timer.unref();
    this.kick();
  }

  kick(): void {
    if (this.running || !this.features.emailEnabled) return;
    this.running = true;
    void this.dispatchPending().finally(() => {
      this.running = false;
    });
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
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
            eq(jobOutbox.queueName, INVITATION_EMAIL_QUEUE_NAME),
            eq(jobOutbox.status, "dispatching"),
            lte(jobOutbox.lockedAt, staleBefore),
          ),
        );
      const pending = await this.database.db
        .select({ id: jobOutbox.id, payload: jobOutbox.payload })
        .from(jobOutbox)
        .where(
          and(
            eq(jobOutbox.queueName, INVITATION_EMAIL_QUEUE_NAME),
            eq(jobOutbox.jobType, INVITATION_EMAIL_JOB_TYPE),
            eq(jobOutbox.status, "pending"),
            lte(jobOutbox.availableAt, new Date()),
          ),
        )
        .orderBy(asc(jobOutbox.availableAt))
        .limit(25);

      for (const intent of pending) {
        const parsed = invitationEmailJobPayloadSchema.safeParse({
          invitationId: intent.payload.resourceIds?.[0],
          deliveryId: intent.payload.resourceIds?.[1],
        });
        if (!parsed.success) {
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
        if (claimed.length === 0) continue;
        try {
          await this.queue.enqueue(intent.id, parsed.data);
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
        { queue: INVITATION_EMAIL_QUEUE_NAME, outcome: "error", reason: "dispatch" },
        "Invitation email dispatch failed",
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
