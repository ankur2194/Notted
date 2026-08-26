import { Module } from "@nestjs/common";

import { RedisModule } from "../infrastructure/redis/redis.module";

import { AiProviderRateLimiterService } from "./ai-provider-rate-limiter.service";
import { BullBoardService } from "./bull-board.service";
import { OutboxDispatcherService } from "./outbox-dispatcher.service";
import { QueueAdminRemediationService } from "./queue-admin-remediation.service";
import { QueueHandlerRegistry } from "./queue-handler-registry.service";
import { QueueInfrastructureService } from "./queue-infrastructure.service";
import { QueueLifecycleService } from "./queue-lifecycle.service";
import { QUEUE_METRICS_SOURCE, type QueueMetricsSource } from "./queue-metrics.source";
import { QueueOutboxRepository } from "./queue-outbox.repository";
import { QUEUE_READINESS_INDICATOR, QueueReadinessIndicator } from "./queue-readiness.indicator";
import { QueueWorkerProcessorService } from "./queue-worker-processor.service";

@Module({
  imports: [RedisModule],
  providers: [
    QueueHandlerRegistry,
    QueueOutboxRepository,
    QueueInfrastructureService,
    OutboxDispatcherService,
    QueueWorkerProcessorService,
    QueueLifecycleService,
    QueueReadinessIndicator,
    AiProviderRateLimiterService,
    BullBoardService,
    QueueAdminRemediationService,
    { provide: QUEUE_READINESS_INDICATOR, useExisting: QueueReadinessIndicator },
    // Part 78. A count-only view stitched from two module-private owners, for
    // the same reason the readiness indicator above exists: the runtime itself
    // stays private. A factory rather than `useExisting` because the two
    // numbers come from different places — BullMQ depth from the
    // infrastructure service, the consumer set from the handler registry — and
    // neither owner should learn about metrics to satisfy the other.
    {
      provide: QUEUE_METRICS_SOURCE,
      useFactory: (
        infrastructure: QueueInfrastructureService,
        handlers: QueueHandlerRegistry,
      ): QueueMetricsSource => ({
        jobCounts: () => infrastructure.jobCounts(),
        consumableJobTypes: () => handlers.registeredJobTypes(),
      }),
      inject: [QueueInfrastructureService, QueueHandlerRegistry],
    },
  ],
  // Later handler modules need only this explicit registration seam. Runtime,
  // repositories, queue clients, and dispatch controls stay module-private.
  exports: [
    QueueHandlerRegistry,
    AiProviderRateLimiterService,
    BullBoardService,
    QueueAdminRemediationService,
    QUEUE_READINESS_INDICATOR,
    QUEUE_METRICS_SOURCE,
  ],
})
export class QueueModule {}
