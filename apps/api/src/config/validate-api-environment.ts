import { parseAiConfig } from "./ai.config";
import { parseAppConfig } from "./app.config";
import { parseAuthEmailQueueConfig } from "./auth-email-queue.config";
import { parseAuthConfig } from "./auth.config";
import { parseDatabaseConfig } from "./database.config";
import { parseFeaturesConfig } from "./features.config";
import { parseMeilisearchConfig } from "./meilisearch.config";
import { parseMinioConfig } from "./minio.config";
import { parseRedisConfig } from "./redis.config";
import { parseSecurityConfig } from "./security.config";
import { parseSmtpConfig } from "./smtp.config";

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
  parseMinioConfig(environment);
  parseMeilisearchConfig(environment);
  parseSmtpConfig(environment);
  parseAuthConfig(environment);
  parseAuthEmailQueueConfig(environment);
  parseSecurityConfig(environment);
  parseAiConfig(environment);
}
