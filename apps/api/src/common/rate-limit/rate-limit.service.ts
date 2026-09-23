import { Inject, Injectable } from "@nestjs/common";

import { APP_CONFIG, type AppConfig } from "../../config/app.config";
import { ApiHttpException } from "../errors/api-http.exception";

import { type RateLimitTierName } from "./rate-limit.decorator";
import { RATE_LIMIT_STORE, type RateLimitStore, type TokenBucketPolicy } from "./rate-limit.types";
import { getTrustedPrincipal, type TrustedPrincipal } from "./trusted-principal";

import type { Request, Response } from "express";

const MILLISECONDS_PER_MINUTE = 60_000;

/** Shared rate-limit boundary for Nest guards and direct Express transports. */
@Injectable()
export class RateLimitService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
  ) {}

  /**
   * Three tiers, selected only from the trusted principal an authentication
   * adapter installed: unauthenticated (per IP), authenticated user, and API
   * key. The bucket keys are disjoint by construction (`ip:` / `actor:user:` /
   * `actor:api-key:`), so a tier can never drain another tier's allowance.
   *
   * `tierOverride` opts a single route into a separate bucket. The sensitive
   * tier gets its own `:sensitive` bucket rather than sharing the general one:
   * otherwise a handful of sign-in-grade requests would consume the caller's
   * whole general allowance, and a caller already at their general limit could
   * not reach a sensitive route at all.
   * `public-ip` ignores the principal, uses the unauthenticated configured rate
   * and a distinct IP bucket, so public images/files cannot drain ordinary IP
   * requests and logging in cannot bypass the public route's IP ceiling.
   */
  enforce(request: Request, response: Response, tierOverride?: RateLimitTierName): void {
    const principal = tierOverride === "public-ip" ? undefined : getTrustedPrincipal(request);
    const limit = this.limitFor(principal, tierOverride);
    const bucket =
      principal === undefined
        ? `ip:${request.ip || request.socket.remoteAddress || "unknown"}`
        : `actor:${principal.kind}:${principal.actorId}`;
    const key = tierOverride === undefined ? bucket : `${bucket}:${tierOverride}`;
    const policy: TokenBucketPolicy = {
      capacity: limit,
      refillTokensPerMillisecond: limit / MILLISECONDS_PER_MINUTE,
    };
    const decision = this.store.consume(key, policy);

    response.setHeader("RateLimit-Limit", limit);
    response.setHeader("RateLimit-Remaining", decision.remaining);
    response.setHeader(
      "RateLimit-Reset",
      Math.max(1, Math.ceil(decision.resetAfterMilliseconds / 1_000)),
    );

    if (!decision.allowed) {
      response.setHeader(
        "Retry-After",
        Math.max(1, Math.ceil(decision.retryAfterMilliseconds / 1_000)),
      );
      throw new ApiHttpException(429, {
        code: "RATE_LIMITED",
        message: "Too many requests. Try again later.",
      });
    }
  }

  private limitFor(
    principal: TrustedPrincipal | undefined,
    tierOverride: RateLimitTierName | undefined,
  ): number {
    if (tierOverride === "sensitive") return this.config.sensitiveRateLimitPerMinute;
    if (principal === undefined) return this.config.unauthenticatedRateLimitPerMinute;
    return principal.kind === "api-key"
      ? this.config.apiKeyRateLimitPerMinute
      : this.config.authenticatedRateLimitPerMinute;
  }
}
