import { describe, expect, it, vi } from "vitest";

import { setApiKeyActor } from "../api-keys/api-key-context";
import { parseAuthConfig } from "../config/auth.config";
import { parseRetentionConfig } from "../config/retention.config";

import { AuthService } from "./auth.service";
import { CsrfOriginMiddleware } from "./csrf-origin.middleware";

import type { VerifiedHostsService } from "../common/verified-hosts.service";
import type { NextFunction, Request, Response } from "express";

function buildMiddleware(): CsrfOriginMiddleware {
  const authService = new AuthService(
    {} as never,
    parseAuthConfig({ BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3000" }),
    parseRetentionConfig({}),
    // Trusts nothing beyond the configured static origin, so every case here
    // exercises the static-list check only.
    { isTrustedOriginSync: () => false } as unknown as VerifiedHostsService,
  );
  return new CsrfOriginMiddleware(authService);
}

function fakeRequest(options: { method: string; cookie?: string; origin?: string }): Request {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.origin !== undefined) headers.origin = options.origin;
  return {
    method: options.method,
    headers,
    header: (name: string): string | undefined => headers[name.toLowerCase()],
    socket: {},
  } as unknown as Request;
}

interface FakeResponse {
  readonly response: Response;
  readonly status: ReturnType<typeof vi.fn>;
  readonly json: ReturnType<typeof vi.fn>;
}

function fakeResponse(): FakeResponse {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const response = { status, json } as unknown as Response;
  return { response, status, json };
}

describe("CsrfOriginMiddleware", () => {
  it("skips non-mutating methods even with a hostile Origin", () => {
    const middleware = buildMiddleware();
    const request = fakeRequest({
      method: "GET",
      cookie: "better-auth.session_token=x",
      origin: "https://attacker.invalid",
    });
    const { response, status } = fakeResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware.use(request, response, next);

    // GET/HEAD/OPTIONS carry no side effects to forge, so the origin is
    // never even inspected.
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it("skips a mutating request with no ambient session cookie", () => {
    const middleware = buildMiddleware();
    const request = fakeRequest({ method: "POST", origin: "https://attacker.invalid" });
    const { response, status } = fakeResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware.use(request, response, next);

    // Nothing for a cross-site page to ride on; rejecting it would break
    // anonymous public mutations.
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it("allows a cookie-authenticated mutation from a trusted origin", () => {
    const middleware = buildMiddleware();
    const request = fakeRequest({
      method: "POST",
      cookie: "better-auth.session_token=x",
      origin: "http://localhost:3000",
    });
    const { response, status } = fakeResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware.use(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it("blocks a cookie-authenticated mutation from a hostile origin", () => {
    const middleware = buildMiddleware();
    const request = fakeRequest({
      method: "POST",
      cookie: "better-auth.session_token=x",
      origin: "https://attacker.invalid",
    });
    const { response, status, json } = fakeResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware.use(request, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "CSRF_ORIGIN_INVALID" }),
      }),
    );
  });

  it("blocks a cookie-authenticated mutation with no Origin header at all", () => {
    const middleware = buildMiddleware();
    const request = fakeRequest({ method: "POST", cookie: "better-auth.session_token=x" });
    const { response, status } = fakeResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware.use(request, response, next);

    // A missing Origin is treated the same as an untrusted one, never as
    // an implicit pass.
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it("matches the __Secure- prefixed production cookie spelling", () => {
    const middleware = buildMiddleware();
    const request = fakeRequest({
      method: "POST",
      cookie: "__Secure-better-auth.session_token=x",
      origin: "https://attacker.invalid",
    });
    const { response, status } = fakeResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware.use(request, response, next);

    // Proves the substring match on "session_token" survives the
    // secure-cookie prefix switch used in production.
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it("skips an API-key actor even with a hostile origin, since integrations send no Origin", () => {
    const middleware = buildMiddleware();
    const request = fakeRequest({
      method: "POST",
      cookie: "better-auth.session_token=x",
      origin: "https://attacker.invalid",
    });
    setApiKeyActor(request, {
      kind: "api-key",
      apiKeyId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      scopes: ["read"],
    });
    const { response, status } = fakeResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware.use(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });
});
