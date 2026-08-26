import { Inject, Injectable } from "@nestjs/common";

import {
  READINESS_INDICATORS,
  type ReadinessCheckResult,
  type ReadinessIndicator,
} from "./readiness-indicator";

export interface ReadinessResponse {
  readonly status: "not_ready" | "ready";
  readonly checks: readonly ReadinessCheckResult[];
}

const READINESS_CACHE_TTL_MS = 1_000;

/**
 * Part 78 — the readiness evaluation, moved out of `HealthController` verbatim
 * so it has more than one caller.
 *
 * The controller was the only consumer while `/health/ready` was the only thing
 * that asked. The `notted_dependency_up` gauge asks the same question on every
 * Prometheus scrape, and pointing it at a second, independent probe path would
 * DOUBLE the load every dependency check imposes — an SMTP connection, a MinIO
 * round trip, a Meilisearch health call — for two consumers reading the same
 * fact. Sharing this service means the scrape reuses the 1 s cache and the
 * in-flight de-duplication below instead of racing the orchestrator's probe.
 */
@Injectable()
export class ReadinessService {
  private cachedReadiness:
    { readonly expiresAt: number; readonly response: ReadinessResponse } | undefined;
  private readinessInFlight: Promise<ReadinessResponse> | undefined;

  constructor(
    @Inject(READINESS_INDICATORS)
    private readonly indicators: readonly ReadinessIndicator[],
  ) {}

  async getReadiness(): Promise<ReadinessResponse> {
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
