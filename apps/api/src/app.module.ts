import { Module } from "@nestjs/common";

import { ApiController } from "./api.controller";
import { CommonModule } from "./common/common.module";
import { ConfigModule } from "./config/config.module";
import { HealthModule } from "./health/health.module";

@Module({
  imports: [ConfigModule, CommonModule, HealthModule],
  controllers: [ApiController],
})
export class AppModule {}
