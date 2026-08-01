import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";

import { WorkspacesController } from "./workspaces.controller";
import { WorkspacesService } from "./workspaces.service";
import { WorkspacesTrpcRouter } from "./workspaces.trpc";

/**
 * Workspace lifecycle module. `DatabaseModule` and `TenantContextModule` are
 * `@Global()` so they are available without an explicit import (mirrors the
 * notification/shell modules). `AuthModule` provides `AuthService` (trusted
 * origin checks + `AuthGuard`) and `AuthorizationModule` provides the
 * `@RequireAuthorization` guard/interceptors and `AuthorizationEntryService`.
 */
@Module({
  imports: [AuthModule, AuthorizationModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, WorkspacesTrpcRouter],
  exports: [WorkspacesService, WorkspacesTrpcRouter],
})
export class WorkspacesModule {}
