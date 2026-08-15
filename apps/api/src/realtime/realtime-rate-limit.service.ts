import { createHmac } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import { AUTH_CONFIG, type AuthConfig } from "../config/auth.config";
import { RedisService } from "../infrastructure/redis/redis.service";

@Injectable()
export class RealtimeRateLimitService {
  constructor(
    private readonly redis: RedisService,
    @Inject(AUTH_CONFIG) private readonly authConfig: AuthConfig,
  ) {}

  async allow(
    // `sync` is the collaborative handshake. It reuses the JOIN ceiling but not
    // the join BUCKET: one client operation issues both, so sharing the counter
    // would halve the budget a legitimate reconnect gets.
    tier: "ip" | "principal" | "join" | "sync" | "update" | "awareness" | "presence",
    value: string,
    limit: number,
  ): Promise<boolean> {
    const digest = this.digest(value);
    return (
      (await this.redis.incrementWithTtl(`realtime:v1:limit:${tier}:${digest}`, 60_000)) <= limit
    );
  }

  async acquireSocketLease(
    actorId: string,
    socketId: string,
    limit: number,
    ttlMs: number,
  ): Promise<boolean> {
    return this.redis.acquireBoundedLease(
      `realtime:v1:sockets:${this.digest(actorId)}`,
      this.digest(`${actorId}\0${socketId}`),
      limit,
      ttlMs,
    );
  }

  async releaseSocketLease(actorId: string, socketId: string): Promise<void> {
    await this.redis.releaseLease(
      `realtime:v1:sockets:${this.digest(actorId)}`,
      this.digest(`${actorId}\0${socketId}`),
    );
  }

  private digest(value: string): string {
    return createHmac("sha256", this.authConfig.secret).update(value).digest("base64url");
  }
}
