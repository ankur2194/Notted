import { describe, expect, it } from "vitest";

import { parseFeaturesConfig } from "./features.config";
import { parseRealtimeConfig } from "./realtime.config";

describe("realtime configuration", () => {
  it("freezes bounded defaults", () => {
    const value = parseRealtimeConfig({});
    expect(Object.isFrozen(value)).toBe(true);
    expect(value).toMatchObject({
      path: "/socket.io",
      revalidationIntervalMs: 25_000,
      maxRoomsPerSocket: 32,
    });
  });

  it("rejects realtime without Redis", () => {
    expect(() =>
      parseFeaturesConfig({ FEATURE_REDIS_ENABLED: "false", FEATURE_REALTIME_ENABLED: "true" }),
    ).toThrow(/requires FEATURE_REDIS_ENABLED/u);
  });

  it("rejects heartbeat and revalidation relationships that cannot fail closed", () => {
    expect(() =>
      parseRealtimeConfig({
        REALTIME_PING_INTERVAL_MS: "30000",
        REALTIME_PING_TIMEOUT_MS: "30000",
      }),
    ).toThrow(/must exceed/u);
    expect(() =>
      parseRealtimeConfig({
        REALTIME_PING_INTERVAL_MS: "10000",
        REALTIME_REVALIDATION_INTERVAL_MS: "11000",
      }),
    ).toThrow(/must not exceed/u);
  });

  it("accepts Socket.io's bounded dot segment but rejects query and fragment suffixes", () => {
    expect(parseRealtimeConfig({ REALTIME_PATH: "/socket.io" }).path).toBe("/socket.io");
    expect(() => parseRealtimeConfig({ REALTIME_PATH: "/socket.io?poll=1" })).toThrow(
      /bounded absolute path/u,
    );
    expect(() => parseRealtimeConfig({ REALTIME_PATH: "/socket.io#fragment" })).toThrow(
      /bounded absolute path/u,
    );
    expect(() => parseRealtimeConfig({ REALTIME_PATH: "/../socket.io" })).toThrow(
      /bounded absolute path/u,
    );
  });
});
