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
  /** Part 58 — accepted Yjs updates per minute per principal. */
  readonly updatesPerMinute: number;
  /** Part 58 — relayed awareness frames per minute per principal. */
  readonly awarenessPerMinute: number;
  /** Part 58 — ceiling on one persisted Yjs update frame. */
  readonly maxUpdateBytes: number;
  /** Part 58 — ceiling on one relayed (never persisted) awareness frame. */
  readonly maxAwarenessBytes: number;
  /** Part 58 — ceiling on the durable Yjs state of a single note. */
  readonly maxCollaborationStateBytes: number;
  /** Part 59 — viewers one note room will register presence for; the rest read without a roster row. */
  readonly maxPresencePerRoom: number;
  /** Part 59 — presence announces per minute per principal. */
  readonly presenceAnnouncesPerMinute: number;
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
    const maxHttpBufferSize = readInteger(
      environment,
      "REALTIME_MAX_HTTP_BUFFER_BYTES",
      262_144,
      1_024,
      1_048_576,
    );
    const maxUpdateBytes = readInteger(
      environment,
      "REALTIME_MAX_UPDATE_BYTES",
      131_072,
      1_024,
      1_048_576,
    );
    const maxAwarenessBytes = readInteger(
      environment,
      "REALTIME_MAX_AWARENESS_BYTES",
      8_192,
      256,
      262_144,
    );
    // A frame the collaboration contract accepts but the transport drops is an
    // update the client believes was persisted and the server never saw. Reject
    // that configuration at boot rather than at 3am.
    if (maxUpdateBytes >= maxHttpBufferSize) {
      throw new Error("REALTIME_MAX_UPDATE_BYTES must be below REALTIME_MAX_HTTP_BUFFER_BYTES");
    }
    if (maxAwarenessBytes >= maxHttpBufferSize) {
      throw new Error("REALTIME_MAX_AWARENESS_BYTES must be below REALTIME_MAX_HTTP_BUFFER_BYTES");
    }
    return Object.freeze({
      path,
      pingIntervalMs,
      pingTimeoutMs,
      revalidationIntervalMs,
      maxHttpBufferSize,
      maxUpdateBytes,
      maxAwarenessBytes,
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
      updatesPerMinute: readInteger(environment, "REALTIME_UPDATES_PER_MINUTE", 900, 1, 100_000),
      awarenessPerMinute: readInteger(
        environment,
        "REALTIME_AWARENESS_PER_MINUTE",
        900,
        1,
        100_000,
      ),
      maxCollaborationStateBytes: readInteger(
        environment,
        "COLLABORATION_MAX_STATE_BYTES",
        4_194_304,
        65_536,
        67_108_864,
      ),
      maxPresencePerRoom: readInteger(environment, "REALTIME_MAX_PRESENCE_PER_ROOM", 50, 1, 500),
      presenceAnnouncesPerMinute: readInteger(
        environment,
        "REALTIME_PRESENCE_ANNOUNCES_PER_MINUTE",
        30,
        1,
        10_000,
      ),
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
