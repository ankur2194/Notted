import { Module } from "@nestjs/common";

import { AuthorizationPolicyModule } from "../authorization/authorization-policy.module";
import { StructuredLogger } from "../common/logging/structured-logger.service";
import { APP_CONFIG, type AppConfig } from "../config/app.config";
import { AUTH_CONFIG, type AuthConfig } from "../config/auth.config";
import { FEATURES_CONFIG, type FeaturesConfig } from "../config/features.config";
import { RETENTION_CONFIG, type RetentionConfig } from "../config/retention.config";
import { DatabaseModule } from "../database/database.module";
import { DatabaseService } from "../database/database.service";
import { RedisModule } from "../infrastructure/redis/redis.module";
import { SmtpModule } from "../infrastructure/smtp/smtp.module";

import { AuthEmailDispatcherService } from "./auth-email-dispatcher.service";
import { AuthEmailEncryptionService } from "./auth-email-encryption.service";
import { AuthEmailProducerService } from "./auth-email-producer.service";
import { AuthEmailQueueService } from "./auth-email-queue.service";
import { AuthEmailWorkerService } from "./auth-email-worker.service";
import { AuthRateLimitMiddleware } from "./auth-rate-limit.middleware";
import { AuthSecurityService } from "./auth-security.service";
import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { AuthService } from "./auth.service";
import { BETTER_AUTH_INSTANCE, BETTER_AUTH_NODE_HANDLER } from "./auth.tokens";
import { BetterAuthRedisStorage } from "./better-auth-redis.storage";
import {
  createBetterAuthNodeHandler,
  setupBetterAuth,
  type BetterAuthInstance,
} from "./better-auth.setup";

@Module({
  imports: [AuthorizationPolicyModule, DatabaseModule, RedisModule, SmtpModule],
  controllers: [AuthController],
  providers: [
    BetterAuthRedisStorage,
    AuthEmailEncryptionService,
    AuthEmailWorkerService,
    AuthEmailQueueService,
    AuthEmailDispatcherService,
    AuthEmailProducerService,
    {
      provide: BETTER_AUTH_INSTANCE,
      inject: [
        DatabaseService,
        BetterAuthRedisStorage,
        AuthEmailProducerService,
        AUTH_CONFIG,
        APP_CONFIG,
        RETENTION_CONFIG,
        FEATURES_CONFIG,
        StructuredLogger,
      ],
      useFactory: async (
        database: DatabaseService,
        redisStorage: BetterAuthRedisStorage,
        emailProducer: AuthEmailProducerService,
        authConfig: AuthConfig,
        appConfig: AppConfig,
        retention: RetentionConfig,
        features: FeaturesConfig,
        logger: StructuredLogger,
      ): Promise<BetterAuthInstance | null> => {
        if (!features.redisEnabled) {
          // Auth requires Redis secondary storage for session acceleration.
          // When Redis is disabled (scaffold/test mode), return null so the
          // application bootstraps without auth functionality. All auth
          // consumers guard for null and fail closed at runtime.
          return null;
        }
        return setupBetterAuth({
          database,
          redisStorage,
          emailProducer,
          authConfig,
          appConfig,
          retention,
          features,
          logger,
        });
      },
    },
    {
      provide: BETTER_AUTH_NODE_HANDLER,
      inject: [BETTER_AUTH_INSTANCE],
      useFactory: async (
        auth: BetterAuthInstance | null,
      ): Promise<((request: never, response: never) => Promise<void>) | null> => {
        if (auth === null) return null;
        return createBetterAuthNodeHandler(auth);
      },
    },
    AuthService,
    AuthSecurityService,
    AuthGuard,
    AuthRateLimitMiddleware,
  ],
  exports: [
    BETTER_AUTH_INSTANCE,
    BETTER_AUTH_NODE_HANDLER,
    AuthEmailProducerService,
    AuthEmailQueueService,
    AuthGuard,
    AuthRateLimitMiddleware,
    AuthService,
  ],
})
export class AuthModule {}
