import { Module } from "@nestjs/common";

import { AttachmentsModule } from "../attachments/attachments.module";
import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { MinioModule } from "../infrastructure/minio/minio.module";
import { StorageModule } from "../storage/storage.module";

import { WorkspaceLogoController } from "./workspace-logo.controller";
import { WorkspaceLogoService } from "./workspace-logo.service";
import { WorkspacesController } from "./workspaces.controller";
import { WorkspacesService } from "./workspaces.service";
import { WorkspacesTrpcRouter } from "./workspaces.trpc";

/**
 * Workspace lifecycle module. `DatabaseModule` and `TenantContextModule` are
 * `@Global()` so they are available without an explicit import (mirrors the
 * notification/shell modules). `AuthModule` provides `AuthService` (trusted
 * origin checks + `AuthGuard`) and `AuthorizationModule` provides the
 * `@RequireAuthorization` guard/interceptors and `AuthorizationEntryService`.
 *
 * `StorageModule` (Part 45) supplies `StorageQuotaService` to
 * `WorkspacesTrpcRouter` so the `workspace.storageUsage` procedure calls the
 * same service and policy the REST route does. The arrow points one way only:
 * `StorageModule` imports `AuthModule`, `AuthorizationModule`, and
 * `MaintenanceModule`, none of which import this module, so no cycle is created
 * and no `forwardRef` is needed.
 *
 * Part 72 adds `AttachmentsModule` (for `ImageProcessingService`) and
 * `MinioModule` (for `ObjectStorageService`) for the branding logo. The arrow
 * still points one way: neither imports this module, and only `TrpcModule` and
 * `AppModule` import it.
 */
@Module({
  imports: [AttachmentsModule, AuthModule, AuthorizationModule, MinioModule, StorageModule],
  controllers: [WorkspacesController, WorkspaceLogoController],
  providers: [WorkspacesService, WorkspaceLogoService, WorkspacesTrpcRouter],
  exports: [WorkspacesService, WorkspaceLogoService, WorkspacesTrpcRouter],
})
export class WorkspacesModule {}
