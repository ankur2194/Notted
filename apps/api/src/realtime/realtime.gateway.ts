import { Inject, Injectable } from "@nestjs/common";
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";

import { AuthService, toWebHeadersFromRaw } from "../auth/auth.service";
import { AuthorizationAdaptersService } from "../authorization/authorization-adapters.service";
import { REALTIME_CONFIG, type RealtimeConfig } from "../config/realtime.config";

import { RealtimeRateLimitService } from "./realtime-rate-limit.service";
import { RealtimeRedisAdapterService } from "./realtime-redis-adapter.service";
import { RealtimeRoomService } from "./realtime-room.service";
import {
  REALTIME_EVENTS,
  realtimeHeartbeatSchema,
  realtimeRoomJoinSchema,
  realtimeRoomLeaveSchema,
  type RealtimeRoomSelector,
} from "./realtime.contracts";

import type { AuthenticatedPrincipal } from "@notted/shared-types";
import type { Server, Socket } from "socket.io";

interface RealtimeSocketData {
  principal?: AuthenticatedPrincipal;
}

interface ConnectionState {
  readonly headers: Headers;
  readonly rooms: Set<string>;
  expiry?: NodeJS.Timeout;
  sweep?: NodeJS.Timeout;
  lastSeen: number;
  leaseActorId?: string;
  validating?: Promise<AuthenticatedPrincipal>;
}

type Ack = (result: {
  readonly ok: boolean;
  readonly error?: "denied" | "invalid" | "limited";
}) => void;
interface ClientEvents {
  "realtime:room:join": (input: unknown, ack?: Ack) => void;
  "realtime:room:leave": (input: unknown, ack?: Ack) => void;
  "realtime:heartbeat": (input: unknown, ack?: Ack) => void;
}
interface ServerEvents {
  "realtime:ready": (payload: Readonly<{ ok: true }>) => void;
  "realtime:infrastructure:probe": (payload: Readonly<{ nonce: string }>) => void;
}
type RealtimeSocket = Socket<ClientEvents, ServerEvents, Record<string, never>, RealtimeSocketData>;

@Injectable()
@WebSocketGateway({ transports: ["websocket"] })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() private server!: Server;
  private readonly states = new Map<string, ConnectionState>();

  constructor(
    private readonly auth: AuthService,
    private readonly authorization: AuthorizationAdaptersService,
    private readonly rooms: RealtimeRoomService,
    private readonly limits: RealtimeRateLimitService,
    private readonly redisAdapter: RealtimeRedisAdapterService,
    @Inject(REALTIME_CONFIG) private readonly config: RealtimeConfig,
  ) {}

  async handleConnection(socket: RealtimeSocket): Promise<void> {
    const state: ConnectionState = {
      headers: toWebHeadersFromRaw(socket.request.rawHeaders),
      rooms: new Set(),
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

  /** Future permission-sensitive events must pass through this seam before any useful work. */
  async authorizeMessage(
    socket: RealtimeSocket,
    selector: RealtimeRoomSelector,
    action: "workspace.read" | "note.read",
  ) {
    const principal = await this.revalidate(socket);
    return this.authorization.authorizeSocketMessage({
      principal,
      workspaceId: selector.workspaceId,
      action,
      resource:
        selector.kind === "note" ? { kind: "note", id: selector.noteId } : { kind: "workspace" },
    });
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
      const room = this.rooms.room(parsed.data.selector);
      if (!state.rooms.has(room) && state.rooms.size >= this.config.maxRoomsPerSocket)
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
      if (!state.rooms.has(room)) {
        await socket.join(room);
        state.rooms.add(room);
      }
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
    const room = this.rooms.room(parsed.data.selector);
    if (state.rooms.delete(room)) await socket.leave(room);
    ack?.({ ok: true });
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

  private async cleanup(socket: RealtimeSocket): Promise<void> {
    const state = this.states.get(socket.id);
    if (state !== undefined) {
      if (state.expiry !== undefined) clearTimeout(state.expiry);
      if (state.sweep !== undefined) clearInterval(state.sweep);
      state.rooms.clear();
      this.states.delete(socket.id);
      if (state.leaseActorId !== undefined) {
        await this.limits.releaseSocketLease(state.leaseActorId, socket.id).catch(() => undefined);
      }
    }
    socket.data.principal = undefined;
  }
}
