import { Module } from "@nestjs/common";

import { ApiController } from "./api.controller";
import { CommonModule } from "./common/common.module";
import { ConfigModule } from "./config/config.module";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./health/health.module";

@Module({
  imports: [ConfigModule, CommonModule, DatabaseModule, HealthModule],
  controllers: [ApiController],
})
export class AppModule {}
