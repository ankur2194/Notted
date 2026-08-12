import { parseAiConfig } from "./ai.config";
import { parseAppConfig } from "./app.config";
import { parseAuthConfig } from "./auth.config";
import { parseDatabaseConfig } from "./database.config";
import { parseFeaturesConfig } from "./features.config";
import { parseImageProcessingConfig } from "./image-processing.config";
import { parseMeilisearchConfig } from "./meilisearch.config";
import { parseMinioConfig } from "./minio.config";
import { parseQueueConfig } from "./queue.config";
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
}
