import { describe, expect, it } from "vitest";

import { RealtimeRoomService } from "./realtime-room.service";

describe("RealtimeRoomService", () => {
  it("constructs deterministic collision-resistant private names", () => {
    const service = new RealtimeRoomService();
    const selector = {
      kind: "note" as const,
      workspaceId: "00000000-0000-4000-8000-000000000001",
      noteId: "00000000-0000-4000-8000-000000000002",
    };
    const room = service.room(selector);
    expect(room).toBe(service.room(selector));
    expect(room).not.toContain(selector.workspaceId);
    expect(room).not.toContain(selector.noteId);
  });
});
