import { Inject, Injectable } from "@nestjs/common";

import {
  QUEUE_CONFIG,
  type AiProviderQueueLimitConfig,
  type QueueConfig,
} from "../config/queue.config";
import { REDIS_CLIENT } from "../infrastructure/redis/redis.tokens";

import type Redis from "ioredis";

export type AiRateLimitedProvider = "claude" | "openai";

export type AiRateLimitResult =
  | { readonly allowed: true; readonly remaining: number }
  | {
      readonly allowed: false;
      readonly reason:
        "configuration_invalid" | "provider_unsupported" | "rate_limited" | "unavailable";
      readonly retryAfterMs: number;
    };

type ResolvedProviderLimit = {
  readonly key: string;
  readonly limit: AiProviderQueueLimitConfig;
};

const LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;
const UNAVAILABLE_RETRY_MS = 1_000;

/**
 * Concrete AI queue handlers call `acquire(provider)` immediately before a
 * provider request. A denied result is retryable by the shared queue runtime;
 * this service never performs provider work or stores tenant/content identity.
 */
@Injectable()
export class AiProviderRateLimiterService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    @Inject(QUEUE_CONFIG) private readonly config: QueueConfig,
  ) {}

  async acquire(provider: string): Promise<AiRateLimitResult> {
    let resolved: ResolvedProviderLimit | undefined;
    try {
      resolved = this.resolveProvider(provider);
    } catch {
      return {
        allowed: false,
        reason: "configuration_invalid",
        retryAfterMs: UNAVAILABLE_RETRY_MS,
      };
    }
    if (resolved === undefined) {
      return { allowed: false, reason: "provider_unsupported", retryAfterMs: UNAVAILABLE_RETRY_MS };
    }
    const { key, limit } = resolved;
    if (!this.validLimit(limit)) {
      return {
        allowed: false,
        reason: "configuration_invalid",
        retryAfterMs: UNAVAILABLE_RETRY_MS,
      };
    }
    if (this.redis === null) {
      return { allowed: false, reason: "unavailable", retryAfterMs: UNAVAILABLE_RETRY_MS };
    }

    try {
      const raw: unknown = await this.redis.eval(LIMIT_SCRIPT, 1, key, String(limit.durationMs));
      const parsed = this.parseAtomicResult(raw, limit.durationMs);
      if (parsed === undefined) {
        return { allowed: false, reason: "unavailable", retryAfterMs: UNAVAILABLE_RETRY_MS };
      }
      if (parsed.count <= limit.maximum) {
        return { allowed: true, remaining: Math.max(0, limit.maximum - parsed.count) };
      }
      return { allowed: false, reason: "rate_limited", retryAfterMs: parsed.ttlMs };
    } catch {
      return { allowed: false, reason: "unavailable", retryAfterMs: UNAVAILABLE_RETRY_MS };
    }
  }

  private resolveProvider(provider: string): ResolvedProviderLimit | undefined {
    if (provider === "openai") {
      return { key: "notted:queue:ai-limit:v1:openai", limit: this.config.aiProviderLimits.openAi };
    }
    if (provider === "claude") {
      return { key: "notted:queue:ai-limit:v1:claude", limit: this.config.aiProviderLimits.claude };
    }
    return undefined;
  }

  private validLimit(limit: unknown): limit is AiProviderQueueLimitConfig {
    if (typeof limit !== "object" || limit === null) return false;
    const candidate = limit as { readonly maximum?: unknown; readonly durationMs?: unknown };
    return (
      Number.isInteger(candidate.maximum) &&
      (candidate.maximum as number) > 0 &&
      Number.isInteger(candidate.durationMs) &&
      (candidate.durationMs as number) >= 100 &&
      (candidate.durationMs as number) <= 60_000
    );
  }

  private parseAtomicResult(
    value: unknown,
    maximumTtlMs: number,
  ): { readonly count: number; readonly ttlMs: number } | undefined {
    if (!Array.isArray(value) || value.length !== 2) return undefined;
    const count = Number(value[0]);
    const ttl = Number(value[1]);
    if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(ttl)) return undefined;
    return {
      count,
      ttlMs: Math.max(1, Math.min(maximumTtlMs, Math.ceil(ttl))),
    };
  }
}
