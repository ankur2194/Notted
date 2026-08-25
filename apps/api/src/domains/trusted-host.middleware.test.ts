import { describe, expect, it, vi } from "vitest";

import { parseAppConfig } from "../config/app.config";

import { isHostCheckExempt, TrustedHostMiddleware } from "./trusted-host.middleware";

import type { VerifiedHostsService } from "../common/verified-hosts.service";
import type { NextFunction, Request, Response } from "express";

function harness(options: { readonly enabled: boolean; readonly trusted: boolean }) {
  const isTrustedHost = vi.fn(async () => options.trusted);
  const middleware = new TrustedHostMiddleware(
    { isTrustedHost } as unknown as VerifiedHostsService,
    parseAppConfig(options.enabled ? { CUSTOM_DOMAINS_ENABLED: "true" } : {}),
  );
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const response = { status, json, getHeader: () => "req-1" } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { middleware, isTrustedHost, status, json, response, next };
}

function request(hostname: string, path = "/api/v1/notes"): Request {
  return { hostname, path } as unknown as Request;
}

/** `use` resolves its promise on a microtask; let it settle before asserting. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("isHostCheckExempt", () => {
  it("exempts the readiness and liveness probes only", () => {
    expect(isHostCheckExempt("/health/live")).toBe(true);
    expect(isHostCheckExempt("/health/ready")).toBe(true);
    expect(isHostCheckExempt("/api/v1/notes")).toBe(false);
    // Not a prefix match on the bare word: `/healthcheck` is somebody else's route.
    expect(isHostCheckExempt("/health/readiness")).toBe(false);
    expect(isHostCheckExempt("/healthy")).toBe(false);
  });
});

describe("TrustedHostMiddleware", () => {
  it("passes every host through and reads nothing when the feature is off", async () => {
    const h = harness({ enabled: false, trusted: false });
    h.middleware.use(request("evil.example"), h.response, h.next);
    await settle();
    expect(h.next).toHaveBeenCalledOnce();
    expect(h.isTrustedHost).not.toHaveBeenCalled();
    expect(h.status).not.toHaveBeenCalled();
  });

  it("admits a trusted host", async () => {
    const h = harness({ enabled: true, trusted: true });
    h.middleware.use(request("notes.acme.com"), h.response, h.next);
    await settle();
    expect(h.next).toHaveBeenCalledOnce();
    expect(h.status).not.toHaveBeenCalled();
  });

  // The header-spoofing regression: a forged `Host` on a deployment that serves
  // more than one hostname must not reach a single route.
  it("refuses a spoofed host with 421 and the stable envelope", async () => {
    const h = harness({ enabled: true, trusted: false });
    h.middleware.use(request("evil.example"), h.response, h.next);
    await settle();
    expect(h.next).not.toHaveBeenCalled();
    expect(h.status).toHaveBeenCalledWith(421);
    expect(h.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "UNTRUSTED_HOST" }),
        requestId: "req-1",
      }),
    );
  });

  // A readiness probe dials the container's own address with whatever `Host`
  // the orchestrator supplies; failing it would drain a healthy deployment.
  it("exempts the health probes even from an untrusted host", async () => {
    const h = harness({ enabled: true, trusted: false });
    h.middleware.use(request("10.0.0.4", "/health/ready"), h.response, h.next);
    await settle();
    expect(h.next).toHaveBeenCalledOnce();
    expect(h.isTrustedHost).not.toHaveBeenCalled();
  });

  it("refuses rather than admitting when the lookup itself rejects", async () => {
    const isTrustedHost = vi.fn(() => Promise.reject(new Error("boom")));
    const middleware = new TrustedHostMiddleware(
      { isTrustedHost } as unknown as VerifiedHostsService,
      parseAppConfig({ CUSTOM_DOMAINS_ENABLED: "true" }),
    );
    const json = vi.fn();
    const response = {
      status: vi.fn(() => ({ json })),
      json,
      getHeader: () => "req-1",
    } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    middleware.use(request("notes.acme.com"), response, next);
    await settle();
    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: "UNTRUSTED_HOST" }) }),
    );
  });
});
