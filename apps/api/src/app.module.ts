import { Module } from "@nestjs/common";

import { ApiController } from "./api.controller";
import { AttachmentsModule } from "./attachments/attachments.module";
import { AuthModule } from "./auth/auth.module";
import { AuthorizationModule } from "./authorization/authorization.module";
import { CommonModule } from "./common/common.module";
import { ConfigModule } from "./config/config.module";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./health/health.module";
import { MaintenanceModule } from "./maintenance/maintenance.module";
import { MembershipsModule } from "./memberships/memberships.module";
import { NotesModule } from "./notes/notes.module";
import { NotificationModule } from "./notifications/notification.module";
import { ProjectsModule } from "./projects/projects.module";
import { ShellModule } from "./shell/shell.module";
import { StorageModule } from "./storage/storage.module";
import { TagsModule } from "./tags/tags.module";
import { TasksModule } from "./tasks/tasks.module";
import { TenantContextModule } from "./tenant/tenant-context.module";
import { TrpcModule } from "./trpc/trpc.module";
import { WorkspacesModule } from "./workspaces/workspaces.module";

@Module({
  imports: [
    ConfigModule,
    CommonModule,
    DatabaseModule,
    AuthModule,
    AuthorizationModule,
    AttachmentsModule,
    HealthModule,
    // Part 45. `StorageModule` already imports `MaintenanceModule`; both are
    // listed so the scheduler is instantiated even if the storage transport is
    // ever removed from the graph.
    MaintenanceModule,
    StorageModule,
    MembershipsModule,
    ShellModule,
    NotificationModule,
    NotesModule,
    ProjectsModule,
    TagsModule,
    TasksModule,
    TenantContextModule,
    TrpcModule,
    WorkspacesModule,
  ],
  controllers: [ApiController],
})
export class AppModule {}
