// Part 45: storage-maintenance module.
//
// No controllers. The only HTTP surface for maintenance is
// `storage/storage.controller.ts`, which keeps the whole
// `/api/v1/workspaces/:workspaceId/storage` path family in one transport file
// instead of splitting a route prefix across two modules.
//
// `DatabaseModule` and `TenantContextModule` are `@Global()`, so only the
// authorization policy layer and the object-storage data plane need importing.

import { Module } from "@nestjs/common";

import { AuthorizationModule } from "../authorization/authorization.module";
import { MinioModule } from "../infrastructure/minio/minio.module";
import { QueueModule } from "../queue/queue.module";

import { AuditLogRetentionQueueService } from "./audit-log-retention-queue.service";
import { AuditLogRetentionService } from "./audit-log-retention.service";
import { JobIdempotencyCleanupQueueService } from "./job-idempotency-cleanup-queue.service";
import {
  JobIdempotencyCleanupRepository,
  JobIdempotencyCleanupService,
} from "./job-idempotency-cleanup.service";
import { NoteVersionRetentionQueueService } from "./note-version-retention-queue.service";
import { NoteVersionRetentionService } from "./note-version-retention.service";
import { StorageMaintenanceQueueHandler } from "./storage-maintenance-queue-handler.service";
import { StorageMaintenanceScheduler } from "./storage-maintenance.scheduler";
import { StorageMaintenanceService } from "./storage-maintenance.service";

@Module({
  imports: [AuthorizationModule, MinioModule, QueueModule],
  providers: [
    StorageMaintenanceService,
    StorageMaintenanceScheduler,
    StorageMaintenanceQueueHandler,
    JobIdempotencyCleanupRepository,
    JobIdempotencyCleanupService,
    JobIdempotencyCleanupQueueService,
    NoteVersionRetentionService,
    NoteVersionRetentionQueueService,
    AuditLogRetentionService,
    AuditLogRetentionQueueService,
  ],
  exports: [StorageMaintenanceService],
})
export class MaintenanceModule {}
