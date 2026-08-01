import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { RATE_LIMIT_EXEMPT } from "./rate-limit.decorator";
import { RateLimitService } from "./rate-limit.service";

import type { Request, Response } from "express";

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    private readonly rateLimit: RateLimitService,
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
    this.rateLimit.enforce(request, response);
    return true;
  }
}
