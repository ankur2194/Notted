import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module";
import { HealthModule } from "../health/health.module";
import { QueueModule } from "../queue/queue.module";

import { MetricsCollectorsService } from "./metrics-collectors.service";
import { MetricsController } from "./metrics.controller";

/**
 * Part 78. Imports the three modules whose EXPORTED seams the scrape-time
 * collectors need — `ReadinessService`, `QUEUE_METRICS_SOURCE` and the database
 * handle — and nothing else. Every other metric in the process is written at
 * its own call site through a module-scope const in `metrics.registry.ts`, so
 * no feature module has to import this one.
 */
@Module({
  imports: [DatabaseModule, HealthModule, QueueModule],
  controllers: [MetricsController],
  providers: [MetricsCollectorsService],
})
export class MetricsModule {}
