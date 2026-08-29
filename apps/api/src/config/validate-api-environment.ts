import { parseAiConfig } from "./ai.config";
import { parseAppConfig } from "./app.config";
import { parseAuthConfig } from "./auth.config";
import { parseDatabaseConfig } from "./database.config";
import { parseExportConfig } from "./export.config";
import { parseFeaturesConfig } from "./features.config";
import { parseImageProcessingConfig } from "./image-processing.config";
import { parseMeilisearchConfig } from "./meilisearch.config";
import { parseMinioConfig } from "./minio.config";
import { parseQueueConfig } from "./queue.config";
import { parseRealtimeConfig } from "./realtime.config";
import { parseRedisConfig } from "./redis.config";
import { parseSecurityConfig } from "./security.config";
import { parseSmtpConfig } from "./smtp.config";
import { parseStorageConfig } from "./storage.config";

import type { Environment } from "./environment-readers";

export function environmentForValidation(
  environment: Environment,
  production: boolean,
): Environment {
  return Object.freeze({
    ...environment,
    ...(production ? { NODE_ENV: "production" } : {}),
  });
}

export function validateApiEnvironment(environment: Environment): void {
  parseAppConfig(environment);
  parseDatabaseConfig(environment);
  parseFeaturesConfig(environment);
  parseRedisConfig(environment);
  parseQueueConfig(environment);
  parseMinioConfig(environment);
  parseMeilisearchConfig(environment);
  parseSmtpConfig(environment);
  parseAuthConfig(environment);
  parseSecurityConfig(environment);
  parseImageProcessingConfig(environment);
  parseAiConfig(environment);
  // Part 45. `parseRetentionConfig` is still deliberately absent (Part 19 owns
  // that omission); the storage quota/maintenance budget is included because it
  // is new surface whose defaults decide whether a destructive sweep runs.
  parseStorageConfig(environment);
  // Both were validated at DI time only, so the release gate reported "config is
  // valid" for a config that cannot boot: `realtime.config.ts` throws when
  // REALTIME_PING_TIMEOUT_MS <= REALTIME_PING_INTERVAL_MS, and the container
  // then dies on startup after the gate has already passed. A validator that
  // misses a cross-field rule is worse than no validator, because it is
  // believed.
  parseRealtimeConfig(environment);
  parseExportConfig(environment);
}
