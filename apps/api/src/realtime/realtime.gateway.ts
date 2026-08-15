import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";

import { AuthService, toWebHeadersFromRaw } from "../auth/auth.service";
import { AuthorizationAdaptersService } from "../authorization/authorization-adapters.service";
import { FEATURES_CONFIG, type FeaturesConfig } from "../config/features.config";
import { REALTIME_CONFIG, type RealtimeConfig } from "../config/realtime.config";

import { decodeAwarenessClientIds } from "./awareness-client-ids";
import { presenceColorIndex } from "./presence-color";
import { RealtimeRateLimitService } from "./realtime-rate-limit.service";
import { RealtimeRedisAdapterService } from "./realtime-redis-adapter.service";
import { RealtimeRoomService } from "./realtime-room.service";
import {
  createNoteCollaborationAwarenessSchema,
  createNoteCollaborationSyncSchema,
  createNoteCollaborationUpdateSchema,
  REALTIME_EVENTS,
  realtimeHeartbeatSchema,
  realtimePresenceAnnounceSchema,
  realtimeRoomJoinSchema,
  realtimeRoomLeaveSchema,
  type PresenceEntry,
  type RealtimeNoteSelector,
  type RealtimeRoomSelector,
} from "./realtime.contracts";
import { NoteCollaborationProjectionService } from "./yjs/note-collaboration.projection";
import {
  NoteCollaborationService,
  type NoteCollaborationSyncResult,
} from "./yjs/note-collaboration.service";

import type { AuthenticatedPrincipal, CommentChangedEvent } from "@notted/shared-types";
import type { Server, Socket } from "socket.io";

interface RealtimeSocketData {
  principal?: AuthenticatedPrincipal;
  /**
   * Part 59 — this socket's presence row per room, keyed by room name.
   *
   * IT LIVES HERE AND NOT IN THE PROCESS-LOCAL `states` MAP because the roster
   * is read back with `this.server.in(room).fetchSockets()`, and
   * `@socket.io/redis-adapter` serialises `RemoteSocket.data` across instances.
   * A `Map` would not survive that round trip, hence the plain `Record`.
   *
   * There is no presence table, no Redis key and no sweep job: when the process
   * dies the roster dies with it. That is ADR 0004's "presence expires and is
   * never restored as business data" satisfied structurally rather than by a
   * cleanup path that can itself fail.
   */
  presence?: Record<string, PresenceEntry>;
}

/**
 * `RemoteSocket.data` arrives from another API instance through the Redis
 * adapter, so the roster read narrows structurally instead of asserting a
 * shape. The writer is another Notted process rather than a client, but a check
 * here is cheaper than a `NaN` viewer count at 3am.
 */
function presenceIn(data: unknown, room: string): PresenceEntry | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { presence } = data as { presence?: unknown };
  if (typeof presence !== "object" || presence === null) return undefined;
  const entry = (presence as Record<string, unknown>)[room];
  if (typeof entry !== "object" || entry === null) return undefined;
  const { presenceId, userId, colorIndex, awarenessClientId } = entry as Record<string, unknown>;
  if (
    typeof presenceId !== "string" ||
    typeof userId !== "string" ||
    typeof colorIndex !== "number" ||
    typeof awarenessClientId !== "number"
  )
    return undefined;
  return { presenceId, userId, colorIndex, awarenessClientId };
}

interface ConnectionState {
  readonly headers: Headers;
  readonly rooms: Set<string>;
  /** Note rooms this socket holds, so leave/disconnect can force a projection. */
  readonly notes: Map<string, RealtimeNoteSelector>;
  /**
   * Memoised `authorizeMessage` decisions keyed by `room\0action`.
   *
   * ponytail: a permission revoked mid-session keeps working for at most
   * `config.revalidationIntervalMs` (25 s), because the existing sweep clears
   * this set on the same interval and nothing else invalidates it. That window
   * is deliberate: at 900 updates/min/user an unmemoised seam is one Better Auth
   * session lookup per keystroke burst. Upgrade path when a shorter window is
   * needed: publish membership/permission revocations on the Redis adapter and
   * clear the matching entries on receipt.
   */
  readonly authorized: Set<string>;
  expiry?: NodeJS.Timeout;
  sweep?: NodeJS.Timeout;
  lastSeen: number;
  leaseActorId?: string;
  validating?: Promise<AuthenticatedPrincipal>;
}

