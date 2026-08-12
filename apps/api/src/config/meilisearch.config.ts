import { Injectable, type Provider } from "@nestjs/common";

import {
  type Environment,
  readBoolean,
  readInteger,
  readSecret,
  readString,
  readUrl,
  wrapConfigError,
} from "./environment-readers";

export const MEILISEARCH_CONFIG = Symbol("MEILISEARCH_CONFIG");

export interface MeilisearchConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly apiKey?: string;
  readonly requestTimeoutMs: number;
  readonly readinessTimeoutMs: number;
  readonly startupRetryAttempts: number;
  readonly retryDelayMs: number;
  readonly indexPrefix: string;
  readonly taskTimeoutMs: number;
  readonly taskPollIntervalMs: number;
}

const INDEX_PREFIX_PATTERN = /^[a-z][a-z0-9_]{2,30}_$/u;
const NON_PRODUCTION_PREFIX_PATTERN = /(?:^|_)(?:dev|development|e2e|test|testing|local)(?:_|$)/u;

function readIndexPrefix(environment: Environment): string {
  const fallback =
    environment.NODE_ENV === "production"
      ? "notted_prod_"
      : environment.NODE_ENV === "test"
        ? "notted_test_"
        : "notted_dev_";
  const prefix = readString(environment, "MEILISEARCH_INDEX_PREFIX", fallback);

  if (!INDEX_PREFIX_PATTERN.test(prefix)) {
    throw new Error(
      "MEILISEARCH_INDEX_PREFIX must be 4-32 lowercase letters, digits, or underscores, start with a letter, and end with an underscore",
    );
  }
  if (environment.NODE_ENV === "production" && NON_PRODUCTION_PREFIX_PATTERN.test(prefix)) {
    throw new Error(
      "MEILISEARCH_INDEX_PREFIX must not use a development or test prefix in production",
    );
  }

  return prefix;
}

export function parseMeilisearchConfig(environment: Environment): MeilisearchConfig {
  try {
    const enabled = readBoolean(environment, "FEATURE_SEARCH_ENABLED", true);
    const productionRequired = enabled && environment.NODE_ENV === "production";
    const indexPrefix = readIndexPrefix(environment);
    const host = readUrl(environment, "MEILISEARCH_HOST", {
      allowedProtocols: ["http:", "https:"],
      fallback: productionRequired ? undefined : "http://127.0.0.1:7700",
      originOnly: true,
      required: productionRequired,
    });
    return Object.freeze({
      enabled,
      host: host.origin,
      apiKey: readSecret(environment, "MEILISEARCH_API_KEY", {
        fallback: productionRequired ? undefined : "notted-dev-meili-master-key",
        minimumLength: productionRequired ? 32 : 16,
        required: productionRequired,
      }),
      requestTimeoutMs: readInteger(
        environment,
        "MEILISEARCH_REQUEST_TIMEOUT_MS",
        5_000,
        100,
        120_000,
      ),
      readinessTimeoutMs: readInteger(
        environment,
        "MEILISEARCH_READINESS_TIMEOUT_MS",
        2_500,
        100,
        30_000,
      ),
      startupRetryAttempts: readInteger(
        environment,
        "MEILISEARCH_STARTUP_RETRY_ATTEMPTS",
        environment.NODE_ENV === "test" ? 1 : 3,
        1,
        10,
      ),
      retryDelayMs: readInteger(environment, "MEILISEARCH_RETRY_DELAY_MS", 100, 10, 10_000),
      indexPrefix,
      taskTimeoutMs: readInteger(environment, "MEILISEARCH_TASK_TIMEOUT_MS", 30_000, 100, 300_000),
      taskPollIntervalMs: readInteger(
        environment,
        "MEILISEARCH_TASK_POLL_INTERVAL_MS",
        100,
        10,
        5_000,
      ),
    });
  } catch (error: unknown) {
    wrapConfigError("Invalid Meilisearch configuration", error);
  }
}

@Injectable()
export class MeilisearchConfigProvider {
  readonly value = parseMeilisearchConfig(process.env);
}

export const meilisearchConfigProvider: Provider<MeilisearchConfig> = {
  provide: MEILISEARCH_CONFIG,
  inject: [MeilisearchConfigProvider],
  useFactory: (provider: MeilisearchConfigProvider): MeilisearchConfig => provider.value,
};
