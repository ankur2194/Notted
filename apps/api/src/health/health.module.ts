import { Module } from "@nestjs/common";

import { HealthController } from "./health.controller";
import { ProcessReadinessIndicator } from "./process-readiness.indicator";
import { READINESS_INDICATORS } from "./readiness-indicator";

@Module({
  controllers: [HealthController],
  providers: [
    ProcessReadinessIndicator,
    {
      provide: READINESS_INDICATORS,
      inject: [ProcessReadinessIndicator],
      useFactory: (processIndicator: ProcessReadinessIndicator) => [processIndicator],
    },
  ],
  exports: [READINESS_INDICATORS],
})
export class HealthModule {}