type AckError = "denied" | "invalid" | "limited" | "stale" | "unavailable";
type AckFailure = { readonly ok: false; readonly error: AckError };
type Ack = (result: { readonly ok: true } | AckFailure) => void;
type SyncAck = (result: NoteCollaborationSyncResult | AckFailure) => void;
type UpdateAck = (
  result: { readonly ok: true; readonly epoch: number; readonly revision: number } | AckFailure,
) => void;
/**
 * Presence gets its own ack alias rather than widening `Ack`: only this event
 * returns a roster, and only this event reports a viewer count alongside a
 * refusal, so the extra shape must not leak into every other handler's contract.
 */
type PresenceAck = (
  result:
    | {
        readonly ok: true;
        readonly presence: PresenceEntry;
        readonly viewers: readonly PresenceEntry[];
        readonly viewerCount: number;
      }
    | { readonly ok: false; readonly error: "limited"; readonly viewerCount: number }
    | AckFailure,
) => void;

interface ClientEvents {
  "realtime:room:join": (input: unknown, ack?: Ack) => void;
  "realtime:room:leave": (input: unknown, ack?: Ack) => void;
  "realtime:heartbeat": (input: unknown, ack?: Ack) => void;
  "realtime:note:sync": (input: unknown, ack?: SyncAck) => void;
  "realtime:note:update": (input: unknown, ack?: UpdateAck) => void;
  "realtime:note:awareness": (input: unknown, ack?: Ack) => void;
  "realtime:presence:announce": (input: unknown, ack?: PresenceAck) => void;
}
interface ServerEvents {
  "realtime:ready": (payload: Readonly<{ ok: true }>) => void;
  "realtime:infrastructure:probe": (payload: Readonly<{ nonce: string }>) => void;
  // Every server -> room frame carries `noteId`. One Socket.io connection is
  // shared by the whole app, and Socket.io dispatches by EVENT NAME, not by
  // room: a socket in two note rooms receives both notes' frames on the same
  // handler. Without the identity a client can only filter on `epoch`, which is
  // per-note and collides freely, so a frame for note A would be applied to
  // note B's document.
  "realtime:note:remote": (
    payload: Readonly<{ noteId: string; epoch: number; revision: number; update: Uint8Array }>,
  ) => void;
  "realtime:note:reset": (payload: Readonly<{ noteId: string; epoch: number }>) => void;
  "realtime:note:projected": (
    payload: Readonly<{ noteId: string; version: number; revision: number; epoch: number }>,
  ) => void;
  "realtime:note:awareness": (payload: Readonly<{ noteId: string; update: Uint8Array }>) => void;
  // Presence frames carry `noteId` for exactly the reason above — they are not
  // exempt from the one-socket-many-rooms dispatch, and a roster row applied to
  // the wrong note is the same class of corruption Part 58 fixed.
  "realtime:presence:joined": (
    payload: Readonly<{ noteId: string; presence: PresenceEntry }>,
  ) => void;
  "realtime:presence:left": (payload: Readonly<{ noteId: string; presenceId: string }>) => void;
  // Part 60 — inline comments. Raised by `CommentsService` through
  // `RealtimeRoomService.emit` AFTER its transaction commits; this gateway has
  // no comment handler because there is no client -> server comment frame.
  // IDENTIFIERS ONLY: a content-carrying frame would bypass `comment.read` for
  // a socket that joined the room before losing permission, and ADR 0004 makes
  // event history non-authoritative — the id forces an authorized re-fetch.
  "realtime:comment:changed": (payload: Readonly<CommentChangedEvent>) => void;
}
type RealtimeSocket = Socket<ClientEvents, ServerEvents, Record<string, never>, RealtimeSocketData>;

