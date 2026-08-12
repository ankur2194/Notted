import { Module } from "@nestjs/common";

import { DatabaseReadinessIndicator } from "../database/database-readiness.indicator";
import { DatabaseModule } from "../database/database.module";
import { MeilisearchModule } from "../infrastructure/meilisearch/meilisearch.module";
import { MeilisearchService } from "../infrastructure/meilisearch/meilisearch.service";
import { MinioModule } from "../infrastructure/minio/minio.module";
import { MinioService } from "../infrastructure/minio/minio.service";
import { RedisModule } from "../infrastructure/redis/redis.module";
import { RedisService } from "../infrastructure/redis/redis.service";
import { SmtpModule } from "../infrastructure/smtp/smtp.module";
import { SmtpService } from "../infrastructure/smtp/smtp.service";
import { QUEUE_READINESS_INDICATOR, type QueueReadiness } from "../queue/queue-readiness.indicator";
import { QueueModule } from "../queue/queue.module";

import { HealthController } from "./health.controller";
import { ProcessReadinessIndicator } from "./process-readiness.indicator";
import { READINESS_INDICATORS } from "./readiness-indicator";

@Module({
  imports: [DatabaseModule, RedisModule, MinioModule, MeilisearchModule, SmtpModule, QueueModule],
  controllers: [HealthController],
  providers: [
    ProcessReadinessIndicator,
    {
      provide: READINESS_INDICATORS,
      inject: [
        ProcessReadinessIndicator,
        DatabaseReadinessIndicator,
        RedisService,
        QUEUE_READINESS_INDICATOR,
        MinioService,
        MeilisearchService,
        SmtpService,
      ],
      useFactory: (
        processIndicator: ProcessReadinessIndicator,
        databaseIndicator: DatabaseReadinessIndicator,
        redisIndicator: RedisService,
        queueIndicator: QueueReadiness,
        minioIndicator: MinioService,
        meilisearchIndicator: MeilisearchService,
        smtpIndicator: SmtpService,
      ) => [
        processIndicator,
        databaseIndicator,
        redisIndicator,
        queueIndicator,
        minioIndicator,
        meilisearchIndicator,
        smtpIndicator,
      ],
    },
  ],
  exports: [READINESS_INDICATORS],
})
export class HealthModule {}
