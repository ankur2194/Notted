import { Inject, Injectable } from "@nestjs/common";

import { ApiHttpException } from "../common/errors/api-http.exception";
import { RateLimitService } from "../common/rate-limit/rate-limit.service";
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
    private readonly rateLimit: RateLimitService,
  ) {}

  use(request: Request, response: Response, next: NextFunction): void {
    if (request.method !== "POST") {
      /*
       * Non-POST auth routes had NO rate limit from any layer.
       *
       * This returned early, and Nest's global `RateLimitGuard` never sees this
       * mount because it is raw Express, registered in `main.ts` ahead of the
       * Better Auth handler. So an unauthenticated client could flood
       * `GET /api/auth/get-session` and the OAuth callback paths uncapped, each
       * request costing a session-store lookup —
       * `docs/security/threat-model.md` describes the auth path as covered by
       * "a dedicated `:auth` token bucket keyed per IP", with no such carve-out.
       *
       * The GENERAL limit, not the `:auth` one. `RATE_LIMIT_AUTH_PER_MINUTE`
       * defaults to 5, and the web client calls `get-session` on every page
       * load, so charging reads to the sign-in budget would break normal use on
       * the sixth navigation. `RateLimitService` picks the unauthenticated
       * per-IP tier here because no credential middleware runs on this mount.
       */
      try {
        this.rateLimit.enforce(request, response);
      } catch (error: unknown) {
        if (!(error instanceof ApiHttpException)) throw error;
        this.reject(request, response);
        return;
      }
      next();
      return;
    }
    // Part 74. The authentication tier, not the generic sensitive tier, and its
    // own `:auth` bucket so draining it never consumes a caller's allowance for
    // sensitive application routes. This is the per-IP half only: the body is
    // deliberately not parsed here (Better Auth needs the raw stream), so the
    // per-identifier half lives in `AuthLockoutService`.
    const limit = this.config.authRateLimitPerMinute;
    const key = `auth-ip:${request.ip || request.socket.remoteAddress || "unknown"}:auth`;
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
    this.reject(request, response);
  }

  /**
   * The envelope, written directly. This is raw Express mounted before Nest's
   * exception filter, so a thrown `ApiHttpException` would reach Express's
   * default HTML error page instead of the repository's JSON contract — the
   * same reason the tRPC mount in `main.ts` catches and writes its own.
   * `RateLimitService` has already set the `RateLimit-*` and `Retry-After`
   * headers by the time it throws.
   */
  private reject(request: Request, response: Response): void {
    response.status(429).json({
      success: false,
      error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." },
      requestId: getRequestId(request) ?? "unknown",
    });
  }
}