@Injectable()
@WebSocketGateway({ transports: ["websocket"] })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() private server!: Server;
  private readonly states = new Map<string, ConnectionState>();
  private readonly syncSchema: ReturnType<typeof createNoteCollaborationSyncSchema>;
  private readonly updateSchema: ReturnType<typeof createNoteCollaborationUpdateSchema>;
  private readonly awarenessSchema: ReturnType<typeof createNoteCollaborationAwarenessSchema>;

  constructor(
    private readonly auth: AuthService,
    private readonly authorization: AuthorizationAdaptersService,
    private readonly rooms: RealtimeRoomService,
    private readonly limits: RealtimeRateLimitService,
    private readonly redisAdapter: RealtimeRedisAdapterService,
    @Inject(REALTIME_CONFIG) private readonly config: RealtimeConfig,
    private readonly collaboration: NoteCollaborationService,
    private readonly projections: NoteCollaborationProjectionService,
    @Inject(FEATURES_CONFIG) private readonly features: FeaturesConfig,
  ) {
    this.syncSchema = createNoteCollaborationSyncSchema(config.maxUpdateBytes);
    this.updateSchema = createNoteCollaborationUpdateSchema(config.maxUpdateBytes);
    this.awarenessSchema = createNoteCollaborationAwarenessSchema(config.maxAwarenessBytes);
  }

  /** Hands the io server to the room service so timer-driven code can fan out. */
  afterInit(server: Server): void {
    this.rooms.attach(server);
  }

  async handleConnection(socket: RealtimeSocket): Promise<void> {
    const state: ConnectionState = {
      headers: toWebHeadersFromRaw(socket.request.rawHeaders),
      rooms: new Set(),
      notes: new Map(),
      authorized: new Set(),
      lastSeen: performance.now(),
    };
    this.states.set(socket.id, state);
    try {
      if (!this.redisAdapter.isReady()) throw new Error("realtime unavailable");
      const principal = await this.validate(socket, state);
      if (
        !(await this.limits.allow(
          "principal",
          `${principal.userId}\0${principal.sessionId}`,
          this.config.authenticatedAttemptsPerMinute,
        ))
      ) {
        throw new Error("limited");
      }
      const leaseTtl =
        this.config.pingIntervalMs + this.config.pingTimeoutMs + this.config.revalidationIntervalMs;
      if (
        !(await this.limits.acquireSocketLease(
          principal.userId,
          socket.id,
          this.config.maxConcurrentSockets,
          leaseTtl,
        ))
      ) {
        throw new Error("limited");
      }
      state.leaseActorId = principal.userId;
      this.installTimers(socket, state, principal);
      this.installHandlers(socket, state);
      socket.emit("realtime:ready", { ok: true });
    } catch {
      await this.disconnect(socket);
    }
  }

  async handleDisconnect(socket: RealtimeSocket): Promise<void> {
    await this.cleanup(socket);
  }

  /** Internal/test-only infrastructure probe; no client event can invoke it. */
  emitInfrastructureProbe(
    selector: RealtimeRoomSelector,
    payload: Readonly<{ nonce: string }>,
  ): void {
    this.server.to(this.rooms.room(selector)).emit("realtime:infrastructure:probe", payload);
  }

  /**
   * Awareness is a PURE RELAY: authorized, size-checked and rate-limited, then
   * forwarded verbatim. It is never persisted, and the only thing ever read out
   * of it is the clientID header below — a cursor payload cannot become durable
   * state.
   *
   * Part 59 adds the clientID BINDING CHECK. Presence is already unforgeable in
   * every other direction: a client cannot put a name or a `userId` in awareness
   * (nothing reads those off the wire), and it cannot copy another viewer's
   * `presenceId` because the server mints it. The one remaining forgery is
   * publishing awareness under another peer's Yjs clientID, which would make the
   * cursor renderer paint your text with their label. Announcing binds
   * `presenceId -> (socket, userId, awarenessClientId)`, and this check enforces
   * that binding on every frame.
   *
   * ANNOUNCE BEFORE AWARENESS IS MANDATORY, not merely usual. Enforcing the
   * binding only when a presence row happened to exist left the whole check
   * opt-out: a socket that held `note.read`, joined, and simply never announced
   * could relay frames carrying any peer's clientID. Both halves of this
   * protocol ship together — `useNotePresence` announces the moment the
   * provider publishes `synced`, and the provider's first awareness flush is a
   * further 100 ms behind that — so a socket with no presence row is not an
   * older client, it is one that skipped the step that gives its cursor an
   * identity. Refused, not relayed.
   *
   * ponytail: this binds WHICH clientID a socket may publish under, and nothing
   * more. The cursor LABEL is client-authored awareness `user.name` (see
   * `apps/web/src/components/editor/extensions/note-editor-extensions.ts`), so
   * one note reader can still paint their caret with another member's display
   * name. That is deliberate and MUST NOT be "fixed" here: awareness is a pure
   * relay that the server never decodes beyond the clientID header, and reading
   * names off the wire to rewrite them would make an ephemeral cursor channel
   * into a server-authored identity channel. Upgrade path if labels ever have
   * to be trustworthy: drop `user.name` from awareness entirely and have the
   * renderer join the roster's `userId` (already server-minted) against the
   * member directory.
   *
   * Returns `false` when the frame was refused and NOT emitted.
   */
  relayAwareness(
    socket: RealtimeSocket,
    selector: RealtimeNoteSelector,
    update: Uint8Array,
  ): boolean {
    const room = this.rooms.room(selector);
    const bound = socket.data.presence?.[room];
    if (bound === undefined) return false;
    const clientIds = decodeAwarenessClientIds(update);
    // Undecodable is refused too: a frame we cannot read is a frame whose
    // clientIDs we cannot vouch for.
    if (clientIds === null || clientIds.some((id) => id !== bound.awarenessClientId)) return false;
    socket.to(room).emit(REALTIME_EVENTS.noteAwareness, { noteId: selector.noteId, update });
    return true;
  }

  /** Every permission-sensitive event passes through this seam before any useful work. */
  async authorizeMessage(
    socket: RealtimeSocket,
    selector: RealtimeRoomSelector,
    action: "workspace.read" | "note.read" | "note.update",
  ): Promise<void> {
    const state = this.states.get(socket.id);
    const key = `${this.rooms.room(selector)}\0${action}`;
    if (state?.authorized.has(key) === true) return;
    const principal = await this.revalidate(socket);
    await this.authorization.authorizeSocketMessage({
      principal,
      workspaceId: selector.workspaceId,
      action,
      resource:
        selector.kind === "note" ? { kind: "note", id: selector.noteId } : { kind: "workspace" },
    });
    state?.authorized.add(key);
  }

  private installHandlers(socket: RealtimeSocket, state: ConnectionState): void {
    socket.on(REALTIME_EVENTS.join, (input: unknown, ack?: Ack) => {
      void this.join(socket, state, input, ack);
    });
    socket.on(REALTIME_EVENTS.leave, (input: unknown, ack?: Ack) => {
      void this.leave(socket, state, input, ack);
    });
    socket.on(REALTIME_EVENTS.heartbeat, (input: unknown, ack?: Ack) => {
      void this.heartbeat(socket, state, input, ack);
    });
    // The server is the only holder of the collaboration flag: with it off the
    // events are simply not registered, and the web client degrades to autosave
    // on the failed handshake rather than reading a second public flag.
    if (!this.features.collaborationEnabled) return;
    socket.on(REALTIME_EVENTS.noteSync, (input: unknown, ack?: SyncAck) => {
      void this.noteSync(socket, state, input, ack);
    });
    socket.on(REALTIME_EVENTS.noteUpdate, (input: unknown, ack?: UpdateAck) => {
      void this.noteUpdate(socket, state, input, ack);
    });
    socket.on(REALTIME_EVENTS.noteAwareness, (input: unknown, ack?: Ack) => {
      void this.noteAwareness(socket, state, input, ack);
    });
    // Presence is registered behind the same flag as the rest of the note
    // events: with collaboration off there is nothing to be present in.
    socket.on(REALTIME_EVENTS.presenceAnnounce, (input: unknown, ack?: PresenceAck) => {
      void this.presence(socket, state, input, ack);
    });
  }

  /**
   * The collaborative handshake. ORDERING IS LOAD-BEARING: the socket joins the
   * room BEFORE the persisted state is read. Yjs buffers an update whose
   * dependencies are missing, but an update relayed during the read window on a
   * socket that has not joined is dropped by Socket.io and lost forever.
   */
  private async noteSync(
    socket: RealtimeSocket,
    state: ConnectionState,
    input: unknown,
    ack?: SyncAck,
  ): Promise<void> {
    const parsed = this.syncSchema.safeParse(input);
    if (!parsed.success) return ack?.({ ok: false, error: "invalid" });
    const { selector, stateVector } = parsed.data;
    try {
      await this.authorizeMessage(socket, selector, "note.read");
    } catch {
      return ack?.({ ok: false, error: "denied" });
    }
    // The handshake is the most EXPENSIVE frame this gateway serves — a room
    // join plus a transaction that replays the epoch log into a `Y.Doc` and can
    // write an epoch rebuild — and it was the only one with no tier of its own,
    // bounded solely by the per-connection attempt limit. It shares the JOIN
    // ceiling rather than introducing an environment variable nobody would
    // ever tune: joining and handshaking are one client operation, and every
    // handshake the web provider issues is preceded by a join anyway. Its own
    // bucket, so a reconnect storm cannot spend the join budget twice.
    if (!(await this.allowed(socket, "sync", this.config.joinsPerMinute)))
      return ack?.({ ok: false, error: "limited" });
    if (!(await this.enterRoom(socket, state, selector)))
      return ack?.({ ok: false, error: "limited" });
    try {
      ack?.(
        await this.collaboration.sync({
          workspaceId: selector.workspaceId,
          noteId: selector.noteId,
          stateVector,
        }),
      );
    } catch {
      ack?.({ ok: false, error: "unavailable" });
    }
  }

  /**
   * PERSIST BEFORE ACKNOWLEDGING (ADR 0004): validate, commit the revision, ack,
   * then relay. A failed insert acks `unavailable` and is NOT broadcast — the
   * client keeps it in its own `Y.Doc` and it goes out on the next sync.
   */
  private async noteUpdate(
    socket: RealtimeSocket,
    state: ConnectionState,
    input: unknown,
    ack?: UpdateAck,
  ): Promise<void> {
    const parsed = this.updateSchema.safeParse(input);
    if (!parsed.success) return ack?.({ ok: false, error: "invalid" });
    const { selector, epoch, update } = parsed.data;
    const room = this.rooms.room(selector);
    if (!state.rooms.has(room)) return ack?.({ ok: false, error: "denied" });
    try {
      await this.authorizeMessage(socket, selector, "note.update");
    } catch {
      return ack?.({ ok: false, error: "denied" });
    }
    const actorId = socket.data.principal?.userId;
    if (actorId === undefined) return ack?.({ ok: false, error: "denied" });
    if (!(await this.allowed(socket, "update", this.config.updatesPerMinute)))
      return ack?.({ ok: false, error: "limited" });
    const result = await this.collaboration.applyUpdate({
      workspaceId: selector.workspaceId,
      noteId: selector.noteId,
      epoch,
      update,
      actorId,
    });
    ack?.(result);
    if (!result.ok) return;
    socket.to(room).emit(REALTIME_EVENTS.noteRemote, {
      noteId: selector.noteId,
      epoch: result.epoch,
      revision: result.revision,
      update,
    });
    this.projections.schedule({
      workspaceId: selector.workspaceId,
      noteId: selector.noteId,
      forcedBoundary: false,
    });
  }

  private async noteAwareness(
    socket: RealtimeSocket,
    state: ConnectionState,
    input: unknown,
    ack?: Ack,
  ): Promise<void> {
    const parsed = this.awarenessSchema.safeParse(input);
    if (!parsed.success) return ack?.({ ok: false, error: "invalid" });
    const { selector, update } = parsed.data;
    if (!state.rooms.has(this.rooms.room(selector))) return ack?.({ ok: false, error: "denied" });
    try {
      await this.authorizeMessage(socket, selector, "note.read");
    } catch {
      return ack?.({ ok: false, error: "denied" });
    }
    if (!(await this.allowed(socket, "awareness", this.config.awarenessPerMinute)))
      return ack?.({ ok: false, error: "limited" });
    if (!this.relayAwareness(socket, selector, update))
      return ack?.({ ok: false, error: "invalid" });
    ack?.({ ok: true });
  }

  /**
   * Presence announce — the only way a viewer enters a note's roster.
   *
   * ANTI-FORGERY IS STRUCTURAL, not a validation rule: the frame carries no
   * `presenceId`, `userId`, `name` or colour (the schema is `.strict()`, so
   * supplying one is a rejected frame), the identity comes from the socket's
   * authenticated principal, and the server mints the `presenceId` here with
   * `randomUUID()`. A client cannot claim an identity it was not issued.
   *
   * Cross-workspace disclosure is closed twice over: the room name is a sha256
   * of the selector INCLUDING `workspaceId`, so a roster read cannot reach
   * another workspace's sockets at all, and every announce re-runs `note.read`
   * for this principal on this note rather than trusting the earlier join.
   *
   * Nothing here is logged: a roster is people and their whereabouts.
   */
  private async presence(
    socket: RealtimeSocket,
    state: ConnectionState,
    input: unknown,
    ack?: PresenceAck,
  ): Promise<void> {
    const parsed = realtimePresenceAnnounceSchema.safeParse(input);
    if (!parsed.success) return ack?.({ ok: false, error: "invalid" });
    const { selector, awarenessClientId } = parsed.data;
    const room = this.rooms.room(selector);
    // Presence follows the document: a socket that never completed `noteSync`
    // (or `join`) holds no seat to announce from.
    if (!state.rooms.has(room)) return ack?.({ ok: false, error: "denied" });
    try {
      await this.authorizeMessage(socket, selector, "note.read");
    } catch {
      return ack?.({ ok: false, error: "denied" });
    }
    if (!(await this.allowed(socket, "presence", this.config.presenceAnnouncesPerMinute)))
      return ack?.({ ok: false, error: "limited" });
    const userId = socket.data.principal?.userId;
    if (userId === undefined) return ack?.({ ok: false, error: "denied" });

    let roster: readonly PresenceEntry[];
    try {
      // `RemoteSocket.data` is `any` on the untyped server handle; the
      // annotation narrows it to `unknown` right at the boundary so the roster
      // read has to prove the shape rather than assume it.
      const sockets: readonly { readonly data: unknown }[] = await this.server
        .in(room)
        .fetchSockets();
      roster = sockets
        .map((peer) => presenceIn(peer.data, room))
        .filter((entry): entry is PresenceEntry => entry !== undefined);
    } catch {
      // An adapter hiccup must not throw out of a socket handler.
      return ack?.({ ok: false, error: "unavailable" });
    }

    const previous = socket.data.presence?.[room];
    // Our own prior row is excluded from both the cap and the roster: a
    // re-announce REPLACES it, so it must neither cost a slot nor appear twice.
    const peers = roster.filter((entry) => entry.presenceId !== previous?.presenceId);
    if (peers.length >= this.config.maxPresencePerRoom)
      return ack?.({ ok: false, error: "limited", viewerCount: peers.length });

    const entry: PresenceEntry = {
      presenceId: randomUUID(),
      userId,
      colorIndex: presenceColorIndex(userId),
      awarenessClientId,
    };
    // RE-ANNOUNCE IS AN UPDATE, NOT A DUPLICATE. A reconnect, or an epoch reset
    // that changes the Yjs clientID, re-announces on the same socket; retiring
    // the old id FIRST is what stops every peer accumulating a ghost row.
    if (previous !== undefined)
      socket.to(room).emit(REALTIME_EVENTS.presenceLeft, {
        noteId: selector.noteId,
        presenceId: previous.presenceId,
      });
    socket.data.presence = { ...(socket.data.presence ?? {}), [room]: entry };
    socket
      .to(room)
      .emit(REALTIME_EVENTS.presenceJoined, { noteId: selector.noteId, presence: entry });
    const viewers = [...peers, entry];
    ack?.({ ok: true, presence: entry, viewers, viewerCount: viewers.length });
  }

  /** Join (idempotently) and remember note rooms for the leave-time projection. */
  private async enterRoom(
    socket: RealtimeSocket,
    state: ConnectionState,
    selector: RealtimeRoomSelector,
  ): Promise<boolean> {
    const room = this.rooms.room(selector);
    if (!state.rooms.has(room)) {
      if (state.rooms.size >= this.config.maxRoomsPerSocket) return false;
      await socket.join(room);
      state.rooms.add(room);
    }
    if (selector.kind === "note") state.notes.set(room, selector);
    return true;
  }

  private async allowed(
    socket: RealtimeSocket,
    tier: "sync" | "update" | "awareness" | "presence",
    limit: number,
  ): Promise<boolean> {
    const principal = socket.data.principal;
    if (principal === undefined) return false;
    return this.limits.allow(tier, `${principal.userId}\0${principal.sessionId}`, limit);
  }

  private async join(
    socket: RealtimeSocket,
    state: ConnectionState,
    input: unknown,
    ack?: Ack,
  ): Promise<void> {
    const parsed = realtimeRoomJoinSchema.safeParse(input);
    if (!parsed.success) return ack?.({ ok: false, error: "invalid" });
    let principal: AuthenticatedPrincipal;
    try {
      if (!this.redisAdapter.isReady()) throw new Error("realtime unavailable");
      principal = await this.revalidate(socket);
    } catch {
      ack?.({ ok: false, error: "denied" });
      await this.disconnect(socket);
      return;
    }
    try {
      if (
        !(await this.limits.allow(
          "join",
          `${principal.userId}\0${principal.sessionId}`,
          this.config.joinsPerMinute,
        ))
      )
        return ack?.({ ok: false, error: "limited" });
      await this.authorization.authorizeSocketJoin({
        principal,
        workspaceId: parsed.data.selector.workspaceId,
        action: parsed.data.selector.kind === "note" ? "note.read" : "workspace.read",
        resource:
          parsed.data.selector.kind === "note"
            ? { kind: "note", id: parsed.data.selector.noteId }
            : { kind: "workspace" },
      });
      if (!(await this.enterRoom(socket, state, parsed.data.selector)))
        return ack?.({ ok: false, error: "limited" });
      ack?.({ ok: true });
    } catch {
      ack?.({ ok: false, error: "denied" });
    }
  }

  private async leave(
    socket: RealtimeSocket,
    state: ConnectionState,
    input: unknown,
    ack?: Ack,
  ): Promise<void> {
    const parsed = realtimeRoomLeaveSchema.safeParse(input);
    if (!parsed.success) return ack?.({ ok: false, error: "invalid" });
    const target = parsed.data.selector;
    const room = this.rooms.room(target);
    const held = socket.data.presence?.[room];
    if (state.rooms.delete(room)) await socket.leave(room);
    // Navigating away from a note while the tab stays open. The web provider
    // already emits `realtime:room:leave` from `destroy()`, so component
    // unmount is covered with no new client -> server event.
    if (held !== undefined && target.kind === "note") {
      // `socket.leave` has already run, so `socket.to(room)` may no longer
      // reach it; fan out from the server handle.
      this.server.to(room).emit(REALTIME_EVENTS.presenceLeft, {
        noteId: target.noteId,
        presenceId: held.presenceId,
      });
      socket.data.presence = Object.fromEntries(
        Object.entries(socket.data.presence ?? {}).filter(([key]) => key !== room),
      );
    }
    this.scheduleBoundary(state, room);
    ack?.({ ok: true });
  }

  /**
   * A departing participant may have been the last one. A redundant projection
   * is idempotent and CAS-guarded, so scheduling one per note room the socket
   * held is cheaper and safer than counting sockets across instances.
   */
  private scheduleBoundary(state: ConnectionState, room?: string): void {
    const selectors: RealtimeNoteSelector[] = [];
    if (room === undefined) selectors.push(...state.notes.values());
    else {
      const selector = state.notes.get(room);
      if (selector !== undefined) selectors.push(selector);
    }
    for (const selector of selectors) {
      this.projections.schedule({
        workspaceId: selector.workspaceId,
        noteId: selector.noteId,
        forcedBoundary: true,
      });
    }
    if (room === undefined) state.notes.clear();
    else state.notes.delete(room);
  }

  private async heartbeat(
    socket: RealtimeSocket,
    state: ConnectionState,
    input: unknown,
    ack?: Ack,
  ): Promise<void> {
    if (!realtimeHeartbeatSchema.safeParse(input).success)
      return ack?.({ ok: false, error: "invalid" });
    try {
      await this.revalidate(socket);
      state.lastSeen = performance.now();
      ack?.({ ok: true });
    } catch {
      await this.disconnect(socket);
    }
  }

  private async revalidate(socket: RealtimeSocket): Promise<AuthenticatedPrincipal> {
    const state = this.states.get(socket.id);
    if (state === undefined) throw new Error("disconnected");
    return this.validate(socket, state);
  }

  private async validate(
    socket: RealtimeSocket,
    state: ConnectionState,
  ): Promise<AuthenticatedPrincipal> {
    if (state.validating !== undefined) return state.validating;
    const validation = this.auth.authenticateHeaders(state.headers).then(async (principal) => {
      if (principal === null || Date.parse(principal.expiresAt) <= Date.now())
        throw new Error("unauthorized");
      const existing = socket.data.principal;
      if (
        existing !== undefined &&
        (existing.sessionId !== principal.sessionId || existing.userId !== principal.userId)
      )
        throw new Error("changed session");
      socket.data.principal = Object.freeze(principal);
      if (state.leaseActorId !== undefined) {
        const leaseTtl =
          this.config.pingIntervalMs +
          this.config.pingTimeoutMs +
          this.config.revalidationIntervalMs;
        if (
          !(await this.limits.acquireSocketLease(
            state.leaseActorId,
            socket.id,
            this.config.maxConcurrentSockets,
            leaseTtl,
          ))
        ) {
          throw new Error("socket lease unavailable");
        }
      }
      return principal;
    });
    state.validating = validation;
    try {
      return await validation;
    } finally {
      state.validating = undefined;
    }
  }

  private installTimers(
    socket: RealtimeSocket,
    state: ConnectionState,
    principal: AuthenticatedPrincipal,
  ): void {
    this.scheduleExpiry(socket, state, Date.parse(principal.expiresAt));
    state.sweep = setInterval(() => {
      // Bounds the memoised-authorization window to one revalidation interval.
      state.authorized.clear();
      if (
        performance.now() - state.lastSeen >
        this.config.pingIntervalMs + this.config.pingTimeoutMs
      ) {
        void this.disconnect(socket);
        return;
      }
      void this.revalidate(socket).catch(() => this.disconnect(socket));
    }, this.config.revalidationIntervalMs);
    state.sweep.unref();
  }

  private scheduleExpiry(socket: RealtimeSocket, state: ConnectionState, expiresAt: number): void {
    // Node clamps larger delays to one millisecond. Re-arm bounded timers for
    // unusually long provider sessions instead of disconnecting them at once.
    const remaining = Math.max(0, expiresAt - Date.now());
    const delay = Math.min(remaining, 2_147_000_000);
    state.expiry = setTimeout(() => {
      if (Date.now() >= expiresAt) void this.disconnect(socket);
      else this.scheduleExpiry(socket, state, expiresAt);
    }, delay);
    state.expiry.unref();
  }

  private async disconnect(socket: RealtimeSocket): Promise<void> {
    const state = this.states.get(socket.id);
    if (state !== undefined)
      await Promise.allSettled([...state.rooms].map((room) => socket.leave(room)));
    await this.cleanup(socket);
    socket.disconnect(true);
  }

  /**
   * The SINGLE teardown point: graceful disconnect, forced disconnect and the
   * sweep interval's stale-socket kill all funnel here, so a timeout and a crash
   * retire a presence row by the same path and no new timer is needed.
   */
  private async cleanup(socket: RealtimeSocket): Promise<void> {
    const state = this.states.get(socket.id);
    // CAPTURE BEFORE ANYTHING CLEARS. `scheduleBoundary(state)` empties
    // `state.notes`, and each presence frame needs its room's `noteId`.
    const notes = new Map<string, RealtimeNoteSelector>(state?.notes);
    const presence = socket.data.presence ?? {};
    if (state !== undefined) {
      if (state.expiry !== undefined) clearTimeout(state.expiry);
      if (state.sweep !== undefined) clearInterval(state.sweep);
      this.scheduleBoundary(state);
      state.rooms.clear();
      state.authorized.clear();
      this.states.delete(socket.id);
      if (state.leaseActorId !== undefined) {
        await this.limits.releaseSocketLease(state.leaseActorId, socket.id).catch(() => undefined);
      }
    }
    // `disconnect()` calls `socket.leave(room)` BEFORE cleanup, so `socket.to`
    // may no longer reach the room — fan out from the server handle instead.
    for (const [room, entry] of Object.entries(presence)) {
      const selector = notes.get(room);
      if (selector === undefined) continue;
      this.server.to(room).emit(REALTIME_EVENTS.presenceLeft, {
        noteId: selector.noteId,
        presenceId: entry.presenceId,
      });
    }
    socket.data.presence = undefined;
    socket.data.principal = undefined;
  }
}
