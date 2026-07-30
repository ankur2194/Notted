import { Module } from "@nestjs/common";

import { ApiController } from "./api.controller";
import { AuthModule } from "./auth/auth.module";
import { AuthorizationModule } from "./authorization/authorization.module";
import { CommonModule } from "./common/common.module";
import { ConfigModule } from "./config/config.module";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./health/health.module";
import { NotificationModule } from "./notifications/notification.module";
import { ShellModule } from "./shell/shell.module";
import { TenantContextModule } from "./tenant/tenant-context.module";

@Module({
  imports: [
    ConfigModule,
    CommonModule,
    DatabaseModule,
    AuthModule,
    AuthorizationModule,
    HealthModule,
    ShellModule,
    NotificationModule,
    TenantContextModule,
  ],
  controllers: [ApiController],
})
export class AppModule {}
