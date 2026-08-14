import { z } from "zod";

const id = z.string().uuid();
export const realtimeRoomSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), workspaceId: id }).strict(),
  z.object({ kind: z.literal("note"), workspaceId: id, noteId: id }).strict(),
]);
export const realtimeRoomJoinSchema = z.object({ selector: realtimeRoomSelectorSchema }).strict();
export const realtimeRoomLeaveSchema = realtimeRoomJoinSchema;
export const realtimeHeartbeatSchema = z
  .object({ sequence: z.number().int().nonnegative() })
  .strict();

export type RealtimeRoomSelector = z.infer<typeof realtimeRoomSelectorSchema>;

export const REALTIME_EVENTS = Object.freeze({
  join: "realtime:room:join",
  leave: "realtime:room:leave",
  heartbeat: "realtime:heartbeat",
});
