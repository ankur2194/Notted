import { Module } from "@nestjs/common";

import { ApiController } from "./api.controller";
import { CommonModule } from "./common/common.module";
import { ConfigModule } from "./config/config.module";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./health/health.module";
import { TenantContextModule } from "./tenant/tenant-context.module";

@Module({
  imports: [ConfigModule, CommonModule, DatabaseModule, HealthModule, TenantContextModule],
  controllers: [ApiController],
})
export class AppModule {}
