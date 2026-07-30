import { Inject, Injectable } from "@nestjs/common";

import { RATE_LIMIT_STORE, type RateLimitStore } from "../common/rate-limit/rate-limit.types";
import { getRequestId } from "../common/request/request-context";
import { APP_CONFIG, type AppConfig } from "../config/app.config";

import type { NextFunction, Request, Response } from "express";

const MILLISECONDS_PER_MINUTE = 60_000;

@Injectable()
export class AuthRateLimitMiddleware {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
  ) {}

  use(request: Request, response: Response, next: NextFunction): void {
    if (request.method !== "POST") {
      next();
      return;
    }
    const limit = this.config.sensitiveRateLimitPerMinute;
    const key = `auth-ip:${request.ip || request.socket.remoteAddress || "unknown"}`;
    const decision = this.store.consume(key, {
      capacity: limit,
      refillTokensPerMillisecond: limit / MILLISECONDS_PER_MINUTE,
    });
    response.setHeader("RateLimit-Limit", limit);
    response.setHeader("RateLimit-Remaining", decision.remaining);
    response.setHeader(
      "RateLimit-Reset",
      Math.max(1, Math.ceil(decision.resetAfterMilliseconds / 1_000)),
    );
    if (decision.allowed) {
      next();
      return;
    }
    response.setHeader(
      "Retry-After",
      Math.max(1, Math.ceil(decision.retryAfterMilliseconds / 1_000)),
    );
    response.status(429).json({
      success: false,
      error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." },
      requestId: getRequestId(request) ?? "unknown",
    });
  }
}
