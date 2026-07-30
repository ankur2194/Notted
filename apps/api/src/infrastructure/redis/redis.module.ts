import { Module } from "@nestjs/common";
import Redis from "ioredis";

import { REDIS_CONFIG, type RedisConfig } from "../../config/redis.config";

import { RedisService } from "./redis.service";
import { REDIS_CLIENT } from "./redis.tokens";

@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [REDIS_CONFIG],
      useFactory: (config: RedisConfig): Redis | null =>
        config.enabled
          ? new Redis(config.url, {
              lazyConnect: true,
              connectTimeout: config.connectTimeoutMs,
              commandTimeout: config.commandTimeoutMs,
              maxRetriesPerRequest: config.maxRetriesPerRequest,
              enableOfflineQueue: false,
              enableReadyCheck: true,
              retryStrategy: (attempt: number): number => {
                const bounded = Math.min(config.retryDelayMs * attempt, config.retryMaxDelayMs);
                return Math.min(
                  bounded + Math.floor(Math.random() * Math.max(1, bounded * 0.2)),
                  config.retryMaxDelayMs,
                );
              },
            })
          : null,
    },
    RedisService,
  ],
  exports: [REDIS_CLIENT, RedisService],
})
export class RedisModule {}
