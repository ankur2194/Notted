import { isIP } from "node:net";

import { Injectable, type Provider } from "@nestjs/common";

export const APP_CONFIG = Symbol("APP_CONFIG");

export const NODE_ENVIRONMENTS = ["development", "test", "production"] as const;
export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly apiHost: string;
  readonly apiPort: number;
  readonly appUrl: URL;
  readonly logLevel: LogLevel;
  readonly trustProxyHops: number;
  readonly requestBodyLimitBytes: number;
  readonly unauthenticatedRateLimitPerMinute: number;
  readonly authenticatedRateLimitPerMinute: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

const INTEGER_PATTERN = /^\d+$/;

function readEnum<const T extends readonly string[]>(
  environment: Environment,
  key: string,
  allowed: T,
  fallback: T[number],
): T[number] {
  const value = environment[key] ?? fallback;
  if (!allowed.includes(value)) {
    throw new Error(`${key} must be one of: ${allowed.join(", ")}`);
  }

  return value as T[number];
}

function readInteger(
  environment: Environment,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const rawValue = environment[key];
  if (rawValue === undefined) {
    return fallback;
  }

  if (!INTEGER_PATTERN.test(rawValue)) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }

  return value;
}

function readAppUrl(environment: Environment, nodeEnv: NodeEnvironment): URL {
  const rawValue = environment.APP_URL;
  if (rawValue === undefined) {
    if (nodeEnv === "production") {
      throw new Error("APP_URL is required when NODE_ENV=production");
    }

    return new URL("http://localhost:3000");
  }

  let appUrl: URL;
  try {
    appUrl = new URL(rawValue);
  } catch {
    throw new Error("APP_URL must be an absolute HTTP or HTTPS URL");
  }

  if (appUrl.protocol !== "http:" && appUrl.protocol !== "https:") {
    throw new Error("APP_URL must use the http or https protocol");
  }

  if (appUrl.username !== "" || appUrl.password !== "") {
    throw new Error("APP_URL must not contain credentials");
  }

  if (appUrl.pathname !== "/" || appUrl.search !== "" || appUrl.hash !== "") {
    throw new Error("APP_URL must be an origin without a path, query, or fragment");
  }

  return appUrl;
}

function readApiHost(environment: Environment, nodeEnv: NodeEnvironment): string {
  const rawValue = environment.API_HOST;
  if (rawValue === undefined) {
    if (nodeEnv === "production") {
      throw new Error("API_HOST is required when NODE_ENV=production");
    }

    return "127.0.0.1";
  }

  const value = rawValue.trim();
  if (
    value === "" ||
    value.length > 253 ||
    (isIP(value) === 0 &&
      !/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)*[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/iu.test(value))
  ) {
    throw new Error("API_HOST must be a valid IP address or hostname");
  }

  return value;
}

export function parseAppConfig(environment: Environment): AppConfig {
  try {
    const nodeEnv = readEnum(environment, "NODE_ENV", NODE_ENVIRONMENTS, "development");

    return Object.freeze({
      nodeEnv,
      apiHost: readApiHost(environment, nodeEnv),
      apiPort: readInteger(environment, "API_PORT", 3001, 1, 65_535),
      appUrl: readAppUrl(environment, nodeEnv),
      logLevel: readEnum(environment, "LOG_LEVEL", LOG_LEVELS, "info"),
      trustProxyHops: readInteger(environment, "TRUST_PROXY_HOPS", 0, 0, 16),
      requestBodyLimitBytes: readInteger(
        environment,
        "REQUEST_BODY_LIMIT_BYTES",
        1_048_576,
        1_024,
        10_485_760,
      ),
      unauthenticatedRateLimitPerMinute: readInteger(
        environment,
        "RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE",
        60,
        1,
        100_000,
      ),
      authenticatedRateLimitPerMinute: readInteger(
        environment,
        "RATE_LIMIT_AUTHENTICATED_PER_MINUTE",
        1_000,
        1,
        1_000_000,
      ),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown validation error";
    throw new Error(`Invalid API environment configuration: ${message}`);
  }
}

@Injectable()
export class AppConfigProvider {
  readonly value = parseAppConfig(process.env);
}

export const appConfigProvider: Provider<AppConfig> = {
  provide: APP_CONFIG,
  inject: [AppConfigProvider],
  useFactory: (provider: AppConfigProvider): AppConfig => provider.value,
};
