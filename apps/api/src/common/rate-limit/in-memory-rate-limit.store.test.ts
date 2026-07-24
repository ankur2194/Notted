import { describe, expect, it } from "vitest";

import { InMemoryRateLimitStore } from "./in-memory-rate-limit.store";

const policy = {
  capacity: 2,
  refillTokensPerMillisecond: 1 / 1_000,
};

describe("InMemoryRateLimitStore", () => {
  it("spends capacity, rejects excess traffic, and refills over time", () => {
    const store = new InMemoryRateLimitStore();

    expect(store.consume("ip:one", policy, 0)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(store.consume("ip:one", policy, 0)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(store.consume("ip:one", policy, 0)).toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterMilliseconds: 1_000,
    });
    expect(store.consume("ip:one", policy, 1_000)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
  });

  it("bounds cardinality by evicting the least recently seen bucket", () => {
    const store = new InMemoryRateLimitStore({
      maximumEntries: 2,
      pruneEveryOperations: 1_000,
    });

    store.consume("ip:one", policy, 0);
    store.consume("ip:two", policy, 1);
    store.consume("ip:three", policy, 2);

    expect(store.size).toBe(2);
    expect(store.consume("ip:one", policy, 3).remaining).toBe(1);
  });

  it("prunes inactive buckets", () => {
    const store = new InMemoryRateLimitStore({
      inactiveEntryTtlMilliseconds: 10,
      maximumEntries: 10,
      pruneEveryOperations: 1,
    });

    store.consume("ip:one", policy, 0);
    store.consume("ip:two", policy, 1);
    store.consume("ip:three", policy, 20);

    expect(store.size).toBe(1);
  });
});
