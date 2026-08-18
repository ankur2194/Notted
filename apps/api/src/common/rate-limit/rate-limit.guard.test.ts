import { type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";

import { parseAppConfig } from "../../config/app.config";

import { RATE_LIMIT_TIER } from "./rate-limit.decorator";
import { RateLimitGuard } from "./rate-limit.guard";
import { RateLimitService } from "./rate-limit.service";
import { setTrustedPrincipal } from "./trusted-principal";

import type { RateLimitDecision, RateLimitStore, TokenBucketPolicy } from "./rate-limit.types";
import type { Request, Response } from "express";

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

function createContext(request: Request, response: Response): ExecutionContext {
  return {
    getClass: () => class TestController {},
    getHandler: () => function testHandler() {},
    switchToHttp: () => ({
      getRequest: <T = Request>() => request as T,
      getResponse: <T = Response>() => response as T,
      getNext: <T = unknown>() => undefined as T,
    }),
  } as unknown as ExecutionContext;
}

function createResponse(): Response {
  return {
    setHeader: vi.fn(),
  } as unknown as Response;
}

describe("RateLimitGuard", () => {
  it("uses the unauthenticated tier even when credential-like headers are present", () => {
    const config = parseAppConfig({
      RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE: "10",
      RATE_LIMIT_AUTHENTICATED_PER_MINUTE: "200",
    });
    const store = new CapturingStore();
    const guard = new RateLimitGuard(new Reflector(), new RateLimitService(config, store));
    const request = {
      headers: {
        authorization: "Bearer untrusted",
        cookie: "session=untrusted",
      },
      ip: "192.0.2.10",
      socket: {},
    } as unknown as Request;

    expect(guard.canActivate(createContext(request, createResponse()))).toBe(true);
    expect(store.lastKey).toBe("ip:192.0.2.10");
    expect(store.lastPolicy?.capacity).toBe(10);
  });

  it("uses the liberal tier only after an internal adapter sets a trusted principal", () => {
    const config = parseAppConfig({
      RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE: "10",
      RATE_LIMIT_AUTHENTICATED_PER_MINUTE: "200",
    });
    const store = new CapturingStore();
    const guard = new RateLimitGuard(new Reflector(), new RateLimitService(config, store));
    const request = {
      headers: {},
      ip: "192.0.2.10",
      socket: {},
    } as unknown as Request;

    setTrustedPrincipal(request, { actorId: "user-safe-id", kind: "user" });

    expect(guard.canActivate(createContext(request, createResponse()))).toBe(true);
    expect(store.lastKey).toBe("actor:user:user-safe-id");
    expect(store.lastPolicy?.capacity).toBe(200);
  });

  it("selects the api-key tier from an api-key trusted principal", () => {
    const config = parseAppConfig({
      RATE_LIMIT_AUTHENTICATED_PER_MINUTE: "1000",
      RATE_LIMIT_API_KEY_PER_MINUTE: "100",
    });
    const store = new CapturingStore();
    const guard = new RateLimitGuard(new Reflector(), new RateLimitService(config, store));
    const request = { headers: {}, ip: "192.0.2.10", socket: {} } as unknown as Request;

    setTrustedPrincipal(request, { actorId: "key-safe-id", kind: "api-key" });

    expect(guard.canActivate(createContext(request, createResponse()))).toBe(true);
    expect(store.lastKey).toBe("actor:api-key:key-safe-id");
    // The moderate machine tier, not the generous browser-session tier.
    expect(store.lastPolicy?.capacity).toBe(100);
  });

  it("applies the sensitive tier and its own bucket when the route declares it", () => {
    const config = parseAppConfig({
      RATE_LIMIT_AUTHENTICATED_PER_MINUTE: "1000",
      RATE_LIMIT_SENSITIVE_PER_MINUTE: "5",
    });
    const store = new CapturingStore();
    // The decorator only stores metadata; what matters here is that the guard
    // reads the RATE_LIMIT_TIER key over [handler, class] and forwards it.
    const reflector = {
      getAllAndOverride: (key: symbol) => (key === RATE_LIMIT_TIER ? "sensitive" : undefined),
    } as unknown as Reflector;
    const guard = new RateLimitGuard(reflector, new RateLimitService(config, store));
    const request = { headers: {}, ip: "192.0.2.10", socket: {} } as unknown as Request;
    setTrustedPrincipal(request, { actorId: "user-safe-id", kind: "user" });

    expect(guard.canActivate(createContext(request, createResponse()))).toBe(true);
    expect(store.lastKey).toBe("actor:user:user-safe-id:sensitive");
    expect(store.lastPolicy?.capacity).toBe(5);
  });

  it("exposes safe 429 headers through the transport-neutral service", () => {
    const config = parseAppConfig({ RATE_LIMIT_AUTHENTICATED_PER_MINUTE: "200" });
    const service = new RateLimitService(config, new DenyingStore());
    const request = { ip: "192.0.2.10", socket: {} } as unknown as Request;
    const response = createResponse();

    expect(() => service.enforce(request, response)).toThrow("Too many requests");
    expect(response.setHeader).toHaveBeenCalledWith("Retry-After", 2);
  });
});
