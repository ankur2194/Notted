import { describe, expect, it, vi } from "vitest";

import { RealtimeRedisAdapterService } from "./realtime-redis-adapter.service";

import type { FeaturesConfig } from "../config/features.config";
import type { RedisConfig } from "../config/redis.config";

const redisConfig: RedisConfig = {
  enabled: true,
  url: "redis://127.0.0.1:6379",
  connectTimeoutMs: 100,
  commandTimeoutMs: 100,
  readinessTimeoutMs: 100,
  maxRetriesPerRequest: 1,
  retryDelayMs: 1,
  retryMaxDelayMs: 10,
  startupRetryAttempts: 1,
};

const enabledFeatures = { realtimeEnabled: true } as FeaturesConfig;

describe("RealtimeRedisAdapterService readiness", () => {
  it("probes the publisher while requiring both adapter clients to be ready", async () => {
    const service = new RealtimeRedisAdapterService(redisConfig, enabledFeatures);
    const publisher = { ping: vi.fn().mockResolvedValue("PONG"), status: "ready" };
    const subscriber = { ping: vi.fn(), status: "ready" };
    Object.assign(service as unknown as { publisher: unknown; subscriber: unknown }, {
      publisher,
      subscriber,
    });

    await expect(service.check()).resolves.toEqual({ name: "realtime", status: "up" });
    expect(publisher.ping).toHaveBeenCalledOnce();
    expect(subscriber.ping).not.toHaveBeenCalled();
  });

  it("reports down when either adapter connection is unavailable", async () => {
    const service = new RealtimeRedisAdapterService(redisConfig, enabledFeatures);
    Object.assign(service as unknown as { publisher: unknown; subscriber: unknown }, {
      publisher: { ping: vi.fn().mockResolvedValue("PONG"), status: "ready" },
      subscriber: { status: "reconnecting" },
    });

    await expect(service.check()).resolves.toEqual({
      name: "realtime",
      status: "down",
      message: "Realtime adapter unavailable",
    });
  });
});
