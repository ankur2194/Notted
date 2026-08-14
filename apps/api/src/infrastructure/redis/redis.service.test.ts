import { describe, expect, it, vi } from "vitest";

import { RedisService } from "./redis.service";

describe("RedisService bounded leases", () => {
  it("uses one atomic script to prune, count, acquire, refresh, and expire leases", async () => {
    const evalCommand = vi.fn().mockResolvedValue(1);
    const client = {
      on: vi.fn(),
      eval: evalCommand,
      zrem: vi.fn().mockResolvedValue(1),
    };
    const service = new RedisService(
      { enabled: true } as never,
      client as never,
      { info: vi.fn(), failure: vi.fn() } as never,
    );

    await expect(
      service.acquireBoundedLease("opaque-key", "opaque-member", 8, 5_000),
    ).resolves.toBe(true);
    const script = evalCommand.mock.calls[0]?.[0] as string;
    expect(script).toContain("ZREMRANGEBYSCORE");
    expect(script).toContain("ZCARD");
    expect(script).toContain("ZADD");
    expect(script).toContain("PEXPIRE");
    expect(evalCommand.mock.calls[0]?.slice(1, 4)).toEqual([1, "opaque-key", expect.any(String)]);

    await service.releaseLease("opaque-key", "opaque-member");
    expect(client.zrem).toHaveBeenCalledWith("opaque-key", "opaque-member");
  });

  it("rejects a lease when Redis reports the distributed cap", async () => {
    const client = { on: vi.fn(), eval: vi.fn().mockResolvedValue(0) };
    const service = new RedisService(
      { enabled: true } as never,
      client as never,
      { info: vi.fn(), failure: vi.fn() } as never,
    );
    await expect(service.acquireBoundedLease("key", "member", 1, 5_000)).resolves.toBe(false);
  });
});
