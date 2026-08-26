import { describe, expect, it, vi } from "vitest";

import { ReadinessService } from "./readiness.service";

import type { ReadinessIndicator } from "./readiness-indicator";

describe("ReadinessService", () => {
  it("treats disabled dependencies as ready and preserves indicator order", async () => {
    const indicators = [
      { name: "database", check: vi.fn().mockResolvedValue({ name: "database", status: "up" }) },
      { name: "smtp", check: vi.fn().mockResolvedValue({ name: "smtp", status: "disabled" }) },
    ] satisfies readonly ReadinessIndicator[];

    await expect(new ReadinessService(indicators).getReadiness()).resolves.toEqual({
      status: "ready",
      checks: [
        { name: "database", status: "up", durationMs: expect.any(Number) },
        { name: "smtp", status: "disabled", durationMs: expect.any(Number) },
      ],
    });
  });

  it("marks the evaluation not ready and redacts thrown probe errors", async () => {
    const indicators = [
      {
        name: "redis",
        check: vi
          .fn()
          .mockResolvedValue({ name: "redis", status: "down", message: "Redis probe failed" }),
      },
      { name: "minio", check: vi.fn().mockRejectedValue(new Error("secret-key=do-not-leak")) },
    ] satisfies readonly ReadinessIndicator[];

    const result = await new ReadinessService(indicators).getReadiness();

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
    const service = new ReadinessService([{ name: "database", check }]);

    const first = service.getReadiness();
    const second = service.getReadiness();
    releaseProbe?.();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    // The metrics collector shares this cache; a third call inside the TTL must
    // not re-probe SMTP, MinIO and Meilisearch on every Prometheus scrape.
    await service.getReadiness();
    expect(check).toHaveBeenCalledTimes(1);
  });
});
