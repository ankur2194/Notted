import { Global, Module } from "@nestjs/common";

import { AI_CONFIG, AiConfigProvider, aiConfigProvider } from "./ai.config";
import { APP_CONFIG, AppConfigProvider, appConfigProvider } from "./app.config";
import {
  AUTH_EMAIL_QUEUE_CONFIG,
  AuthEmailQueueConfigProvider,
  authEmailQueueConfigProvider,
} from "./auth-email-queue.config";
import { AUTH_CONFIG, AuthConfigProvider, authConfigProvider } from "./auth.config";
import { DATABASE_CONFIG, DatabaseConfigProvider, databaseConfigProvider } from "./database.config";
import { FEATURES_CONFIG, FeaturesConfigProvider, featuresConfigProvider } from "./features.config";
import {
  IMAGE_PROCESSING_CONFIG,
  ImageProcessingConfigProvider,
  imageProcessingConfigProvider,
} from "./image-processing.config";
import {
  MEILISEARCH_CONFIG,
  MeilisearchConfigProvider,
  meilisearchConfigProvider,
} from "./meilisearch.config";
import { MINIO_CONFIG, MinioConfigProvider, minioConfigProvider } from "./minio.config";
import { REDIS_CONFIG, RedisConfigProvider, redisConfigProvider } from "./redis.config";
import {
  RETENTION_CONFIG,
  RetentionConfigProvider,
  retentionConfigProvider,
} from "./retention.config";
import { SECURITY_CONFIG, SecurityConfigProvider, securityConfigProvider } from "./security.config";
import { SMTP_CONFIG, SmtpConfigProvider, smtpConfigProvider } from "./smtp.config";

@Global()
@Module({
  providers: [
    AiConfigProvider,
    aiConfigProvider,
    AppConfigProvider,
    appConfigProvider,
    AuthConfigProvider,
    authConfigProvider,
    AuthEmailQueueConfigProvider,
    authEmailQueueConfigProvider,
    DatabaseConfigProvider,
    databaseConfigProvider,
    FeaturesConfigProvider,
    featuresConfigProvider,
    ImageProcessingConfigProvider,
    imageProcessingConfigProvider,
    MeilisearchConfigProvider,
    meilisearchConfigProvider,
    MinioConfigProvider,
    minioConfigProvider,
    RedisConfigProvider,
    redisConfigProvider,
    RetentionConfigProvider,
    retentionConfigProvider,
    SecurityConfigProvider,
    securityConfigProvider,
    SmtpConfigProvider,
    smtpConfigProvider,
  ],
  exports: [
    AI_CONFIG,
    APP_CONFIG,
    AUTH_CONFIG,
    AUTH_EMAIL_QUEUE_CONFIG,
    DATABASE_CONFIG,
    FEATURES_CONFIG,
    IMAGE_PROCESSING_CONFIG,
    MEILISEARCH_CONFIG,
    MINIO_CONFIG,
    REDIS_CONFIG,
    RETENTION_CONFIG,
    SECURITY_CONFIG,
    SMTP_CONFIG,
  ],
})
export class ConfigModule {}
