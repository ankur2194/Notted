import { describe, expect, it } from "vitest";

import { RealtimeSocketAdapter } from "./realtime-socket.adapter";

describe("RealtimeSocketAdapter origin admission", () => {
  it.each([undefined, "null", "not a url", "http://app.test:4444"])(
    "rejects %s",
    async (origin) => {
      const adapter = new RealtimeSocketAdapter(
        {} as never,
        { realtimeEnabled: true } as never,
        {
          path: "/socket.io",
          pingIntervalMs: 30_000,
          pingTimeoutMs: 70_000,
          revalidationIntervalMs: 25_000,
          maxHttpBufferSize: 262_144,
          maxRoomsPerSocket: 32,
          preAuthAttemptsPerMinute: 30,
          authenticatedAttemptsPerMinute: 120,
          joinsPerMinute: 60,
          maxConcurrentSockets: 8,
        },
        { trustedOrigins: ["http://app.test"] } as never,
        { trustProxyHops: 0 } as never,
        { allow: async () => true } as never,
        { adapter: () => null } as never,
      );
      const rawHeaders = origin === undefined ? [] : ["Origin", origin];
      await expect(
        (
          adapter as unknown as {
            allowRequest(request: unknown, trusted: ReadonlySet<string>): Promise<boolean>;
          }
        ).allowRequest(
          { rawHeaders, headers: {}, socket: { remoteAddress: "127.0.0.1" } },
          new Set(["http://app.test"]),
        ),
      ).resolves.toBe(false);
    },
  );

  it("rejects duplicate origins and accepts one exact trusted origin", async () => {
    const adapter = new RealtimeSocketAdapter(
      {} as never,
      { realtimeEnabled: true } as never,
      {} as never,
      {} as never,
      { trustProxyHops: 0 } as never,
      { allow: async () => true } as never,
      { adapter: () => null } as never,
    );
    const call = (rawHeaders: string[]) =>
      (
        adapter as unknown as {
          allowRequest(request: unknown, trusted: ReadonlySet<string>): Promise<boolean>;
        }
      ).allowRequest(
        { rawHeaders, headers: {}, socket: { remoteAddress: "127.0.0.1" } },
        new Set(["http://app.test"]),
      );
    await expect(call(["Origin", "http://app.test", "Origin", "http://app.test"])).resolves.toBe(
      false,
    );
    await expect(call(["Origin", "http://app.test"])).resolves.toBe(true);
  });
});
