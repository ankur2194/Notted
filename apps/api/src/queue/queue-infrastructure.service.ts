import { Inject, Injectable } from "@nestjs/common";
import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { QUEUE_CONFIG, type QueueConfig } from "../config/queue.config";
import { REDIS_CLIENT } from "../infrastructure/redis/redis.tokens";

import {
  DEAD_LETTER_QUEUE_NAME,
  PHYSICAL_QUEUE_NAMES,
  type PhysicalQueueName,
} from "./queue-names";

import type { BullJobEnvelope } from "./job-contracts";
import type { RegisteredQueueHandler } from "./queue-handler-registry.service";
import type { DeadLetterRecord } from "./queue-runtime.types";
import type Redis from "ioredis";

const REQUIRED_EXPORT_CONCURRENCY = 2;
const QUEUE_READINESS_TIMEOUT_MS = 5_000;

export type QueueOperationalStatus = "disabled" | "down" | "ready" | "starting" | "stopping";

export interface QueueWorkerInvocation {
  readonly sourceQueue: PhysicalQueueName;
  readonly envelope: unknown;
  readonly bullJobId?: string;
  readonly attempt: number;
  readonly maximumAttempts: number;
}

type WorkerProcessor = (invocation: QueueWorkerInvocation) => Promise<void>;

