import { describe, expect, it, vi } from "vitest";

import { QueueReadinessIndicator } from "./queue-readiness.indicator";

import type { QueueInfrastructureService } from "./queue-infrastructure.service";

describe("QueueReadinessIndicator", () => {
  it("reports disabled without probing or exposing Redis configuration", async () => {
    const infrastructure = { operationalStatus: () => "disabled", probe: vi.fn() };
    const indicator = new QueueReadinessIndicator(
      infrastructure as unknown as QueueInfrastructureService,
    );

    const result = await indicator.check();
    expect(result).toEqual({
      name: "queue",
      status: "disabled",
      message: "Queue execution is disabled.",
    });
    expect(infrastructure.probe).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/redis:\/\/|payload|signed|error=/u);
  });

  it("is up only when the owned queue infrastructure probe succeeds", async () => {
    const infrastructure = {
      operationalStatus: () => "ready",
      probe: vi.fn().mockResolvedValue(true),
    };
    const indicator = new QueueReadinessIndicator(
      infrastructure as unknown as QueueInfrastructureService,
    );
    await expect(indicator.check()).resolves.toEqual({ name: "queue", status: "up" });
  });

  it("returns one redacted down state after startup or probe failure", async () => {
    const infrastructure = {
      operationalStatus: () => "down",
      probe: vi.fn().mockResolvedValue(false),
    };
    const indicator = new QueueReadinessIndicator(
      infrastructure as unknown as QueueInfrastructureService,
    );
    await expect(indicator.check()).resolves.toEqual({
      name: "queue",
      status: "down",
      message: "Queue runtime probe failed.",
    });
  });
});
