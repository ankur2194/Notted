import { describe, expect, it, vi } from "vitest";

import { RealtimeRateLimitService } from "./realtime-rate-limit.service";

describe("RealtimeRateLimitService", () => {
  it("uses keyed opaque Redis identifiers", async () => {
    const incrementWithTtl = vi.fn().mockResolvedValue(1);
    const service = new RealtimeRateLimitService(
      { incrementWithTtl } as never,
      { secret: "a sufficiently long test secret" } as never,
    );
    await expect(service.allow("principal", "user\0session-sensitive", 2)).resolves.toBe(true);
    const key = incrementWithTtl.mock.calls[0]?.[0] as string;
    expect(key).not.toContain("user");
    expect(key).not.toContain("session-sensitive");
  });

  it("acquires and releases opaque distributed socket leases", async () => {
    const acquireBoundedLease = vi.fn().mockResolvedValue(true);
    const releaseLease = vi.fn().mockResolvedValue(undefined);
    const service = new RealtimeRateLimitService(
      { acquireBoundedLease, releaseLease } as never,
      { secret: "a sufficiently long test secret" } as never,
    );

    await expect(service.acquireSocketLease("actor", "socket", 2, 5_000)).resolves.toBe(true);
    await service.releaseSocketLease("actor", "socket");

    const [key, member, limit, ttl] = acquireBoundedLease.mock.calls[0] as [
      string,
      string,
      number,
      number,
    ];
    expect(key).not.toContain("actor");
    expect(member).not.toContain("socket");
    expect([limit, ttl]).toEqual([2, 5_000]);
    expect(releaseLease).toHaveBeenCalledWith(key, member);
  });
});
