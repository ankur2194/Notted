import { Module } from "@nestjs/common";

import { ApiController } from "./api.controller";
import { AuthModule } from "./auth/auth.module";
import { AuthorizationModule } from "./authorization/authorization.module";
import { CommonModule } from "./common/common.module";
import { ConfigModule } from "./config/config.module";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./health/health.module";
import { MembershipsModule } from "./memberships/memberships.module";
import { NotesModule } from "./notes/notes.module";
import { NotificationModule } from "./notifications/notification.module";
import { ProjectsModule } from "./projects/projects.module";
import { ShellModule } from "./shell/shell.module";
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
    HealthModule,
    MembershipsModule,
    ShellModule,
    NotificationModule,
    NotesModule,
    ProjectsModule,
    TenantContextModule,
    TrpcModule,
    WorkspacesModule,
  ],
  controllers: [ApiController],
})
export class AppModule {}
