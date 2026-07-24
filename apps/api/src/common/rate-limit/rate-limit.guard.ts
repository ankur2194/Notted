import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { APP_CONFIG, type AppConfig } from "../../config/app.config";
import { ApiHttpException } from "../errors/api-http.exception";

import { RATE_LIMIT_EXEMPT } from "./rate-limit.decorator";
import { RATE_LIMIT_STORE, type RateLimitStore, type TokenBucketPolicy } from "./rate-limit.types";
import { getTrustedPrincipal } from "./trusted-principal";

import type { Request, Response } from "express";

const MILLISECONDS_PER_MINUTE = 60_000;

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const exempt = this.reflector.getAllAndOverride<boolean>(RATE_LIMIT_EXEMPT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (exempt === true) {
      return true;
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const principal = getTrustedPrincipal(request);
    const limit =
      principal === undefined
        ? this.config.unauthenticatedRateLimitPerMinute
        : this.config.authenticatedRateLimitPerMinute;
    const key =
      principal === undefined
        ? `ip:${request.ip || request.socket.remoteAddress || "unknown"}`
        : `actor:${principal.kind}:${principal.actorId}`;
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
      throw new ApiHttpException(HttpStatus.TOO_MANY_REQUESTS, {
        code: "RATE_LIMITED",
        message: "Too many requests. Try again later.",
      });
    }

    return true;
  }
}
