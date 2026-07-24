import { Controller, Get, HttpStatus, Inject, Res } from "@nestjs/common";

import { RateLimitExempt } from "../common/rate-limit/rate-limit.decorator";

import {
  READINESS_INDICATORS,
  type ReadinessCheckResult,
  type ReadinessIndicator,
} from "./readiness-indicator";

import type { Response } from "express";

interface LivenessResponse {
  readonly status: "ok";
}

interface ReadinessResponse {
  readonly status: "not_ready" | "ready";
  readonly checks: readonly ReadinessCheckResult[];
}

@Controller("health")
@RateLimitExempt()
export class HealthController {
  constructor(
    @Inject(READINESS_INDICATORS)
    private readonly indicators: readonly ReadinessIndicator[],
  ) {}

  @Get("live")
  liveness(): LivenessResponse {
    return { status: "ok" };
  }

  @Get("ready")
  async readiness(@Res({ passthrough: true }) response: Response): Promise<ReadinessResponse> {
    const checks = await Promise.all(
      this.indicators.map(async (indicator): Promise<ReadinessCheckResult> => {
        try {
          return await indicator.check();
        } catch {
          return {
            name: indicator.name,
            status: "down",
            message: "Readiness check failed.",
          };
        }
      }),
    );
    const ready = checks.every((check) => check.status === "up");

    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: ready ? "ready" : "not_ready",
      checks,
    };
  }
}
