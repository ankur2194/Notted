import { describe, expect, it, vi } from "vitest";

import { AiProviderRateLimiterService } from "./ai-provider-rate-limiter.service";

import type { QueueConfig } from "../config/queue.config";
import type Redis from "ioredis";

const config = {
  aiProviderLimits: {
    openAi: { maximum: 2, durationMs: 1_000 },
    claude: { maximum: 1, durationMs: 2_000 },
  },
} as QueueConfig;

describe("AiProviderRateLimiterService", () => {
  it("uses separate bounded keys and limits for OpenAI and Claude", async () => {
    const evalCommand = vi.fn().mockResolvedValue([1, 900]);
    const limiter = new AiProviderRateLimiterService(
      { eval: evalCommand } as unknown as Redis,
      config,
    );

    await limiter.acquire("openai");
    await limiter.acquire("claude");

    expect(evalCommand.mock.calls[0]?.slice(1)).toEqual([
      1,
      "notted:queue:ai-limit:v1:openai",
      "1000",
    ]);
    expect(evalCommand.mock.calls[1]?.slice(1)).toEqual([
      1,
      "notted:queue:ai-limit:v1:claude",
      "2000",
    ]);
    expect(evalCommand.mock.calls[0]?.[0]).toContain("redis.call('INCR', KEYS[1])");
  });

  it("returns atomic concurrent outcomes without a process-local counter", async () => {
    const evalCommand = vi
      .fn()
      .mockResolvedValueOnce([1, 1_000])
      .mockResolvedValueOnce([2, 999])
      .mockResolvedValueOnce([3, 998]);
    const limiter = new AiProviderRateLimiterService(
      { eval: evalCommand } as unknown as Redis,
      config,
    );

    await expect(
      Promise.all([
        limiter.acquire("openai"),
        limiter.acquire("openai"),
        limiter.acquire("openai"),
      ]),
    ).resolves.toEqual([
      { allowed: true, remaining: 1 },
      { allowed: true, remaining: 0 },
      { allowed: false, reason: "rate_limited", retryAfterMs: 998 },
    ]);
  });

  it("bounds retry-after to the configured provider window", async () => {
    const limiter = new AiProviderRateLimiterService(
      { eval: vi.fn().mockResolvedValue([3, 99_999]) } as unknown as Redis,
      config,
    );
    await expect(limiter.acquire("openai")).resolves.toEqual({
      allowed: false,
      reason: "rate_limited",
      retryAfterMs: 1_000,
    });
  });

  it("fails closed for disabled Redis, unknown providers, invalid config, and Redis failures", async () => {
    await expect(
      new AiProviderRateLimiterService(null, config).acquire("openai"),
    ).resolves.toMatchObject({ allowed: false, reason: "unavailable" });
    await expect(
      new AiProviderRateLimiterService(null, config).acquire("other"),
    ).resolves.toMatchObject({ allowed: false, reason: "provider_unsupported" });
    await expect(
      new AiProviderRateLimiterService(null, {
        ...config,
        aiProviderLimits: { ...config.aiProviderLimits, openAi: { maximum: 0, durationMs: 1_000 } },
      }).acquire("openai"),
    ).resolves.toMatchObject({ allowed: false, reason: "configuration_invalid" });
    await expect(
      new AiProviderRateLimiterService(
        { eval: vi.fn().mockRejectedValue(new Error("redis-url-secret")) } as unknown as Redis,
        config,
      ).acquire("claude"),
    ).resolves.toMatchObject({ allowed: false, reason: "unavailable" });
  });
});
