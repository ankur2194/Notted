import { HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { HealthController } from "./health.controller";
import { ReadinessService } from "./readiness.service";

import type { ReadinessIndicator } from "./readiness-indicator";
import type { Response } from "express";

function responseWithStatus(): {
  readonly response: Response;
  readonly status: ReturnType<typeof vi.fn>;
} {
  const status = vi.fn().mockReturnThis();
  return { response: { status } as unknown as Response, status };
}

const controllerFor = (indicators: readonly ReadinessIndicator[]): HealthController =>
  new HealthController(new ReadinessService(indicators));

describe("HealthController", () => {
  it("keeps liveness dependency-free", () => {
    const indicator = { name: "dependency", check: vi.fn() } satisfies ReadinessIndicator;

    expect(controllerFor([indicator]).liveness()).toEqual({ status: "ok" });
    expect(indicator.check).not.toHaveBeenCalled();
  });

  it("answers 200 when every enabled dependency is up", async () => {
    const controller = controllerFor([
      { name: "database", check: vi.fn().mockResolvedValue({ name: "database", status: "up" }) },
      { name: "smtp", check: vi.fn().mockResolvedValue({ name: "smtp", status: "disabled" }) },
    ]);
    const { response, status } = responseWithStatus();

    await expect(controller.readiness(response)).resolves.toMatchObject({ status: "ready" });
    expect(status).toHaveBeenCalledWith(HttpStatus.OK);
  });

  it("answers 503 when an enabled dependency is down", async () => {
    const controller = controllerFor([
      { name: "redis", check: vi.fn().mockResolvedValue({ name: "redis", status: "down" }) },
    ]);
    const { response, status } = responseWithStatus();

    await expect(controller.readiness(response)).resolves.toMatchObject({ status: "not_ready" });
    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
  });
});
