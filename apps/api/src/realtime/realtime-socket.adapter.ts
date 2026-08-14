import { IoAdapter } from "@nestjs/platform-socket.io";

import { RealtimeRateLimitService } from "./realtime-rate-limit.service";
import { RealtimeRedisAdapterService } from "./realtime-redis-adapter.service";

import type { AppConfig } from "../config/app.config";
import type { AuthConfig } from "../config/auth.config";
import type { FeaturesConfig } from "../config/features.config";
import type { RealtimeConfig } from "../config/realtime.config";
import type { INestApplicationContext } from "@nestjs/common";
import type { IncomingMessage } from "node:http";
import type { Server, ServerOptions } from "socket.io";

export class RealtimeSocketAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly features: FeaturesConfig,
    private readonly config: RealtimeConfig,
    private readonly auth: AuthConfig,
    private readonly appConfig: AppConfig,
    private readonly limits: RealtimeRateLimitService,
    private readonly redisAdapter: RealtimeRedisAdapterService,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const trusted = new Set(this.auth.trustedOrigins);
    const server = super.createIOServer(port, {
      ...options,
      path: this.config.path,
      transports: ["websocket"],
      allowUpgrades: false,
      pingInterval: this.config.pingIntervalMs,
      pingTimeout: this.config.pingTimeoutMs,
      maxHttpBufferSize: this.config.maxHttpBufferSize,
      allowRequest: (
        request: IncomingMessage,
        callback: (error: string | null, success: boolean) => void,
      ) => {
        void this.allowRequest(request, trusted)
          .then((allowed: boolean) => callback(allowed ? null : "forbidden", allowed))
          .catch(() => callback("unavailable", false));
      },
    }) as Server;
    const adapter = this.redisAdapter.adapter();
    if (adapter !== null) server.adapter(adapter);
    return server;
  }

  private async allowRequest(
    request: IncomingMessage,
    trusted: ReadonlySet<string>,
  ): Promise<boolean> {
    if (!this.features.realtimeEnabled) return false;
    const origins: string[] = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() === "origin") {
        origins.push(request.rawHeaders[index + 1] ?? "");
      }
    }
    if (origins.length !== 1 || origins[0] === "null") return false;
    try {
      if (new URL(origins[0]!).origin !== origins[0] || !trusted.has(origins[0]!)) return false;
    } catch {
      return false;
    }
    return this.limits.allow("ip", this.ip(request), this.config.preAuthAttemptsPerMinute);
  }

  private ip(request: IncomingMessage): string {
    const remote = request.socket.remoteAddress ?? "unknown";
    if (this.appConfig.trustProxyHops === 0) return remote;
    const forwarded = request.headers["x-forwarded-for"];
    const values = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? ""))
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return values[Math.max(0, values.length - this.appConfig.trustProxyHops)] ?? remote;
  }
}
