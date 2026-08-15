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
      maxPresencePerRoom: 50,
      presenceAnnouncesPerMinute: 30,
    });
  });

  it("bounds the presence ceilings", () => {
    expect(parseRealtimeConfig({ REALTIME_MAX_PRESENCE_PER_ROOM: "200" }).maxPresencePerRoom).toBe(
      200,
    );
    expect(() => parseRealtimeConfig({ REALTIME_MAX_PRESENCE_PER_ROOM: "0" })).toThrow();
    expect(() => parseRealtimeConfig({ REALTIME_MAX_PRESENCE_PER_ROOM: "501" })).toThrow();
    expect(
      parseRealtimeConfig({ REALTIME_PRESENCE_ANNOUNCES_PER_MINUTE: "120" })
        .presenceAnnouncesPerMinute,
    ).toBe(120);
    expect(() => parseRealtimeConfig({ REALTIME_PRESENCE_ANNOUNCES_PER_MINUTE: "0" })).toThrow();
    expect(() =>
      parseRealtimeConfig({ REALTIME_PRESENCE_ANNOUNCES_PER_MINUTE: "10001" }),
    ).toThrow();
  });

  it("rejects realtime without Redis", () => {
    expect(() =>
      parseFeaturesConfig({ FEATURE_REDIS_ENABLED: "false", FEATURE_REALTIME_ENABLED: "true" }),
    ).toThrow(/requires FEATURE_REDIS_ENABLED/u);
  });

  it("rejects collaboration without realtime", () => {
    expect(() =>
      parseFeaturesConfig({
        FEATURE_REALTIME_ENABLED: "false",
        FEATURE_COLLABORATION_ENABLED: "true",
      }),
    ).toThrow(/requires FEATURE_REALTIME_ENABLED/u);
  });

  it("derives the collaboration default from realtime instead of forcing a second key", () => {
    // An environment that predates the flag — every deployed `.env`, and
    // `app.e2e.test.ts` — must keep booting with realtime off rather than
    // aborting on a key it has never heard of.
    expect(parseFeaturesConfig({ FEATURE_REALTIME_ENABLED: "false" })).toMatchObject({
      realtimeEnabled: false,
      collaborationEnabled: false,
    });
    expect(parseFeaturesConfig({}).collaborationEnabled).toBe(true);
    // The explicit "off while realtime is on" combination stays available.
    expect(
      parseFeaturesConfig({ FEATURE_COLLABORATION_ENABLED: "false" }).collaborationEnabled,
    ).toBe(false);
  });

  it("rejects frame ceilings the transport would silently drop", () => {
    // An update the collaboration contract accepts but the transport discards is
    // an update the client believes was persisted and the server never saw.
    expect(() =>
      parseRealtimeConfig({
        REALTIME_MAX_HTTP_BUFFER_BYTES: "131072",
        REALTIME_MAX_UPDATE_BYTES: "131072",
      }),
    ).toThrow(/REALTIME_MAX_UPDATE_BYTES must be below/u);
    expect(() =>
      parseRealtimeConfig({
        REALTIME_MAX_HTTP_BUFFER_BYTES: "8192",
        // Kept under the buffer so this asserts the awareness rule rather than
        // tripping the update rule first.
        REALTIME_MAX_UPDATE_BYTES: "4096",
        REALTIME_MAX_AWARENESS_BYTES: "8192",
      }),
    ).toThrow(/REALTIME_MAX_AWARENESS_BYTES must be below/u);
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
