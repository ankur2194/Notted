import { describe, expect, it, vi } from "vitest";

import { parseAppConfig } from "../../config/app.config";

import { InMemoryRateLimitStore } from "./in-memory-rate-limit.store";
import { RateLimitService } from "./rate-limit.service";
import { setTrustedPrincipal, type TrustedPrincipal } from "./trusted-principal";

import type { Request, Response } from "express";

/**
 * Part 65 — the three tiers must block INDEPENDENTLY at their own configured
 * threshold. The bucket keys are disjoint by construction, so what these tests
 * defend is that nobody later collapses them into one namespace: a shared
 * bucket would let one noisy integration key lock out every browser session on
 * the same deployment.
 *
 * A real `InMemoryRateLimitStore` is used rather than a double, because
 * "draining one tier does not drain another" is a statement about the store's
 * keying, not about the service's arithmetic.
 */

const LIMITS = {
  RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE: "2",
  RATE_LIMIT_AUTHENTICATED_PER_MINUTE: "4",
  RATE_LIMIT_API_KEY_PER_MINUTE: "3",
  RATE_LIMIT_SENSITIVE_PER_MINUTE: "1",
} as const;

function createService(): RateLimitService {
  return new RateLimitService(parseAppConfig({ ...LIMITS }), new InMemoryRateLimitStore());
}

function createResponse(): Response {
  const headers = new Map<string, number | string>();
  return {
    setHeader: vi.fn((name: string, value: number | string) => headers.set(name, value)),
    getHeader: (name: string) => headers.get(name),
  } as unknown as Response;
}

function createRequest(principal?: TrustedPrincipal): Request {
  const request = {
    headers: {},
    ip: "198.51.100.7",
    socket: {},
  } as unknown as Request;
  if (principal !== undefined) setTrustedPrincipal(request, principal);
  return request;
}

const USER: TrustedPrincipal = { actorId: "user-1", kind: "user" };
const API_KEY: TrustedPrincipal = { actorId: "key-1", kind: "api-key" };

/** Consumes `count` requests, returning the status of the last one. */
function drain(service: RateLimitService, principal: TrustedPrincipal | undefined, count: number) {
  let limited = false;
  for (let index = 0; index < count; index += 1) {
    try {
      service.enforce(createRequest(principal), createResponse());
    } catch {
      limited = true;
    }
  }
  return limited;
}

function allows(service: RateLimitService, principal: TrustedPrincipal | undefined): boolean {
  try {
    service.enforce(createRequest(principal), createResponse());
    return true;
  } catch {
    return false;
  }
}

describe("RateLimitService tier selection", () => {
  it("reads each tier's limit from its own configuration field", () => {
    const service = createService();
    const cases = [
      [undefined, 2],
      [USER, 4],
      [API_KEY, 3],
    ] as const;

    for (const [principal, expected] of cases) {
      const response = createResponse();
      service.enforce(createRequest(principal), response);
      expect(response.setHeader).toHaveBeenCalledWith("RateLimit-Limit", expected);
    }
  });

  it("routes each tier to its own bucket key", () => {
    const keys: string[] = [];
    const store = {
      consume: (key: string) => {
        keys.push(key);
        return {
          allowed: true,
          remaining: 1,
          retryAfterMilliseconds: 0,
          resetAfterMilliseconds: 1_000,
        };
      },
    };
    const service = new RateLimitService(parseAppConfig({ ...LIMITS }), store);

    service.enforce(createRequest(), createResponse());
    service.enforce(createRequest(USER), createResponse());
    service.enforce(createRequest(API_KEY), createResponse());
    service.enforce(createRequest(USER), createResponse(), "sensitive");

    expect(keys).toEqual([
      "ip:198.51.100.7",
      "actor:user:user-1",
      "actor:api-key:key-1",
      "actor:user:user-1:sensitive",
    ]);
  });

  it("exposes the standard limit headers on an allowed request", () => {
    const service = createService();
    const response = createResponse();

    service.enforce(createRequest(API_KEY), response);

    expect(response.setHeader).toHaveBeenCalledWith("RateLimit-Limit", 3);
    expect(response.setHeader).toHaveBeenCalledWith("RateLimit-Remaining", expect.any(Number));
    expect(response.setHeader).toHaveBeenCalledWith("RateLimit-Reset", expect.any(Number));
  });

  it("adds Retry-After and a 429 once a tier is exhausted", () => {
    const service = createService();
    expect(drain(service, API_KEY, 3)).toBe(false);

    const response = createResponse();
    expect(() => service.enforce(createRequest(API_KEY), response)).toThrowError(
      "Too many requests",
    );
    expect(response.setHeader).toHaveBeenCalledWith("Retry-After", expect.any(Number));
  });
});

describe("RateLimitService tier independence", () => {
  it("draining the api-key tier leaves the user and IP tiers usable", () => {
    const service = createService();

    expect(drain(service, API_KEY, 4)).toBe(true);

    expect(allows(service, API_KEY)).toBe(false);
    expect(allows(service, USER)).toBe(true);
    expect(allows(service, undefined)).toBe(true);
  });

  it("draining the user tier leaves the api-key and IP tiers usable", () => {
    const service = createService();

    expect(drain(service, USER, 5)).toBe(true);

    expect(allows(service, USER)).toBe(false);
    expect(allows(service, API_KEY)).toBe(true);
    expect(allows(service, undefined)).toBe(true);
  });

  it("draining the IP tier leaves the user and api-key tiers usable", () => {
    const service = createService();

    expect(drain(service, undefined, 3)).toBe(true);

    expect(allows(service, undefined)).toBe(false);
    expect(allows(service, USER)).toBe(true);
    expect(allows(service, API_KEY)).toBe(true);
  });

  it("keys of the same kind do not share a bucket", () => {
    const service = createService();

    expect(drain(service, API_KEY, 4)).toBe(true);

    expect(allows(service, { actorId: "key-2", kind: "api-key" })).toBe(true);
  });
});

describe("RateLimitService sensitive override", () => {
  it("uses the sensitive limit rather than the caller's tier limit", () => {
    const service = createService();
    const response = createResponse();

    service.enforce(createRequest(USER), response, "sensitive");

    expect(response.setHeader).toHaveBeenCalledWith("RateLimit-Limit", 1);
  });

  it("does not drain the caller's general bucket, and is not drained by it", () => {
    const service = createService();

    // One sensitive request exhausts the sensitive bucket (limit 1)...
    service.enforce(createRequest(USER), createResponse(), "sensitive");
    expect(() => service.enforce(createRequest(USER), createResponse(), "sensitive")).toThrowError(
      "Too many requests",
    );

    // ...while the same actor's general allowance (limit 4) is untouched.
    expect(drain(service, USER, 4)).toBe(false);
    expect(allows(service, USER)).toBe(false);
  });
});
