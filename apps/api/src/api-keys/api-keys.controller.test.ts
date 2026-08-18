import { HttpStatus, RequestMethod } from "@nestjs/common";
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { API_KEY_API_PATHS } from "@notted/shared-types";
import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import {
  AUTHORIZATION_HTTP_SPEC,
  type HttpAuthorizationSpec,
} from "../authorization/authorization-http.decorator";

import { ApiKeysController } from "./api-keys.controller";

import type { ApiKeysService } from "./api-keys.service";
import type { AuthService } from "../auth/auth.service";
import type { Request } from "express";

const userId = "80000000-0000-4000-8000-000000000001";
const workspaceId = "80000000-0000-4000-8100-000000000001";
const apiKeyId = "80000000-0000-4000-8200-000000000001";

function request(
  params: Record<string, string> = {},
  idempotencyKey = "api-key-create-000001",
): Request {
  const value = {
    params,
    header: (name: string) =>
      name.toLowerCase() === "idempotency-key" ? idempotencyKey : "https://app.notted.test",
  } as unknown as Request;
  setAuthPrincipal(value, {
    userId,
    sessionId: "session",
    method: "opaque-session",
    assurance: "single-factor",
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isFresh: true,
  });
  return value;
}

function controller(service: Partial<ApiKeysService>, origin = vi.fn()): ApiKeysController {
  return new ApiKeysController(
    service as ApiKeysService,
    {
      assertTrustedMutationOrigin: origin,
    } as unknown as AuthService,
  );
}

function specFor(handler: keyof ApiKeysController): HttpAuthorizationSpec {
  const spec: unknown = Reflect.getMetadata(
    AUTHORIZATION_HTTP_SPEC,
    ApiKeysController.prototype[handler],
  );
  if (spec === undefined) throw new Error(`missing authorization spec for ${handler}`);
  return spec as HttpAuthorizationSpec;
}

describe("ApiKeysController", () => {
  it("publishes the canonical REST paths under the versioned prefix", () => {
    expect(API_KEY_API_PATHS.collection(":workspaceId")).toBe(
      "/api/v1/workspaces/:workspaceId/api-keys",
    );
    expect(API_KEY_API_PATHS.detail(":workspaceId", ":apiKeyId")).toBe(
      "/api/v1/workspaces/:workspaceId/api-keys/:apiKeyId",
    );
    expect(Reflect.getMetadata(PATH_METADATA, ApiKeysController)).toBe(
      "workspaces/:workspaceId/api-keys",
    );
  });

  it.each([
    ["list", RequestMethod.GET, "apiKey.list"],
    ["create", RequestMethod.POST, "apiKey.create"],
    ["remove", RequestMethod.DELETE, "apiKey.revoke"],
  ] as const)("binds %s to its verb and authorization action", (handler, method, action) => {
    expect(Reflect.getMetadata(METHOD_METADATA, ApiKeysController.prototype[handler])).toBe(method);
    expect(specFor(handler).action).toBe(action);
  });

  it("answers a create with 201", () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, ApiKeysController.prototype.create)).toBe(
      HttpStatus.CREATED,
    );
  });

  it("selects the workspace for collection routes and the key for the detail route", () => {
    const collection = request({ workspaceId });
    const detail = request({ workspaceId, apiKeyId });
    for (const handler of ["list", "create"] as const) {
      expect(specFor(handler).workspaceId(collection)).toBe(workspaceId);
      expect(specFor(handler).resource(collection)).toEqual({ kind: "workspace" });
    }
    expect(specFor("remove").workspaceId(detail)).toBe(workspaceId);
    expect(specFor("remove").resource(detail)).toEqual({ kind: "apiKey", id: apiKeyId });
  });

  it("enforces trusted origin and an idempotency key before creating", async () => {
    const create = vi.fn().mockResolvedValue({ apiKey: { id: apiKeyId }, secret: "ntd_pk_x" });
    const origin = vi.fn();
    await controller({ create }, origin).create(request({ workspaceId }), {
      name: "CI export runner",
      scopes: ["read", "write"],
    });
    expect(origin).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: expect.objectContaining({ userId }),
        workspaceId,
        name: "CI export runner",
        scopes: ["read", "write"],
        idempotencyKey: "api-key-create-000001",
      }),
    );
  });

  it("defaults the scope set rather than minting an all-powerful key", async () => {
    const create = vi.fn().mockResolvedValue({ apiKey: { id: apiKeyId }, secret: "ntd_pk_x" });
    await controller({ create }).create(request({ workspaceId }), { name: "CI export runner" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ scopes: ["read", "write"] }));
  });

  it("rejects a create without a usable idempotency key", () => {
    const create = vi.fn();
    expect(() =>
      controller({ create }).create(request({ workspaceId }, "short"), {
        name: "CI export runner",
      }),
    ).toThrow("A valid Idempotency-Key header is required.");
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty name", { name: "" }],
    ["an unknown scope", { name: "CI", scopes: ["superuser"] }],
    ["an empty scope set", { name: "CI", scopes: [] }],
    ["a past expiry", { name: "CI", expiresAt: "2020-01-01T00:00:00.000Z" }],
    ["an unknown field", { name: "CI", workspaceId }],
  ])("rejects %s before touching the service", (_name, body) => {
    const create = vi.fn();
    const origin = vi.fn();
    expect(() => controller({ create }, origin).create(request({ workspaceId }), body)).toThrow(
      "The request is invalid.",
    );
    expect(origin).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it("enforces trusted origin on revoke and forwards the route id", async () => {
    const revoke = vi.fn().mockResolvedValue({ apiKeyId, revoked: true });
    const origin = vi.fn();
    await controller({ revoke }, origin).remove(request({ workspaceId, apiKeyId }));
    expect(origin).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, apiKeyId }));
  });

  it("coerces and forwards the list query without accepting unknown filters", async () => {
    const list = vi.fn().mockResolvedValue({ items: [], page: 2, limit: 10, hasMore: false });
    await controller({ list }).list(request({ workspaceId }), {
      page: "2",
      limit: "10",
      includeRevoked: "true",
      sortBy: "lastUsedAt",
      sortDirection: "asc",
    });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        page: 2,
        limit: 10,
        includeRevoked: true,
        sortBy: "lastUsedAt",
        sortDirection: "asc",
      }),
    );
    expect(() => controller({ list }).list(request({ workspaceId }), { workspaceId })).toThrow(
      "The request is invalid.",
    );
  });
});
