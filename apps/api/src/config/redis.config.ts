import { Injectable, type Provider } from "@nestjs/common";

import {
  type Environment,
  readBoolean,
  readInteger,
  readOptionalString,
  wrapConfigError,
} from "./environment-readers";

export const REDIS_CONFIG = Symbol("REDIS_CONFIG");

export interface RedisConfig {
  readonly enabled: boolean;
  readonly url: string;
  readonly connectTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly readinessTimeoutMs: number;
  readonly maxRetriesPerRequest: number;
  readonly retryDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly startupRetryAttempts: number;
}

function readRedisUrl(environment: Environment, enabled: boolean): string {
  const value = readOptionalString(environment, "REDIS_URL");
  if (value === undefined) {
    if (enabled && environment.NODE_ENV === "production") {
      throw new Error("REDIS_URL is required when Redis is enabled in production");
    }
    return "redis://127.0.0.1:6379";
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("REDIS_URL must be a valid absolute Redis URL");
  }
  if (!["redis:", "rediss:"].includes(parsed.protocol)) {
    throw new Error("REDIS_URL must use the redis or rediss protocol");
  }
  if (parsed.hostname === "") {
    throw new Error("REDIS_URL must include a host");
  }
  if (
    enabled &&
    environment.NODE_ENV === "production" &&
    (parsed.password.length < 16 || /(?:change|example|password|notted)/iu.test(parsed.password))
  ) {
    throw new Error("REDIS_URL must include a strong non-placeholder password in production");
  }
  return value;
}

export function parseRedisConfig(environment: Environment): RedisConfig {
  try {
    const enabled = readBoolean(environment, "FEATURE_REDIS_ENABLED", true);
    return Object.freeze({
      enabled,
      url: readRedisUrl(environment, enabled),
      connectTimeoutMs: readInteger(environment, "REDIS_CONNECT_TIMEOUT_MS", 3_000, 100, 60_000),
      commandTimeoutMs: readInteger(environment, "REDIS_COMMAND_TIMEOUT_MS", 2_500, 100, 30_000),
      readinessTimeoutMs: readInteger(
        environment,
        "REDIS_READINESS_TIMEOUT_MS",
        2_500,
        100,
        30_000,
      ),
      maxRetriesPerRequest: readInteger(environment, "REDIS_MAX_RETRIES_PER_REQUEST", 2, 0, 10),
      retryDelayMs: readInteger(environment, "REDIS_RETRY_DELAY_MS", 100, 10, 10_000),
      retryMaxDelayMs: readInteger(environment, "REDIS_RETRY_MAX_DELAY_MS", 2_000, 10, 60_000),
      startupRetryAttempts: readInteger(
        environment,
        "REDIS_STARTUP_RETRY_ATTEMPTS",
        environment.NODE_ENV === "test" ? 1 : 3,
        1,
        10,
      ),
    });
  } catch (error: unknown) {
    wrapConfigError("Invalid Redis configuration", error);
  }
}

@Injectable()
export class RedisConfigProvider {
  readonly value = parseRedisConfig(process.env);
}

export const redisConfigProvider: Provider<RedisConfig> = {
  provide: REDIS_CONFIG,
  inject: [RedisConfigProvider],
  useFactory: (provider: RedisConfigProvider): RedisConfig => provider.value,
};
