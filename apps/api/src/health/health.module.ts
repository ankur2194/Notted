import { Module } from "@nestjs/common";

import { AuthEmailQueueService } from "../auth/auth-email-queue.service";
import { AuthModule } from "../auth/auth.module";
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
import { InvitationEmailQueueService } from "../memberships/invitation-email-queue.service";
import { MembershipsModule } from "../memberships/memberships.module";

import { HealthController } from "./health.controller";
import { ProcessReadinessIndicator } from "./process-readiness.indicator";
import { READINESS_INDICATORS } from "./readiness-indicator";

@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    RedisModule,
    MinioModule,
    MeilisearchModule,
    SmtpModule,
    MembershipsModule,
  ],
  controllers: [HealthController],
  providers: [
    ProcessReadinessIndicator,
    {
      provide: READINESS_INDICATORS,
      inject: [
        ProcessReadinessIndicator,
        DatabaseReadinessIndicator,
        RedisService,
        MinioService,
        MeilisearchService,
        SmtpService,
        AuthEmailQueueService,
        InvitationEmailQueueService,
      ],
      useFactory: (
        processIndicator: ProcessReadinessIndicator,
        databaseIndicator: DatabaseReadinessIndicator,
        redisIndicator: RedisService,
        minioIndicator: MinioService,
        meilisearchIndicator: MeilisearchService,
        smtpIndicator: SmtpService,
        authEmailQueueIndicator: AuthEmailQueueService,
        invitationEmailQueueIndicator: InvitationEmailQueueService,
      ) => [
        processIndicator,
        databaseIndicator,
        redisIndicator,
        minioIndicator,
        meilisearchIndicator,
        smtpIndicator,
        authEmailQueueIndicator,
        invitationEmailQueueIndicator,
      ],
    },
  ],
  exports: [READINESS_INDICATORS],
})
export class HealthModule {}
