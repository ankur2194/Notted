import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { QUEUE_CONFIG, type QueueConfig } from "../config/queue.config";

import { OutboxDispatcherService } from "./outbox-dispatcher.service";
import { QueueHandlerRegistry } from "./queue-handler-registry.service";
import { QueueInfrastructureService } from "./queue-infrastructure.service";
import { PHYSICAL_QUEUE_NAMES } from "./queue-names";
import { QueueWorkerProcessorService } from "./queue-worker-processor.service";

@Injectable()
export class QueueLifecycleService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private dispatchRunning = false;
  private stopping = false;

  constructor(
    @Inject(QUEUE_CONFIG) private readonly config: QueueConfig,
    private readonly infrastructure: QueueInfrastructureService,
    private readonly handlers: QueueHandlerRegistry,
    private readonly dispatcher: OutboxDispatcherService,
    private readonly processor: QueueWorkerProcessorService,
    private readonly logger: StructuredLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.workers[PHYSICAL_QUEUE_NAMES.export].concurrency !== 2) {
      throw new Error("Queue export concurrency invariant violated");
    }
    const started = await this.infrastructure.start(
      (invocation) => this.processor.process(invocation),
      this.handlers.activePhysicalQueues(),
    );
    if (!started || this.stopping) return;
    this.timer = setInterval(() => void this.runDispatch(), this.config.dispatcher.intervalMs);
    this.timer.unref();
    await this.runDispatch();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.dispatcher.stopClaiming();
    this.infrastructure.beginShutdown();
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    let graceTimer: NodeJS.Timeout | undefined;
    const grace = new Promise<"timeout">((resolve) => {
      graceTimer = setTimeout(() => resolve("timeout"), this.config.shutdownGraceMs);
      graceTimer.unref();
    });
    try {
      const settled = Promise.allSettled([
        this.infrastructure.pauseWorkers(),
        this.waitForDispatcher(),
      ]).then(() => "settled" as const);
      if ((await Promise.race([settled, grace])) === "timeout") {
        this.logger.failure({ reason: "grace_timeout" }, "Queue shutdown grace elapsed");
      }
    } finally {
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      await this.infrastructure.close();
    }
  }

  private async runDispatch(): Promise<void> {
    if (this.stopping || this.dispatchRunning) return;
    this.dispatchRunning = true;
    try {
      await this.dispatcher.dispatchOnce(
        this.config.dispatcher.batchSize,
        this.config.dispatcher.staleClaimMs,
      );
    } catch {
      this.logger.failure({ reason: "dispatcher" }, "Outbox dispatch cycle failed");
    } finally {
      this.dispatchRunning = false;
    }
  }

  private async waitForDispatcher(): Promise<void> {
    while (this.dispatchRunning) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10);
        timer.unref();
      });
    }
  }
}
