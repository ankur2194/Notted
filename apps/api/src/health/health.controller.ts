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

const READINESS_CACHE_TTL_MS = 1_000;

@Controller("health")
export class HealthController {
  private cachedReadiness:
    { readonly expiresAt: number; readonly response: ReadinessResponse } | undefined;
  private readinessInFlight: Promise<ReadinessResponse> | undefined;

  constructor(
    @Inject(READINESS_INDICATORS)
    private readonly indicators: readonly ReadinessIndicator[],
  ) {}

  @Get("live")
  @RateLimitExempt()
  liveness(): LivenessResponse {
    return { status: "ok" };
  }

  @Get("ready")
  async readiness(@Res({ passthrough: true }) response: Response): Promise<ReadinessResponse> {
    const result = await this.getReadiness();
    response.status(result.status === "ready" ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }

  private async getReadiness(): Promise<ReadinessResponse> {
    if (this.cachedReadiness !== undefined && this.cachedReadiness.expiresAt > Date.now()) {
      return this.cachedReadiness.response;
    }
    if (this.readinessInFlight !== undefined) {
      return this.readinessInFlight;
    }

    const evaluation = this.evaluateReadiness();
    this.readinessInFlight = evaluation;
    try {
      const result = await evaluation;
      this.cachedReadiness = {
        expiresAt: Date.now() + READINESS_CACHE_TTL_MS,
        response: result,
      };
      return result;
    } finally {
      if (this.readinessInFlight === evaluation) {
        this.readinessInFlight = undefined;
      }
    }
  }

  private async evaluateReadiness(): Promise<ReadinessResponse> {
    const checks = await Promise.all(
      this.indicators.map(async (indicator): Promise<ReadinessCheckResult> => {
        const startedAt = performance.now();
        try {
          const result = await indicator.check();
          return {
            ...result,
            durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          };
        } catch {
          return {
            name: indicator.name,
            status: "down",
            durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
            message: "Readiness check failed.",
          };
        }
      }),
    );
    const ready = checks.every((check) => check.status !== "down");

    return {
      status: ready ? "ready" : "not_ready",
      checks,
    };
  }
}
