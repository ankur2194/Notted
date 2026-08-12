import { Module } from "@nestjs/common";

import { RedisModule } from "../infrastructure/redis/redis.module";

import { AiProviderRateLimiterService } from "./ai-provider-rate-limiter.service";
import { BullBoardService } from "./bull-board.service";
import { OutboxDispatcherService } from "./outbox-dispatcher.service";
import { QueueAdminRemediationService } from "./queue-admin-remediation.service";
import { QueueHandlerRegistry } from "./queue-handler-registry.service";
import { QueueInfrastructureService } from "./queue-infrastructure.service";
import { QueueLifecycleService } from "./queue-lifecycle.service";
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
  ],
  // Later handler modules need only this explicit registration seam. Runtime,
  // repositories, queue clients, and dispatch controls stay module-private.
  exports: [
    QueueHandlerRegistry,
    AiProviderRateLimiterService,
    BullBoardService,
    QueueAdminRemediationService,
    QUEUE_READINESS_INDICATOR,
  ],
})
export class QueueModule {}
