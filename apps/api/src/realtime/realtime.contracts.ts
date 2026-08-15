import { z } from "zod";

const id = z.string().uuid();
const noteSelector = z.object({ kind: z.literal("note"), workspaceId: id, noteId: id }).strict();
export const realtimeNoteSelectorSchema = noteSelector;
export const realtimeRoomSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), workspaceId: id }).strict(),
  noteSelector,
]);
export const realtimeRoomJoinSchema = z.object({ selector: realtimeRoomSelectorSchema }).strict();
export const realtimeRoomLeaveSchema = realtimeRoomJoinSchema;
export const realtimeHeartbeatSchema = z
  .object({ sequence: z.number().int().nonnegative() })
  .strict();

export type RealtimeRoomSelector = z.infer<typeof realtimeRoomSelectorSchema>;
export type RealtimeNoteSelector = z.infer<typeof noteSelector>;

/**
 * Part 58 — wire version of the collaborative note protocol. Bumped only when a
 * handshake payload changes shape; a client that announces a different version
 * is refused rather than served a state it cannot decode.
 */
export const NOTE_COLLABORATION_SCHEMA_VERSION = 1;

/**
 * Binary frames stay `Uint8Array` end to end. Node's `Buffer` IS a `Uint8Array`,
 * so Socket.io's native binary framing passes straight through with no base64
 * inflation, and the byte ceiling is checked before anything decodes the bytes.
 */
function binary(maxBytes: number) {
  return z.custom<Uint8Array>(
    (value) => value instanceof Uint8Array && value.byteLength <= maxBytes,
    { message: `expected a Uint8Array of at most ${maxBytes} bytes` },
  );
}

/**
 * The schemas are FACTORIES rather than constants because their byte ceilings
 * come from `REALTIME_CONFIG`, which `parseRealtimeConfig` cross-validates
 * against `maxHttpBufferSize`. A module-level constant would have to duplicate
 * (and could silently disagree with) the configured transport limit.
 */
export function createNoteCollaborationSyncSchema(maxBytes: number) {
  return z
    .object({
      selector: noteSelector,
      schemaVersion: z.literal(NOTE_COLLABORATION_SCHEMA_VERSION),
      stateVector: binary(maxBytes),
    })
    .strict();
}

export function createNoteCollaborationUpdateSchema(maxBytes: number) {
  return z
    .object({
      selector: noteSelector,
      epoch: z.number().int().positive(),
      update: binary(maxBytes),
    })
    .strict();
}

export function createNoteCollaborationAwarenessSchema(maxBytes: number) {
  return z.object({ selector: noteSelector, update: binary(maxBytes) }).strict();
}

/**
 * Part 59 — presence announce. The client sends ONLY where it is and which Yjs
 * clientID its awareness frames will carry.
 *
 * NOTE WHAT IS ABSENT, it is the whole anti-forgery design: no `presenceId`, no
 * `userId`, no `name`, no `color`. The server mints the `presenceId` with
 * `randomUUID()` at announce time and derives the identity from the socket's
 * authenticated principal, so a client cannot claim an identity it was not
 * issued, and `.strict()` turns any attempt to supply one into a rejected frame
 * rather than a silently dropped field.
 */
export const realtimePresenceAnnounceSchema = z
  .object({
    selector: noteSelector,
    awarenessClientId: z.number().int().nonnegative().max(4_294_967_295),
  })
  .strict();

/**
 * One viewer of one note, as issued by the server. Ephemeral by construction:
 * it lives on `socket.data` and nowhere else — no table, no Redis key, no sweep
 * job — so when the process dies the roster dies with it (ADR 0004: presence
 * expires and is never restored as business data).
 */
export interface PresenceEntry {
  readonly presenceId: string;
  readonly userId: string;
  readonly colorIndex: number;
  readonly awarenessClientId: number;
}

export const REALTIME_EVENTS = Object.freeze({
  join: "realtime:room:join",
  leave: "realtime:room:leave",
  heartbeat: "realtime:heartbeat",
  // Part 58 collaborative editing. Client -> server:
  noteSync: "realtime:note:sync",
  noteUpdate: "realtime:note:update",
  noteAwareness: "realtime:note:awareness",
  // Part 59 presence. Client -> server (ack-carrying):
  presenceAnnounce: "realtime:presence:announce",
  // Server -> room:
  noteRemote: "realtime:note:remote",
  noteReset: "realtime:note:reset",
  noteProjected: "realtime:note:projected",
  presenceJoined: "realtime:presence:joined",
  presenceLeft: "realtime:presence:left",
  // Part 60 inline comments. Server -> room ONLY (identifiers, no content):
  // there is no client -> server comment frame, so nothing on this path needs
  // `authorizeMessage`.
  commentChanged: "realtime:comment:changed",
} as const);
