import { createHash } from "node:crypto";

import { Injectable } from "@nestjs/common";

import type { RealtimeRoomSelector } from "./realtime.contracts";
import type { Server } from "socket.io";

@Injectable()
export class RealtimeRoomService {
  // Part 58: the Socket.io server, handed over by `RealtimeGateway.afterInit`.
  //
  // WHY HERE. Server-initiated room events (`realtime:note:projected`,
  // `realtime:note:reset`) are raised by the collaboration service on a debounce
  // timer and by `NotesService.restoreVersion` — neither holds a socket. Parking
  // the server on the service that already owns room naming keeps the emit seam
  // where the room name is computed and, more importantly, keeps the dependency
  // arrow one-way: the gateway depends on the collaboration service, never the
  // reverse, so no `forwardRef` is needed anywhere in the module.
  private server: Server | null = null;

  attach(server: Server): void {
    this.server = server;
  }

  room(selector: RealtimeRoomSelector): string {
    const material =
      selector.kind === "workspace"
        ? `workspace\0${selector.workspaceId}`
        : `note\0${selector.workspaceId}\0${selector.noteId}`;
    return `notted:v1:${selector.kind}:${createHash("sha256").update(material).digest("base64url")}`;
  }

  /**
   * Fan out to every socket in the room across every API instance (the Redis
   * adapter carries it). A no-op before `attach`, which is exactly the right
   * behaviour for unit tests and for a boot that never installed the gateway.
   */
  emit(selector: RealtimeRoomSelector, event: string, payload: Readonly<object>): void {
    this.server?.to(this.room(selector)).emit(event, payload);
  }
}
