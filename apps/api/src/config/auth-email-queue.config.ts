import { Injectable, type Provider } from "@nestjs/common";

import { type Environment, readInteger, wrapConfigError } from "./environment-readers";

export const AUTH_EMAIL_QUEUE_CONFIG = Symbol("AUTH_EMAIL_QUEUE_CONFIG");

export interface AuthEmailQueueConfig {
  readonly queueName: "auth-email";
  readonly payloadVersion: 1;
  readonly dispatcherIntervalMs: number;
  readonly concurrency: number;
  readonly attempts: number;
  readonly retryBackoffMs: number;
  readonly idempotencyRetentionDays: number;
}

export function parseAuthEmailQueueConfig(environment: Environment): AuthEmailQueueConfig {
  try {
    return Object.freeze({
      queueName: "auth-email",
      payloadVersion: 1,
      dispatcherIntervalMs: readInteger(
        environment,
        "AUTH_EMAIL_DISPATCH_INTERVAL_MS",
        1_000,
        100,
        60_000,
      ),
      concurrency: readInteger(environment, "AUTH_EMAIL_QUEUE_CONCURRENCY", 2, 1, 10),
      attempts: readInteger(environment, "AUTH_EMAIL_QUEUE_ATTEMPTS", 3, 1, 5),
      retryBackoffMs: readInteger(environment, "AUTH_EMAIL_QUEUE_BACKOFF_MS", 1_000, 100, 60_000),
      idempotencyRetentionDays: readInteger(
        environment,
        "AUTH_EMAIL_IDEMPOTENCY_RETENTION_DAYS",
        7,
        1,
        30,
      ),
    });
  } catch (error: unknown) {
    wrapConfigError("Invalid auth email queue configuration", error);
  }
}

@Injectable()
export class AuthEmailQueueConfigProvider {
  readonly value = parseAuthEmailQueueConfig(process.env);
}

export const authEmailQueueConfigProvider: Provider<AuthEmailQueueConfig> = {
  provide: AUTH_EMAIL_QUEUE_CONFIG,
  inject: [AuthEmailQueueConfigProvider],
  useFactory: (provider: AuthEmailQueueConfigProvider): AuthEmailQueueConfig => provider.value,
};
