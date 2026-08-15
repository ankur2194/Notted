import { describe, expect, it } from "vitest";

import {
  createNoteCollaborationAwarenessSchema,
  createNoteCollaborationUpdateSchema,
  REALTIME_EVENTS,
  realtimeHeartbeatSchema,
  realtimePresenceAnnounceSchema,
  realtimeRoomJoinSchema,
} from "./realtime.contracts";

const selector = {
  kind: "note" as const,
  workspaceId: "00000000-0000-4000-8000-000000000001",
  noteId: "00000000-0000-4000-8000-000000000002",
};

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

  it("bounds collaborative update frames by byte length", () => {
    const schema = createNoteCollaborationUpdateSchema(16);
    expect(schema.safeParse({ selector, epoch: 1, update: new Uint8Array(16) }).success).toBe(true);
    expect(schema.safeParse({ selector, epoch: 1, update: new Uint8Array(17) }).success).toBe(
      false,
    );
  });

  it("rejects a binary field that is not a Uint8Array", () => {
    // Node's Buffer IS a Uint8Array, so Socket.io's native binary framing passes
    // through; a base64 string or a plain array must not.
    const schema = createNoteCollaborationUpdateSchema(64);
    expect(schema.safeParse({ selector, epoch: 1, update: Buffer.alloc(8) }).success).toBe(true);
    expect(schema.safeParse({ selector, epoch: 1, update: "AAAA" }).success).toBe(false);
    expect(schema.safeParse({ selector, epoch: 1, update: [1, 2, 3] }).success).toBe(false);
  });

  it("rejects unknown keys on every collaborative frame", () => {
    const update = createNoteCollaborationUpdateSchema(64);
    const awareness = createNoteCollaborationAwarenessSchema(64);
    expect(
      update.safeParse({ selector, epoch: 1, update: new Uint8Array(4), room: "forged" }).success,
    ).toBe(false);
    expect(awareness.safeParse({ selector, update: new Uint8Array(4), clientId: 7 }).success).toBe(
      false,
    );
    expect(
      awareness.safeParse({
        selector: { ...selector, extra: true },
        update: new Uint8Array(4),
      }).success,
    ).toBe(false);
  });

  it("accepts a presence announce that claims nothing but a location and a clientID", () => {
    expect(
      realtimePresenceAnnounceSchema.safeParse({ selector, awarenessClientId: 0 }).success,
    ).toBe(true);
    expect(
      realtimePresenceAnnounceSchema.safeParse({ selector, awarenessClientId: 4_294_967_295 })
        .success,
    ).toBe(true);
  });

  // THIS IS THE ANTI-FORGERY CONTRACT, asserted field by field: the server mints
  // the identity, so a client that tries to supply one gets a rejected frame
  // rather than a silently ignored key.
  it.each(["presenceId", "userId", "name", "color"])(
    "rejects a client-supplied %s on a presence announce",
    (field) => {
      expect(
        realtimePresenceAnnounceSchema.safeParse({
          selector,
          awarenessClientId: 1,
          [field]: "forged",
        }).success,
      ).toBe(false);
    },
  );

  it("rejects an unknown key on a presence announce", () => {
    expect(
      realtimePresenceAnnounceSchema.safeParse({ selector, awarenessClientId: 1, room: "guessed" })
        .success,
    ).toBe(false);
  });

  it.each([1.5, -1, 4_294_967_296, "1", null])(
    "rejects %j as an awareness clientID",
    (awarenessClientId) => {
      expect(
        realtimePresenceAnnounceSchema.safeParse({ selector, awarenessClientId }).success,
      ).toBe(false);
    },
  );

  it("rejects a presence announce that is not addressed to a note", () => {
    expect(
      realtimePresenceAnnounceSchema.safeParse({
        selector: { kind: "workspace", workspaceId: selector.workspaceId },
        awarenessClientId: 1,
      }).success,
    ).toBe(false);
  });

  it("pins the presence event names other packages code against", () => {
    expect(REALTIME_EVENTS.presenceAnnounce).toBe("realtime:presence:announce");
    expect(REALTIME_EVENTS.presenceJoined).toBe("realtime:presence:joined");
    expect(REALTIME_EVENTS.presenceLeft).toBe("realtime:presence:left");
  });
});