@Injectable()
export class QueueInfrastructureService {
  private readonly queues = new Map<string, Queue<unknown>>();
  private readonly workers: Worker<unknown>[] = [];
  private readonly connections: Redis[] = [];
  private stopping = false;
  private status: QueueOperationalStatus;
  private expectedWorkerCount = 0;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    @Inject(QUEUE_CONFIG) private readonly config: QueueConfig,
    private readonly logger: StructuredLogger,
  ) {
    this.status = redis === null ? "disabled" : "starting";
  }

  async start(
    processor: WorkerProcessor,
    activeWorkerQueues: readonly PhysicalQueueName[],
  ): Promise<boolean> {
    if (this.redis === null || this.stopping) return false;

    // Parsing enforces this for environment configuration. This runtime guard is
    // deliberately separate so malformed test/override DI cannot create more
    // than the two export workers allowed by Part 50.
    if (
      this.config.workers[PHYSICAL_QUEUE_NAMES.export].concurrency !== REQUIRED_EXPORT_CONCURRENCY
    ) {
      this.status = "down";
      throw new Error("Queue export concurrency invariant violated");
    }

    this.status = "starting";
    this.expectedWorkerCount = activeWorkerQueues.length;

    const queueConnection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.connections.push(queueConnection);
    const defaultJobOptions = {
      attempts: this.config.attempts,
      backoff: { type: "notted-bounded-exponential", delay: this.config.backoff.baseMs },
      removeOnComplete: {
        age: this.config.retention.completedAgeSeconds,
        count: this.config.retention.completedCount,
      },
      removeOnFail: {
        age: this.config.retention.failedAgeSeconds,
        count: this.config.retention.failedCount,
      },
    } as const;

    for (const queueName of Object.values(PHYSICAL_QUEUE_NAMES)) {
      const queue = new Queue<unknown>(queueName, {
        connection: queueConnection,
        defaultJobOptions,
      });
      this.observeQueue(queueName, queue);
      this.queues.set(queueName, queue);
    }
    const deadLetterQueue = new Queue<unknown>(DEAD_LETTER_QUEUE_NAME, {
      connection: queueConnection,
      defaultJobOptions: {
        removeOnComplete: false,
        removeOnFail: {
          age: this.config.retention.failedAgeSeconds,
          count: this.config.retention.failedCount,
        },
      },
    });
    this.observeQueue(DEAD_LETTER_QUEUE_NAME, deadLetterQueue);
    this.queues.set(DEAD_LETTER_QUEUE_NAME, deadLetterQueue);

    for (const sourceQueue of activeWorkerQueues) {
      const workerConnection = this.redis.duplicate({
        commandTimeout: undefined,
        maxRetriesPerRequest: null,
      });
      this.connections.push(workerConnection);
      const worker = new Worker<unknown>(
        sourceQueue,
        async (job: Job<unknown>) => {
          if (this.stopping) throw new UnrecoverableError("queue_shutting_down");
          await processor({
            sourceQueue,
            envelope: job.data,
            bullJobId: job.id,
            attempt: job.attemptsMade + 1,
            maximumAttempts: job.opts.attempts ?? this.config.attempts,
          });
        },
        {
          connection: workerConnection,
          concurrency: this.config.workers[sourceQueue].concurrency,
          settings: {
            backoffStrategy: (attemptsMade: number, type?: string): number => {
              if (type !== "notted-bounded-exponential") return -1;
              const exponential = Math.min(
                this.config.backoff.baseMs * 2 ** Math.max(0, attemptsMade - 1),
                this.config.backoff.maximumMs,
              );
              const jitter = exponential * this.config.backoff.jitter * (Math.random() * 2 - 1);
              return Math.max(
                0,
                Math.min(this.config.backoff.maximumMs, Math.round(exponential + jitter)),
              );
            },
          },
        },
      );
      worker.on("error", () => {
        this.status = "down";
        this.logger.failure({ queue: sourceQueue, reason: "worker" }, "Queue worker error");
      });
      this.workers.push(worker);
    }

    try {
      await this.waitForRequiredInfrastructure();
      this.status = "ready";
      this.logger.info({ outcome: "ready" }, "Queue runtime started");
      return true;
    } catch {
      this.status = "down";
      this.logger.failure({ outcome: "error", reason: "startup" }, "Queue runtime startup failed");
      await this.close();
      return false;
    }
  }

  operationalStatus(): QueueOperationalStatus {
    return this.status;
  }

  async probe(): Promise<boolean> {
    if (this.redis === null || this.stopping || this.status === "disabled") return false;
    try {
      await this.waitForRequiredInfrastructure();
      this.status = "ready";
      return true;
    } catch {
      this.status = "down";
      return false;
    }
  }

  async publish(rowId: string, binding: RegisteredQueueHandler): Promise<void> {
    if (this.stopping) throw new Error("Queue runtime is shutting down");
    const queue = this.queues.get(binding.definition.route.physicalQueueName);
    if (queue === undefined) throw new Error("Queue runtime is unavailable");
    const envelope: BullJobEnvelope = { outboxIntentId: rowId };
    await queue.add(binding.definition.jobType, envelope, {
      jobId: rowId,
      priority: binding.definition.route.priority === "high" ? 1 : undefined,
      // Stamped per job, overriding the queue's `defaultJobOptions.attempts`.
      // Several job types share one physical lane, so the budget cannot live on
      // the queue: raising it there would hand every neighbour the same
      // allowance. The worker already reads `job.opts.attempts` back, so the
      // value stamped here is the one the retry loop and the final-attempt
      // check both use.
      attempts: binding.definition.maximumAttempts ?? this.config.attempts,
    });
  }

  async publishDeadLetter(record: DeadLetterRecord): Promise<void> {
    const queue = this.queues.get(DEAD_LETTER_QUEUE_NAME);
    if (queue === undefined) return;
    await queue.add("terminal-failure", record, {
      jobId: `dlq-${record.outboxIntentId}`,
      attempts: 1,
      removeOnComplete: false,
    });
  }

  /** QueueModule-internal seam; QueueModule never exports this owner or clients. */
  internalBullBoardQueues(): readonly Queue<unknown>[] {
    const names = [...Object.values(PHYSICAL_QUEUE_NAMES), DEAD_LETTER_QUEUE_NAME];
    const queues = names.map((name) => this.queues.get(name));
    return queues.every((queue): queue is Queue<unknown> => queue !== undefined) ? queues : [];
  }

  async administrativeJobState(
    queueName: PhysicalQueueName,
    jobId: string,
  ): Promise<string | null> {
    const queue = this.queues.get(queueName);
    if (queue === undefined) return null;
    const job = await queue.getJob(jobId);
    return job === undefined ? null : job.getState();
  }

  async administrativeRetry(queueName: PhysicalQueueName, jobId: string): Promise<void> {
    const queue = this.queues.get(queueName);
    if (queue === undefined) throw new Error("QUEUE_ADMIN_RETRY_UNAVAILABLE");
    const job = await queue.getJob(jobId);
    if (job === undefined || (await job.getState()) !== "failed") {
      throw new Error("QUEUE_ADMIN_RETRY_DENIED");
    }
    await job.retry("failed");
  }

  beginShutdown(): void {
    this.stopping = true;
    this.status = this.redis === null ? "disabled" : "stopping";
  }

  async pauseWorkers(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.pause(false)));
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.workers.map((worker) => worker.close(true)));
    await Promise.allSettled([...this.queues.values()].map((queue) => queue.close()));
    await Promise.allSettled(this.connections.map((connection) => connection.quit()));
    this.workers.length = 0;
    this.queues.clear();
    this.connections.length = 0;
  }

  private async waitForRequiredInfrastructure(): Promise<void> {
    const requiredQueueCount = Object.values(PHYSICAL_QUEUE_NAMES).length + 1;
    if (
      this.queues.size !== requiredQueueCount ||
      this.workers.length !== this.expectedWorkerCount
    ) {
      throw new Error("Queue runtime is incomplete");
    }
    const readiness = Promise.all([
      ...[...this.queues.values()].map((queue) => queue.waitUntilReady()),
      ...this.workers.map((worker) => worker.waitUntilReady()),
    ]).then(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Queue readiness timeout")),
        QUEUE_READINESS_TIMEOUT_MS,
      );
      timer.unref();
    });
    try {
      await Promise.race([readiness, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private observeQueue(queueName: string, queue: Queue<unknown>): void {
    queue.on("error", () => {
      this.status = "down";
      this.logger.failure({ queue: queueName, reason: "queue" }, "Queue client error");
    });
  }
}
