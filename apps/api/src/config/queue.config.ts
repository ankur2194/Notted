import { Injectable, type Provider } from "@nestjs/common";

import { PHYSICAL_QUEUE_NAMES, type PhysicalQueueName } from "../queue/queue-names";

import { type Environment, readInteger, wrapConfigError } from "./environment-readers";

export const QUEUE_CONFIG = Symbol("QUEUE_CONFIG");

export interface QueueWorkerConfig {
  readonly concurrency: number;
  readonly timeoutMs: number;
}

export interface AiProviderQueueLimitConfig {
  readonly maximum: number;
  readonly durationMs: number;
}

export interface QueueConfig {
  readonly attempts: number;
  readonly backoff: {
    readonly baseMs: number;
    readonly maximumMs: number;
    readonly jitter: number;
  };
  readonly dispatcher: {
    readonly intervalMs: number;
    readonly batchSize: number;
    readonly staleClaimMs: number;
  };
  readonly workers: Readonly<Record<PhysicalQueueName, QueueWorkerConfig>>;
  readonly aiProviderLimits: {
    readonly openAi: AiProviderQueueLimitConfig;
    readonly claude: AiProviderQueueLimitConfig;
  };
  readonly idempotencyRetentionDays: number;
  readonly retention: {
    readonly completedAgeSeconds: number;
    readonly completedCount: number;
    readonly failedAgeSeconds: number;
    readonly failedCount: number;
  };
  readonly shutdownGraceMs: number;
}

function frozenWorker(concurrency: number, timeoutMs: number): QueueWorkerConfig {
  return Object.freeze({ concurrency, timeoutMs });
}

function providerLimit(
  environment: Environment,
  prefix: "OPENAI" | "CLAUDE",
): AiProviderQueueLimitConfig {
  return Object.freeze({
    maximum: readInteger(environment, `QUEUE_AI_${prefix}_RATE_MAX`, 5, 1, 1_000),
    durationMs: readInteger(environment, `QUEUE_AI_${prefix}_RATE_DURATION_MS`, 1_000, 100, 60_000),
  });
}

export function parseQueueConfig(environment: Environment): QueueConfig {
  try {
    const baseMs = readInteger(environment, "QUEUE_BACKOFF_BASE_MS", 1_000, 100, 60_000);
    const maximumMs = readInteger(environment, "QUEUE_BACKOFF_MAX_MS", 60_000, 1_000, 900_000);
    if (maximumMs < baseMs) {
      throw new Error(
        "QUEUE_BACKOFF_MAX_MS must be greater than or equal to QUEUE_BACKOFF_BASE_MS",
      );
    }

    const intervalMs = readInteger(environment, "QUEUE_DISPATCH_INTERVAL_MS", 1_000, 100, 60_000);
    const staleClaimMs = readInteger(
      environment,
      "QUEUE_DISPATCH_STALE_CLAIM_MS",
      30_000,
      5_000,
      900_000,
    );
    if (staleClaimMs <= intervalMs) {
      throw new Error(
        "QUEUE_DISPATCH_STALE_CLAIM_MS must be greater than QUEUE_DISPATCH_INTERVAL_MS",
      );
    }

    const exportConcurrency = readInteger(environment, "QUEUE_EXPORT_CONCURRENCY", 2, 2, 2);
    const jitterPercent = readInteger(environment, "QUEUE_BACKOFF_JITTER_PERCENT", 20, 0, 100);

    return Object.freeze({
      attempts: readInteger(environment, "QUEUE_ATTEMPTS", 3, 1, 5),
      backoff: Object.freeze({ baseMs, maximumMs, jitter: jitterPercent / 100 }),
      dispatcher: Object.freeze({
        intervalMs,
        batchSize: readInteger(environment, "QUEUE_DISPATCH_BATCH_SIZE", 100, 1, 1_000),
        staleClaimMs,
      }),
      workers: Object.freeze({
        [PHYSICAL_QUEUE_NAMES.default]: frozenWorker(
          readInteger(environment, "QUEUE_DEFAULT_CONCURRENCY", 8, 1, 50),
          readInteger(environment, "QUEUE_DEFAULT_TIMEOUT_MS", 60_000, 1_000, 600_000),
        ),
        [PHYSICAL_QUEUE_NAMES.export]: frozenWorker(
          exportConcurrency,
          readInteger(environment, "QUEUE_EXPORT_TIMEOUT_MS", 600_000, 10_000, 1_800_000),
        ),
        [PHYSICAL_QUEUE_NAMES.ai]: frozenWorker(
          readInteger(environment, "QUEUE_AI_CONCURRENCY", 4, 1, 20),
          readInteger(environment, "QUEUE_AI_TIMEOUT_MS", 120_000, 5_000, 900_000),
        ),
        [PHYSICAL_QUEUE_NAMES.maintenance]: frozenWorker(
          readInteger(environment, "QUEUE_MAINTENANCE_CONCURRENCY", 1, 1, 10),
          readInteger(environment, "QUEUE_MAINTENANCE_TIMEOUT_MS", 300_000, 5_000, 1_800_000),
        ),
      }),
      aiProviderLimits: Object.freeze({
        openAi: providerLimit(environment, "OPENAI"),
        claude: providerLimit(environment, "CLAUDE"),
      }),
      idempotencyRetentionDays: readInteger(
        environment,
        "QUEUE_IDEMPOTENCY_RETENTION_DAYS",
        30,
        1,
        365,
      ),
      retention: Object.freeze({
        completedAgeSeconds: readInteger(
          environment,
          "QUEUE_COMPLETED_RETENTION_SECONDS",
          86_400,
          60,
          2_592_000,
        ),
        completedCount: readInteger(
          environment,
          "QUEUE_COMPLETED_RETENTION_COUNT",
          1_000,
          1,
          100_000,
        ),
        failedAgeSeconds: readInteger(
          environment,
          "QUEUE_FAILED_RETENTION_SECONDS",
          604_800,
          3_600,
          7_776_000,
        ),
        failedCount: readInteger(environment, "QUEUE_FAILED_RETENTION_COUNT", 5_000, 1, 100_000),
      }),
      shutdownGraceMs: readInteger(environment, "QUEUE_SHUTDOWN_GRACE_MS", 30_000, 1_000, 300_000),
    });
  } catch (error: unknown) {
    wrapConfigError("Invalid queue configuration", error);
  }
}

@Injectable()
export class QueueConfigProvider {
  readonly value = parseQueueConfig(process.env);
}

export const queueConfigProvider: Provider<QueueConfig> = {
  provide: QUEUE_CONFIG,
  inject: [QueueConfigProvider],
  useFactory: (provider: QueueConfigProvider): QueueConfig => provider.value,
};
