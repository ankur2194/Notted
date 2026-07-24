import { Injectable, Optional } from "@nestjs/common";

import type { RateLimitDecision, RateLimitStore, TokenBucketPolicy } from "./rate-limit.types";

interface Bucket {
  tokens: number;
  updatedAt: number;
  lastSeenAt: number;
}

export interface InMemoryRateLimitStoreOptions {
  readonly maximumEntries?: number;
  readonly inactiveEntryTtlMilliseconds?: number;
  readonly pruneEveryOperations?: number;
}

const DEFAULT_MAXIMUM_ENTRIES = 50_000;
const DEFAULT_INACTIVE_TTL_MILLISECONDS = 10 * 60 * 1_000;
const DEFAULT_PRUNE_EVERY_OPERATIONS = 256;

@Injectable()
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maximumEntries: number;
  private readonly inactiveEntryTtlMilliseconds: number;
  private readonly pruneEveryOperations: number;
  private operationCount = 0;

  constructor(@Optional() options: InMemoryRateLimitStoreOptions = {}) {
    this.maximumEntries = options.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES;
    this.inactiveEntryTtlMilliseconds =
      options.inactiveEntryTtlMilliseconds ?? DEFAULT_INACTIVE_TTL_MILLISECONDS;
    this.pruneEveryOperations = options.pruneEveryOperations ?? DEFAULT_PRUNE_EVERY_OPERATIONS;
  }

  consume(key: string, policy: TokenBucketPolicy, now = Date.now()): RateLimitDecision {
    this.operationCount += 1;
    if (this.operationCount % this.pruneEveryOperations === 0) {
      this.prune(now);
    }

    const existing = this.buckets.get(key);
    const elapsed = existing === undefined ? 0 : Math.max(0, now - existing.updatedAt);
    const availableTokens =
      existing === undefined
        ? policy.capacity
        : Math.min(policy.capacity, existing.tokens + elapsed * policy.refillTokensPerMillisecond);
    const allowed = availableTokens >= 1;
    const tokens = allowed ? availableTokens - 1 : availableTokens;

    if (existing !== undefined) {
      this.buckets.delete(key);
    } else if (this.buckets.size >= this.maximumEntries) {
      this.evictOldest();
    }

    this.buckets.set(key, {
      tokens,
      updatedAt: now,
      lastSeenAt: now,
    });

    const tokensUntilNext = allowed ? 0 : Math.max(0, 1 - tokens);
    const retryAfterMilliseconds =
      tokensUntilNext === 0 ? 0 : Math.ceil(tokensUntilNext / policy.refillTokensPerMillisecond);
    const resetAfterMilliseconds = Math.ceil(
      Math.max(0, policy.capacity - tokens) / policy.refillTokensPerMillisecond,
    );

    return {
      allowed,
      remaining: Math.floor(tokens),
      retryAfterMilliseconds,
      resetAfterMilliseconds,
    };
  }

  get size(): number {
    return this.buckets.size;
  }

  private prune(now: number): void {
    const staleBefore = now - this.inactiveEntryTtlMilliseconds;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastSeenAt > staleBefore) {
        break;
      }
      this.buckets.delete(key);
    }
  }

  private evictOldest(): void {
    const oldestKey = this.buckets.keys().next().value as string | undefined;
    if (oldestKey !== undefined) {
      this.buckets.delete(oldestKey);
    }
  }
}
