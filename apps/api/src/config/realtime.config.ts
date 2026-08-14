import { Injectable, type Provider } from "@nestjs/common";

import { type Environment, readInteger, readString, wrapConfigError } from "./environment-readers";

export const REALTIME_CONFIG = Symbol("REALTIME_CONFIG");

export interface RealtimeConfig {
  readonly path: string;
  readonly pingIntervalMs: number;
  readonly pingTimeoutMs: number;
  readonly revalidationIntervalMs: number;
  readonly maxHttpBufferSize: number;
  readonly maxRoomsPerSocket: number;
  readonly preAuthAttemptsPerMinute: number;
  readonly authenticatedAttemptsPerMinute: number;
  readonly joinsPerMinute: number;
  readonly maxConcurrentSockets: number;
}

export function parseRealtimeConfig(environment: Environment): RealtimeConfig {
  try {
    const path = readString(environment, "REALTIME_PATH", "/socket.io");
    const pathSegments = path.slice(1).split("/");
    if (
      path.length > 100 ||
      pathSegments.length === 0 ||
      pathSegments.some(
        (segment) =>
          segment === "." || segment === ".." || !/^[a-z0-9][a-z0-9._-]*$/iu.test(segment),
      )
    ) {
      throw new Error("REALTIME_PATH must be a bounded absolute path without query or fragment");
    }
    const pingIntervalMs = readInteger(
      environment,
      "REALTIME_PING_INTERVAL_MS",
      30_000,
      5_000,
      60_000,
    );
    const pingTimeoutMs = readInteger(
      environment,
      "REALTIME_PING_TIMEOUT_MS",
      70_000,
      10_000,
      120_000,
    );
    const revalidationIntervalMs = readInteger(
      environment,
      "REALTIME_REVALIDATION_INTERVAL_MS",
      25_000,
      5_000,
      30_000,
    );
    if (pingTimeoutMs <= pingIntervalMs) {
      throw new Error("REALTIME_PING_TIMEOUT_MS must exceed REALTIME_PING_INTERVAL_MS");
    }
    if (revalidationIntervalMs > pingIntervalMs) {
      throw new Error(
        "REALTIME_REVALIDATION_INTERVAL_MS must not exceed REALTIME_PING_INTERVAL_MS",
      );
    }
    return Object.freeze({
      path,
      pingIntervalMs,
      pingTimeoutMs,
      revalidationIntervalMs,
      maxHttpBufferSize: readInteger(
        environment,
        "REALTIME_MAX_HTTP_BUFFER_BYTES",
        262_144,
        1_024,
        1_048_576,
      ),
      maxRoomsPerSocket: readInteger(environment, "REALTIME_MAX_ROOMS_PER_SOCKET", 32, 1, 256),
      preAuthAttemptsPerMinute: readInteger(
        environment,
        "REALTIME_PREAUTH_ATTEMPTS_PER_MINUTE",
        30,
        1,
        10_000,
      ),
      authenticatedAttemptsPerMinute: readInteger(
        environment,
        "REALTIME_AUTH_ATTEMPTS_PER_MINUTE",
        120,
        1,
        100_000,
      ),
      joinsPerMinute: readInteger(environment, "REALTIME_JOINS_PER_MINUTE", 60, 1, 10_000),
      maxConcurrentSockets: readInteger(environment, "REALTIME_MAX_CONCURRENT_SOCKETS", 8, 1, 100),
    });
  } catch (error: unknown) {
    wrapConfigError("Invalid realtime configuration", error);
  }
}

@Injectable()
export class RealtimeConfigProvider {
  readonly value = parseRealtimeConfig(process.env);
}
export const realtimeConfigProvider: Provider<RealtimeConfig> = {
  provide: REALTIME_CONFIG,
  inject: [RealtimeConfigProvider],
  useFactory: (provider: RealtimeConfigProvider) => provider.value,
};
