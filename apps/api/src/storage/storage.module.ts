// Part 45: workspace storage quota + maintenance transport module.
//
// `StorageQuotaService` is exported because `AttachmentsModule` needs it on the
// upload write path. Keeping it here rather than in `attachments/` is what
// avoids `WorkspacesModule`-adjacent code importing the whole attachment upload
// stack just to read a number (see the service's module comment).

import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { MaintenanceModule } from "../maintenance/maintenance.module";

import { StorageQuotaService } from "./storage-quota.service";
import { StorageController } from "./storage.controller";

@Module({
  imports: [AuthModule, AuthorizationModule, MaintenanceModule],
  controllers: [StorageController],
  providers: [StorageQuotaService],
  exports: [StorageQuotaService],
})
export class StorageModule {}
