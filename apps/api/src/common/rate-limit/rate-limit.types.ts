export const RATE_LIMIT_STORE = Symbol("RATE_LIMIT_STORE");

export interface TokenBucketPolicy {
  readonly capacity: number;
  readonly refillTokensPerMillisecond: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMilliseconds: number;
  readonly resetAfterMilliseconds: number;
}

export interface RateLimitStore {
  consume(key: string, policy: TokenBucketPolicy, now?: number): RateLimitDecision;
}
