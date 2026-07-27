import { Injectable, type Provider } from "@nestjs/common";

import {
  type Environment,
  readBoolean,
  readHost,
  readInteger,
  readSecret,
  readString,
  wrapConfigError,
} from "./environment-readers";

export const MINIO_CONFIG = Symbol("MINIO_CONFIG");

export interface MinioConfig {
  readonly enabled: boolean;
  readonly endPoint: string;
  readonly port: number;
  readonly useSsl: boolean;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly attachmentsBucket: string;
  readonly exportsBucket: string;
  readonly region: string;
  readonly readinessTimeoutMs: number;
  readonly startupRetryAttempts: number;
  readonly retryDelayMs: number;
}

function readBucket(environment: Environment, key: string, fallback: string): string {
  const value = readString(environment, key, fallback);
  if (!/^[a-z\d][a-z\d.-]{1,61}[a-z\d]$/u.test(value)) {
    throw new Error(`${key} must be a valid DNS-compatible bucket name`);
  }
  return value;
}

export function parseMinioConfig(environment: Environment): MinioConfig {
  try {
    const enabled = readBoolean(environment, "FEATURE_STORAGE_ENABLED", true);
    const productionRequired = enabled && environment.NODE_ENV === "production";
    return Object.freeze({
      enabled,
      endPoint: readHost(
        environment,
        "MINIO_ENDPOINT",
        productionRequired ? undefined : "127.0.0.1",
      ),
      port: readInteger(environment, "MINIO_PORT", 9_000, 1, 65_535),
      useSsl: readBoolean(environment, "MINIO_USE_SSL", false),
      accessKey:
        readSecret(environment, "MINIO_ACCESS_KEY", {
          fallback: productionRequired ? undefined : "nottedminio",
          minimumLength: 3,
          required: productionRequired,
        }) ?? "disabled",
      secretKey:
        readSecret(environment, "MINIO_SECRET_KEY", {
          fallback: productionRequired ? undefined : "notted-dev-minio-secret",
          minimumLength: productionRequired ? 32 : 8,
          required: productionRequired,
        }) ?? "disabled-secret",
      attachmentsBucket: readBucket(environment, "MINIO_BUCKET_ATTACHMENTS", "notted-attachments"),
      exportsBucket: readBucket(environment, "MINIO_BUCKET_EXPORTS", "notted-exports"),
      region: readString(environment, "MINIO_REGION", "us-east-1"),
      readinessTimeoutMs: readInteger(
        environment,
        "MINIO_READINESS_TIMEOUT_MS",
        2_500,
        100,
        30_000,
      ),
      startupRetryAttempts: readInteger(
        environment,
        "MINIO_STARTUP_RETRY_ATTEMPTS",
        environment.NODE_ENV === "test" ? 1 : 3,
        1,
        10,
      ),
      retryDelayMs: readInteger(environment, "MINIO_RETRY_DELAY_MS", 100, 10, 10_000),
    });
  } catch (error: unknown) {
    wrapConfigError("Invalid MinIO configuration", error);
  }
}

@Injectable()
export class MinioConfigProvider {
  readonly value = parseMinioConfig(process.env);
}

export const minioConfigProvider: Provider<MinioConfig> = {
  provide: MINIO_CONFIG,
  inject: [MinioConfigProvider],
  useFactory: (provider: MinioConfigProvider): MinioConfig => provider.value,
};
