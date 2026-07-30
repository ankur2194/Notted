import { describe, expect, it, vi } from "vitest";

import { RedisService } from "../infrastructure/redis/redis.service";

import { BetterAuthRedisStorage } from "./better-auth-redis.storage";

function redisDouble() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    getAndDelete: vi.fn().mockResolvedValue("single-use"),
    incrementWithTtl: vi.fn().mockResolvedValue(1),
  };
}

describe("BetterAuthRedisStorage", () => {
  it("converts Better Auth seconds to Redis milliseconds exactly", async () => {
    const redis = redisDouble();
    const storage = new BetterAuthRedisStorage(redis as unknown as RedisService);
    await storage.set("session", "value", 24);
    expect(redis.set).toHaveBeenCalledWith("notted:better-auth:session", "value", 24_000);
    await storage.increment("rate", 60);
    expect(redis.incrementWithTtl).toHaveBeenCalledWith("notted:better-auth:rate", 60_000);
  });

  it("uses atomic consume and revocation operations", async () => {
    const redis = redisDouble();
    const storage = new BetterAuthRedisStorage(redis as unknown as RedisService);
    await expect(storage.getAndDelete("verification")).resolves.toBe("single-use");
    await storage.delete("session");
    expect(redis.getAndDelete).toHaveBeenCalledWith("notted:better-auth:verification");
    expect(redis.delete).toHaveBeenCalledWith("notted:better-auth:session");
  });

  it("fails closed when Redis rejects a session lookup", async () => {
    const redis = redisDouble();
    redis.get.mockRejectedValueOnce(new Error("offline"));
    const storage = new BetterAuthRedisStorage(redis as unknown as RedisService);
    await expect(storage.get("session")).rejects.toThrow("offline");
  });
});
