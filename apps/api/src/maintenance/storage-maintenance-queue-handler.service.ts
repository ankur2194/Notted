import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { STORAGE_CONFIG, type StorageConfig } from "../config/storage.config";
import { defineQueueJobRegistration, type QueueJobContext } from "../queue/job-contracts";
import { STORAGE_MAINTENANCE_JOB_DEFINITION } from "../queue/job-registry";
import { PermanentQueueJobError } from "../queue/queue-errors";
import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";

import { StorageMaintenanceService } from "./storage-maintenance.service";

import type { z } from "zod";

type StorageMaintenanceQueueContext = QueueJobContext<
  typeof STORAGE_MAINTENANCE_JOB_DEFINITION.jobType,
  z.output<typeof STORAGE_MAINTENANCE_JOB_DEFINITION.payloadSchema>
>;

/** Global system-authority consumer for identifier-only maintenance intents. */
@Injectable()
export class StorageMaintenanceQueueHandler implements OnModuleInit, OnModuleDestroy {
  readonly jobType = STORAGE_MAINTENANCE_JOB_DEFINITION.jobType;
  private unregister?: () => void;

  constructor(
    private readonly maintenance: StorageMaintenanceService,
    private readonly registry: QueueHandlerRegistry,
    @Inject(STORAGE_CONFIG) private readonly config: StorageConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.maintenanceEnabled) return;
    this.unregister = this.registry.register(
      defineQueueJobRegistration({ definition: STORAGE_MAINTENANCE_JOB_DEFINITION, handler: this }),
    );
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async handle(context: StorageMaintenanceQueueContext): Promise<void> {
    if (context.payload.intentId !== context.outboxIntentId) {
      throw new PermanentQueueJobError("payload_invalid");
    }
    // Dry-run authority comes only from server configuration, never payload.
    await this.maintenance.runSystemSweeps({ dryRun: this.config.maintenanceDryRun });
  }
}
