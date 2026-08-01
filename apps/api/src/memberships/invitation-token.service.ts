import { createHash, createHmac } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import { AUTH_CONFIG, type AuthConfig } from "../config/auth.config";

/**
 * Derives a token from an unpredictable invitation UUID and the validated
 * server secret. Only the SHA-256 hash is persisted. Part 61's worker can load
 * a pending invitation by id, derive the token just-in-time, send it, and
 * discard it without ever placing credentials in the outbox or delivery row.
 */
@Injectable()
export class InvitationTokenService {
  constructor(@Inject(AUTH_CONFIG) private readonly authConfig: AuthConfig) {}

  derive(invitationId: string): string {
    return createHmac("sha256", this.authConfig.secret)
      .update(`notted:workspace-invitation:v1:${invitationId}`, "utf8")
      .digest("base64url");
  }

  hash(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  hashForInvitation(invitationId: string): string {
    return this.hash(this.derive(invitationId));
  }
}
