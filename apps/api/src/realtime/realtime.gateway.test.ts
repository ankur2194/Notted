import { describe, expect, it, vi } from "vitest";

import { RealtimeRoomService } from "./realtime-room.service";
import { RealtimeGateway } from "./realtime.gateway";

const config = {
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
};

function socket() {
  return {
    id: "socket",
    request: { rawHeaders: ["cookie", "session=safe-test-value"] },
    data: {},
    on: vi.fn(),
    join: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    emit: vi.fn(),
  };
}

describe("RealtimeGateway", () => {
  it("completes connection and reauthorizes permission-sensitive messages", async () => {
    const principal = {
      userId: "u",
      sessionId: "s",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const authorizeSocketMessage = vi.fn().mockResolvedValue(Object.freeze({}));
    const client = socket();
    const gateway = new RealtimeGateway(
      { authenticateHeaders: vi.fn().mockResolvedValue(principal) } as never,
      { authorizeSocketMessage } as never,
      new RealtimeRoomService(),
      {
        allow: vi.fn().mockResolvedValue(true),
        acquireSocketLease: vi.fn().mockResolvedValue(true),
        releaseSocketLease: vi.fn().mockResolvedValue(undefined),
      } as never,
      { isReady: () => true } as never,
      config,
    );

    await gateway.handleConnection(client as never);
    await gateway.authorizeMessage(
      client as never,
      { kind: "workspace", workspaceId: "00000000-0000-4000-8000-000000000001" },
      "workspace.read",
    );

    expect(client.on).toHaveBeenCalledTimes(3);
    expect(authorizeSocketMessage).toHaveBeenCalledOnce();
    expect(gateway).not.toHaveProperty("broadcast");
  });

  it.each(["revoked session", "adapter outage"])("fails closed for %s", async (scenario) => {
    const client = socket();
    const gateway = new RealtimeGateway(
      {
        authenticateHeaders: vi.fn().mockResolvedValue(
          scenario === "revoked session"
            ? null
            : {
                userId: "u",
                sessionId: "s",
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              },
        ),
      } as never,
      {} as never,
      new RealtimeRoomService(),
      { releaseSocketLease: vi.fn().mockResolvedValue(undefined) } as never,
      { isReady: () => scenario !== "adapter outage" } as never,
      config,
    );

    await gateway.handleConnection(client as never);

    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.on).not.toHaveBeenCalled();
  });
});
