import { Module } from "@nestjs/common";

import { DatabaseReadinessIndicator } from "../database/database-readiness.indicator";
import { DatabaseModule } from "../database/database.module";

import { HealthController } from "./health.controller";
import { ProcessReadinessIndicator } from "./process-readiness.indicator";
import { READINESS_INDICATORS } from "./readiness-indicator";

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController],
  providers: [
    ProcessReadinessIndicator,
    {
      provide: READINESS_INDICATORS,
      inject: [ProcessReadinessIndicator, DatabaseReadinessIndicator],
      useFactory: (
        processIndicator: ProcessReadinessIndicator,
        databaseIndicator: DatabaseReadinessIndicator,
      ) => [processIndicator, databaseIndicator],
    },
  ],
  exports: [READINESS_INDICATORS],
})
export class HealthModule {}
