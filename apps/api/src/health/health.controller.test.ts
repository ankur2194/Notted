import { HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { HealthController } from "./health.controller";

import type { ReadinessIndicator } from "./readiness-indicator";
import type { Response } from "express";

function responseWithStatus(): {
  readonly response: Response;
  readonly status: ReturnType<typeof vi.fn>;
} {
  const status = vi.fn().mockReturnThis();
  return { response: { status } as unknown as Response, status };
}

describe("HealthController", () => {
  it("keeps liveness dependency-free", () => {
    const indicator = {
      name: "dependency",
      check: vi.fn(),
    } satisfies ReadinessIndicator;
    const controller = new HealthController([indicator]);

    expect(controller.liveness()).toEqual({ status: "ok" });
    expect(indicator.check).not.toHaveBeenCalled();
  });

  it("treats disabled dependencies as ready and preserves indicator order", async () => {
    const indicators = [
      { name: "database", check: vi.fn().mockResolvedValue({ name: "database", status: "up" }) },
      {
        name: "smtp",
        check: vi.fn().mockResolvedValue({ name: "smtp", status: "disabled" }),
      },
    ] satisfies readonly ReadinessIndicator[];
    const controller = new HealthController(indicators);
    const { response, status } = responseWithStatus();

    await expect(controller.readiness(response)).resolves.toEqual({
      status: "ready",
      checks: [
        { name: "database", status: "up", durationMs: expect.any(Number) },
        { name: "smtp", status: "disabled", durationMs: expect.any(Number) },
      ],
    });
    expect(status).toHaveBeenCalledWith(HttpStatus.OK);
  });

  it("returns 503 for enabled-down dependencies and redacts thrown probe errors", async () => {
    const indicators = [
      {
        name: "redis",
        check: vi.fn().mockResolvedValue({
          name: "redis",
          status: "down",
          message: "Redis probe failed",
        }),
      },
      {
        name: "minio",
        check: vi.fn().mockRejectedValue(new Error("secret-key=do-not-leak")),
      },
    ] satisfies readonly ReadinessIndicator[];
    const controller = new HealthController(indicators);
    const { response, status } = responseWithStatus();

    const result = await controller.readiness(response);

    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(result).toEqual({
      status: "not_ready",
      checks: [
        {
          name: "redis",
          status: "down",
          durationMs: expect.any(Number),
          message: "Redis probe failed",
        },
        {
          name: "minio",
          status: "down",
          durationMs: expect.any(Number),
          message: "Readiness check failed.",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("do-not-leak");
  });

  it("coalesces concurrent probes and briefly caches their result", async () => {
    let releaseProbe: (() => void) | undefined;
    const probePending = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const check = vi.fn(async () => {
      await probePending;
      return { name: "database", status: "up" as const };
    });
    const controller = new HealthController([{ name: "database", check }]);
    const first = responseWithStatus();
    const second = responseWithStatus();

    const firstResult = controller.readiness(first.response);
    const secondResult = controller.readiness(second.response);
    releaseProbe?.();

    await expect(Promise.all([firstResult, secondResult])).resolves.toHaveLength(2);
    await controller.readiness(responseWithStatus().response);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
