import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import {
  AUTH_EMAIL_QUEUE_CONFIG,
  type AuthEmailQueueConfig,
} from "../config/auth-email-queue.config";
import { FEATURES_CONFIG, type FeaturesConfig } from "../config/features.config";
import { REDIS_CLIENT } from "../infrastructure/redis/redis.tokens";

import { InvitationEmailWorkerService } from "./invitation-email-worker.service";
import {
  invitationEmailJobPayloadSchema,
  type InvitationEmailJobPayload,
} from "./invitation-email.types";
import { INVITATION_EMAIL_QUEUE_NAME } from "./memberships.constants";

import type { ReadinessCheckResult, ReadinessIndicator } from "../health/readiness-indicator";
import type Redis from "ioredis";

@Injectable()
export class InvitationEmailQueueService
  implements ReadinessIndicator, OnModuleInit, OnApplicationShutdown
{
  readonly name = "invitation-email-queue";
  private queue?: Queue<InvitationEmailJobPayload>;
  private worker?: Worker<InvitationEmailJobPayload>;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    @Inject(FEATURES_CONFIG) private readonly features: FeaturesConfig,
    @Inject(AUTH_EMAIL_QUEUE_CONFIG) private readonly config: AuthEmailQueueConfig,
    private readonly processor: InvitationEmailWorkerService,
    private readonly logger: StructuredLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.features.emailEnabled) return;
    if (this.redis === null) throw new Error("Invitation email queue requires Redis");

    const queueConnection = this.redis.duplicate({ maxRetriesPerRequest: null });
    const workerConnection = this.redis.duplicate({
      commandTimeout: undefined,
      maxRetriesPerRequest: null,
    });
    this.queue = new Queue<InvitationEmailJobPayload>(INVITATION_EMAIL_QUEUE_NAME, {
      connection: queueConnection,
      defaultJobOptions: {
        attempts: this.config.attempts,
        backoff: { type: "exponential", delay: this.config.retryBackoffMs },
        removeOnComplete: { age: 86_400, count: 1_000 },
        removeOnFail: { age: 604_800, count: 5_000 },
      },
    });
    this.worker = new Worker<InvitationEmailJobPayload>(
      INVITATION_EMAIL_QUEUE_NAME,
      async (job: Job<InvitationEmailJobPayload>) => {
        const payload = invitationEmailJobPayloadSchema.parse(job.data);
        const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? this.config.attempts);
        await this.processor.process(payload, finalAttempt);
      },
      { connection: workerConnection, concurrency: this.config.concurrency },
    );
    this.worker.on("error", () => {
      this.logger.failure(
        { queue: INVITATION_EMAIL_QUEUE_NAME, outcome: "error", reason: "worker" },
        "Invitation email worker error",
      );
    });
    await Promise.all([this.queue.waitUntilReady(), this.worker.waitUntilReady()]);
  }

  async enqueue(outboxId: string, payload: InvitationEmailJobPayload): Promise<void> {
    if (this.queue === undefined) throw new Error("Invitation email queue is disabled");
    await this.queue.add("deliver", payload, { jobId: outboxId });
  }

  async check(): Promise<ReadinessCheckResult> {
    if (!this.features.emailEnabled) return { name: this.name, status: "disabled" };
    if (this.queue === undefined || this.worker === undefined) {
      return { name: this.name, status: "down", message: "Invitation email queue is unavailable" };
    }
    try {
      await this.queue.getJobCounts("waiting", "active", "failed");
      return { name: this.name, status: "up" };
    } catch {
      return { name: this.name, status: "down", message: "Invitation email queue probe failed" };
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
