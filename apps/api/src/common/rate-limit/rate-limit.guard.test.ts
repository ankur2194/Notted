import { type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";

import { parseAppConfig } from "../../config/app.config";

import { RateLimitGuard } from "./rate-limit.guard";
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
    const guard = new RateLimitGuard(new Reflector(), config, store);
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
    const guard = new RateLimitGuard(new Reflector(), config, store);
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
});
