// Part 67 — transport-level assertions for the AI controller.
//
// The controller itself is thin, so what is worth asserting is the metadata a
// reader cannot see from the method body: that every handler carries an
// authorization spec (a missing one 403s every API-key caller while still
// serving sessions — see the file header on `ai.controller.ts`), that the two
// admin routes pick the right action, and that a malformed body or query is
// refused before the service is reached.

import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { AI_API_PATHS } from "@notted/shared-types";
import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import {
  AUTHORIZATION_HTTP_SPEC,
  type HttpAuthorizationSpec,
} from "../authorization/authorization-http.decorator";

import { AiController } from "./ai.controller";

import type { AiService } from "./ai.service";
import type { AuthService } from "../auth/auth.service";
import type { Request } from "express";

const USER_ID = "a0000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "a0000000-0000-4000-8100-000000000001";
const API_KEY = "sk-live-000000000000000000000000000";

const validBody = Object.freeze({
  provider: "openai",
  model: "gpt-4o-mini",
  apiKey: API_KEY,
  isEnabled: true,
  dailyTokenQuota: 1_000,
  rateLimitPerMinute: 5,
  contentConsent: true,
});

function request(params: Record<string, string> = { workspaceId: WORKSPACE_ID }): Request {
  const value = {
    params,
    header: () => "https://app.notted.test",
  } as unknown as Request;
  setAuthPrincipal(value, {
    userId: USER_ID,
    sessionId: "session",
    method: "opaque-session",
    assurance: "single-factor",
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isFresh: true,
  });
  return value;
}

function controller(service: Partial<AiService>, origin = vi.fn()): AiController {
  return new AiController(
    service as AiService,
    {
      assertTrustedMutationOrigin: origin,
    } as unknown as AuthService,
  );
}

function specFor(handler: keyof AiController): HttpAuthorizationSpec {
  const spec: unknown = Reflect.getMetadata(
    AUTHORIZATION_HTTP_SPEC,
    AiController.prototype[handler],
  );
  if (spec === undefined) throw new Error(`missing authorization spec for ${handler}`);
  return spec as HttpAuthorizationSpec;
}

describe("AiController routing and authorization", () => {
  it("publishes the final canonical REST paths under the versioned prefix", () => {
    expect(AI_API_PATHS.config(":workspaceId")).toBe("/api/v1/workspaces/:workspaceId/ai/config");
    expect(AI_API_PATHS.usage(":workspaceId")).toBe("/api/v1/workspaces/:workspaceId/ai/usage");
    expect(AI_API_PATHS.status(":workspaceId")).toBe("/api/v1/workspaces/:workspaceId/ai/status");
    expect(Reflect.getMetadata(PATH_METADATA, AiController)).toBe("workspaces/:workspaceId/ai");
  });

  it.each([
    ["getConfig", RequestMethod.GET, "ai.configure"],
    ["updateConfig", RequestMethod.PUT, "ai.configure"],
    ["getUsage", RequestMethod.GET, "ai.configure"],
    // The one member-reachable route; everything else is admin-only.
    ["getStatus", RequestMethod.GET, "ai.use"],
  ] as const)("binds %s to its verb and authorization action", (handler, method, action) => {
    expect(Reflect.getMetadata(METHOD_METADATA, AiController.prototype[handler])).toBe(method);
    expect(specFor(handler).action).toBe(action);

    const scoped = request();
    expect(specFor(handler).workspaceId(scoped)).toBe(WORKSPACE_ID);
    expect(specFor(handler).resource(scoped)).toEqual({ kind: "workspace" });
  });
});

describe("AiController delegation", () => {
  it("forwards the read routes with the parsed scope", async () => {
    const getConfig = vi.fn().mockResolvedValue({ provider: "openai" });
    const getStatus = vi.fn().mockResolvedValue({ enabled: true });
    const instance = controller({ getConfig, getStatus });

    await instance.getConfig(request());
    await instance.getStatus(request());

    for (const method of [getConfig, getStatus]) {
      expect(method).toHaveBeenCalledWith({
        principal: expect.objectContaining({ userId: USER_ID }),
        workspaceId: WORKSPACE_ID,
        requestId: null,
      });
    }
  });

  it("enforces a trusted origin and forwards the parsed body on a config write", async () => {
    const updateConfig = vi.fn().mockResolvedValue({ provider: "openai" });
    const origin = vi.fn();
    await controller({ updateConfig }, origin).updateConfig(request(), validBody);

    expect(origin).toHaveBeenCalledOnce();
    expect(updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: API_KEY,
        isEnabled: true,
        dailyTokenQuota: 1_000,
        rateLimitPerMinute: 5,
        contentConsent: true,
      }),
    );
  });

  it("applies the shared schema's defaults so a partial body cannot half-apply", async () => {
    const updateConfig = vi.fn().mockResolvedValue({ provider: "disabled" });
    await controller({ updateConfig }).updateConfig(request(), { provider: "disabled" });

    expect(updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "disabled",
        model: null,
        isEnabled: false,
        dailyTokenQuota: 50_000,
        rateLimitPerMinute: 10,
        contentConsent: false,
      }),
    );
  });

  it.each([
    ["an unknown field", { ...validBody, sneaky: true }],
    ["a key that is too short to be real", { ...validBody, apiKey: "short" }],
    ["enabling with no model", { ...validBody, model: null }],
    ["enabling without consent", { ...validBody, contentConsent: false }],
    ["enabling a disabled provider", { ...validBody, provider: "disabled" }],
  ] as const)("rejects %s before touching the service", (_label, body) => {
    const updateConfig = vi.fn();
    const origin = vi.fn();

    expect(() => controller({ updateConfig }, origin).updateConfig(request(), body)).toThrow(
      "The request is invalid.",
    );
    // The origin check runs first, and deliberately: a cross-site write is
    // refused whether or not its body happens to parse.
    expect(origin).toHaveBeenCalledOnce();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("coerces the usage window from its query string and bounds it", async () => {
    const getUsage = vi.fn().mockResolvedValue({ totalRequests: 0 });
    await controller({ getUsage }).getUsage(request(), { days: "7" });
    expect(getUsage).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID, days: 7 }),
    );

    await controller({ getUsage }).getUsage(request(), {});
    expect(getUsage).toHaveBeenLastCalledWith(expect.objectContaining({ days: 30 }));

    for (const query of [{ days: "0" }, { days: "91" }, { days: "7", extra: "1" }]) {
      expect(() => controller({ getUsage }).getUsage(request(), query)).toThrow(
        "The request is invalid.",
      );
    }
  });
});
