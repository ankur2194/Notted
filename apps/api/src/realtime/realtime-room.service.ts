import { createHash } from "node:crypto";

import { Injectable } from "@nestjs/common";

import type { RealtimeRoomSelector } from "./realtime.contracts";

@Injectable()
export class RealtimeRoomService {
  room(selector: RealtimeRoomSelector): string {
    const material =
      selector.kind === "workspace"
        ? `workspace\0${selector.workspaceId}`
        : `note\0${selector.workspaceId}\0${selector.noteId}`;
    return `notted:v1:${selector.kind}:${createHash("sha256").update(material).digest("base64url")}`;
  }
}
