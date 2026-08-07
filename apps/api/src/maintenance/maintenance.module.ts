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

import { StorageMaintenanceScheduler } from "./storage-maintenance.scheduler";
import { StorageMaintenanceService } from "./storage-maintenance.service";

@Module({
  imports: [AuthorizationModule, MinioModule],
  providers: [StorageMaintenanceService, StorageMaintenanceScheduler],
  exports: [StorageMaintenanceService],
})
export class MaintenanceModule {}
