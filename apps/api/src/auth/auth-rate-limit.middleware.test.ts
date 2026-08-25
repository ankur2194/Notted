import { describe, expect, it, vi } from "vitest";

import { parseAppConfig } from "../config/app.config";

import { AuthRateLimitMiddleware } from "./auth-rate-limit.middleware";

import type {
  RateLimitDecision,
  RateLimitStore,
  TokenBucketPolicy,
} from "../common/rate-limit/rate-limit.types";
import type { NextFunction, Request, Response } from "express";

class CapturingStore implements RateLimitStore {
  lastKey: string | undefined;
  lastPolicy: TokenBucketPolicy | undefined;

  consume(key: string, policy: TokenBucketPolicy): RateLimitDecision {
    this.lastKey = key;
    this.lastPolicy = policy;
    return {
      allowed: true,
      remaining: policy.capacity - 1,
      retryAfterMilliseconds: 0,
      resetAfterMilliseconds: 1_000,
    };
  }
}

class DenyingStore implements RateLimitStore {
  consume(): RateLimitDecision {
    return {
      allowed: false,
      remaining: 0,
      retryAfterMilliseconds: 2_000,
      resetAfterMilliseconds: 2_000,
    };
  }
}

interface FakeResponse {
  readonly response: Response;
  readonly status: ReturnType<typeof vi.fn>;
  readonly json: ReturnType<typeof vi.fn>;
  readonly setHeader: ReturnType<typeof vi.fn>;
}

function fakeResponse(): FakeResponse {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const setHeader = vi.fn();
  const response = { status, json, setHeader } as unknown as Response;
  return { response, status, json, setHeader };
}

function fakeRequest(method: string, ip = "203.0.113.9"): Request {
  return { method, ip, socket: {} } as unknown as Request;
}

describe("AuthRateLimitMiddleware", () => {
  it("skips non-POST requests without consuming the bucket", () => {
    const config = parseAppConfig({ RATE_LIMIT_AUTH_PER_MINUTE: "7" });
    const store = new CapturingStore();
    const middleware = new AuthRateLimitMiddleware(config, store);
    const { response } = fakeResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware.use(fakeRequest("GET"), response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(store.lastKey).toBeUndefined();
  });

  it("consumes the authentication tier's own :auth bucket keyed by the client IP", () => {
    const config = parseAppConfig({ RATE_LIMIT_AUTH_PER_MINUTE: "7" });
    const store = new CapturingStore();
    const middleware = new AuthRateLimitMiddleware(config, store);
    const { response } = fakeResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware.use(fakeRequest("POST", "203.0.113.9"), response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(store.lastKey).toBe("auth-ip:203.0.113.9:auth");
    // Proves the AUTH tier is used, not the generic sensitive tier: the
    // configured value (7) flows straight through as the bucket capacity.
    expect(config.authRateLimitPerMinute).toBe(7);
    expect(store.lastPolicy?.capacity).toBe(7);
  });

  it("returns 429 with the rate-limit envelope and headers when the store denies", () => {
    const config = parseAppConfig({ RATE_LIMIT_AUTH_PER_MINUTE: "5" });
    const middleware = new AuthRateLimitMiddleware(config, new DenyingStore());
    const { response, status, json, setHeader } = fakeResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware.use(fakeRequest("POST"), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "RATE_LIMITED" }),
      }),
    );
    expect(setHeader).toHaveBeenCalledWith("Retry-After", 2);
    expect(setHeader).toHaveBeenCalledWith("RateLimit-Limit", 5);
    expect(setHeader).toHaveBeenCalledWith("RateLimit-Remaining", 0);
    expect(setHeader).toHaveBeenCalledWith("RateLimit-Reset", 2);
  });
});
