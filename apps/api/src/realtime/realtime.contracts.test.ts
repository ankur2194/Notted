import { describe, expect, it } from "vitest";

import { realtimeHeartbeatSchema, realtimeRoomJoinSchema } from "./realtime.contracts";

describe("realtime external contracts", () => {
  it("accepts selectors and never literal room names", () => {
    expect(
      realtimeRoomJoinSchema.safeParse({
        selector: { kind: "workspace", workspaceId: "00000000-0000-4000-8000-000000000001" },
      }).success,
    ).toBe(true);
    expect(realtimeRoomJoinSchema.safeParse({ room: "guessed" }).success).toBe(false);
  });

  it("bounds heartbeat shape", () => {
    expect(realtimeHeartbeatSchema.safeParse({ sequence: 1 }).success).toBe(true);
    expect(realtimeHeartbeatSchema.safeParse({ sequence: 1, identity: "forged" }).success).toBe(
      false,
    );
  });
});
