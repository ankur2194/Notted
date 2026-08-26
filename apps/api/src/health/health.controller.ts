import { Controller, Get, HttpStatus, Res } from "@nestjs/common";

import { RateLimitExempt } from "../common/rate-limit/rate-limit.decorator";

import { ReadinessService, type ReadinessResponse } from "./readiness.service";

import type { Response } from "express";

interface LivenessResponse {
  readonly status: "ok";
}

/**
 * Two routes and nothing else. Evaluation, caching and in-flight de-duplication
 * moved to `ReadinessService` in Part 78 so the metrics collector can reuse the
 * same probe results instead of doubling the dependency load.
 */
@Controller("health")
export class HealthController {
  constructor(private readonly service: ReadinessService) {}

  @Get("live")
  @RateLimitExempt()
  liveness(): LivenessResponse {
    return { status: "ok" };
  }

  @Get("ready")
  async readiness(@Res({ passthrough: true }) response: Response): Promise<ReadinessResponse> {
    const result = await this.service.getReadiness();
    response.status(result.status === "ready" ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}
