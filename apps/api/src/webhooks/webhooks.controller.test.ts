import { HttpStatus, RequestMethod } from "@nestjs/common";
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { WEBHOOK_API_PATHS } from "@notted/shared-types";
import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import {
  AUTHORIZATION_HTTP_SPEC,
  type HttpAuthorizationSpec,
} from "../authorization/authorization-http.decorator";
import { RATE_LIMIT_TIER } from "../common/rate-limit/rate-limit.decorator";

import { WebhooksController } from "./webhooks.controller";

import type { WebhooksService } from "./webhooks.service";
import type { AuthService } from "../auth/auth.service";
import type { Request } from "express";

const userId = "90000000-0000-4000-8000-000000000001";
const workspaceId = "90000000-0000-4000-8100-000000000001";
const webhookId = "90000000-0000-4000-8200-000000000001";
const deliveryId = "90000000-0000-4000-8300-000000000001";

function request(params: Record<string, string> = {}): Request {
  const value = {
    params,
    header: () => "https://app.notted.test",
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

function controller(service: Partial<WebhooksService>, origin = vi.fn()): WebhooksController {
  return new WebhooksController(
    service as WebhooksService,
    {
      assertTrustedMutationOrigin: origin,
    } as unknown as AuthService,
  );
}

function specFor(handler: keyof WebhooksController): HttpAuthorizationSpec {
  const spec: unknown = Reflect.getMetadata(
    AUTHORIZATION_HTTP_SPEC,
    WebhooksController.prototype[handler],
  );
  if (spec === undefined) throw new Error(`missing authorization spec for ${handler}`);
  return spec as HttpAuthorizationSpec;
}

const HANDLERS = [
  "list",
  "create",
  "update",
  "remove",
  "rotateSecret",
  "verify",
  "listDeliveries",
  "retryDelivery",
] as const;

describe("WebhooksController", () => {
  it("publishes the canonical REST paths under the versioned prefix", () => {
    expect(WEBHOOK_API_PATHS.collection(":workspaceId")).toBe(
      "/api/v1/workspaces/:workspaceId/webhooks",
    );
    expect(WEBHOOK_API_PATHS.retryDelivery(":workspaceId", ":webhookId", ":deliveryId")).toBe(
      "/api/v1/workspaces/:workspaceId/webhooks/:webhookId/deliveries/:deliveryId/retry",
    );
    expect(Reflect.getMetadata(PATH_METADATA, WebhooksController)).toBe(
      "workspaces/:workspaceId/webhooks",
    );
  });

  /**
   * THE LOAD-BEARING TEST. `ApiKeyRouteGuard` is a default-deny APP_GUARD, so a
   * handler with no `AUTHORIZATION_HTTP_SPEC` is not merely unauthorized — it is
   * a 403 for every API key while still answering session callers.
   */
  it.each(HANDLERS)("carries an authorization spec on %s", (handler) => {
    expect(specFor(handler)).toBeDefined();
  });

  it.each([
    ["list", RequestMethod.GET, "webhook.list"],
    ["create", RequestMethod.POST, "webhook.create"],
    ["update", RequestMethod.PATCH, "webhook.update"],
    ["remove", RequestMethod.DELETE, "webhook.delete"],
    ["rotateSecret", RequestMethod.POST, "webhook.update"],
    ["verify", RequestMethod.POST, "webhook.update"],
    ["listDeliveries", RequestMethod.GET, "webhook.list"],
    ["retryDelivery", RequestMethod.POST, "webhook.redeliver"],
  ] as const)("binds %s to its verb and authorization action", (handler, method, action) => {
    expect(Reflect.getMetadata(METHOD_METADATA, WebhooksController.prototype[handler])).toBe(
      method,
    );
    expect(specFor(handler).action).toBe(action);
  });

  it("selects the workspace for collection routes and the endpoint for per-endpoint routes", () => {
    const collection = request({ workspaceId });
    const detail = request({ workspaceId, webhookId });
    for (const handler of ["list", "create"] as const) {
      expect(specFor(handler).workspaceId(collection)).toBe(workspaceId);
      expect(specFor(handler).resource(collection)).toEqual({ kind: "workspace" });
    }
    for (const handler of [
      "update",
      "remove",
      "rotateSecret",
      "verify",
      "retryDelivery",
    ] as const) {
      expect(specFor(handler).workspaceId(detail)).toBe(workspaceId);
      expect(specFor(handler).resource(detail)).toEqual({ kind: "webhook", id: webhookId });
    }
    // Reading the delivery log is a `webhook.list` action, whose only legal
    // resource kind is `workspace`; the service scopes the endpoint itself.
    expect(specFor("listDeliveries").resource(detail)).toEqual({ kind: "workspace" });
  });

  it("answers a create with 201 and a replay with 202", () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, WebhooksController.prototype.create)).toBe(
      HttpStatus.CREATED,
    );
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, WebhooksController.prototype.retryDelivery),
    ).toBe(HttpStatus.ACCEPTED);
    // DELETE answers 200 with a body, matching `api-keys.controller.ts` and
    // `tags.controller.ts` — no `@HttpCode(204)`.
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, WebhooksController.prototype.remove),
    ).toBeUndefined();
  });

  it("puts the two outbound-dialling routes in the sensitive rate-limit tier", () => {
    for (const handler of ["create", "verify"] as const) {
      expect(Reflect.getMetadata(RATE_LIMIT_TIER, WebhooksController.prototype[handler])).toBe(
        "sensitive",
      );
    }
    expect(Reflect.getMetadata(RATE_LIMIT_TIER, WebhooksController.prototype.list)).toBeUndefined();
  });

  it("enforces a trusted origin and delegates the parsed create body", async () => {
    const create = vi.fn().mockResolvedValue({ webhook: { id: webhookId }, secret: "whsec_x" });
    const origin = vi.fn();
    await controller({ create }, origin).create(request({ workspaceId }), {
      url: "https://receiver.example.test/hook",
      events: ["note.created", "note.updated"],
    });
    expect(origin).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: expect.objectContaining({ userId }),
        workspaceId,
        url: "https://receiver.example.test/hook",
        events: ["note.created", "note.updated"],
      }),
    );
  });

  it.each([
    // An unknown event, an empty subscription, a non-http scheme.
    { url: "https://receiver.example.test/hook", events: ["note.exploded"] },
    { url: "https://receiver.example.test/hook", events: [] },
    { url: "ftp://receiver.example.test/hook", events: ["note.created"] },
    { url: "https://user:pass@receiver.example.test/hook", events: ["note.created"] },
  ])("rejects an invalid create body before touching the service", (body) => {
    const create = vi.fn();
    // The guard is SYNCHRONOUS: the controller throws while validating, before
    // it ever returns a promise, so this must assert on a thunk. `rejects`
    // would never see the throw (it escapes at argument evaluation) and the
    // case would report a false failure. Matches `api-keys.controller.test.ts`.
    expect(() => controller({ create }).create(request({ workspaceId }), body)).toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an empty update body before touching the service", () => {
    const update = vi.fn();
    expect(() => controller({ update }).update(request({ workspaceId, webhookId }), {})).toThrow();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range delivery page before touching the service", () => {
    const listDeliveries = vi.fn();
    expect(() =>
      controller({ listDeliveries }).listDeliveries(request({ workspaceId, webhookId }), {
        page: "0",
      }),
    ).toThrow();
    expect(listDeliveries).not.toHaveBeenCalled();
  });

  it("passes the parsed delivery query through with the endpoint id", async () => {
    const listDeliveries = vi
      .fn()
      .mockResolvedValue({ items: [], page: 1, limit: 25, hasMore: false });
    await controller({ listDeliveries }).listDeliveries(request({ workspaceId, webhookId }), {
      status: "failed",
    });
    expect(listDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, webhookId, page: 1, limit: 25, status: "failed" }),
    );
  });

  it("asserts a trusted mutation origin on every mutation", async () => {
    const origin = vi.fn();
    const target = controller(
      {
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue({}),
        rotateSecret: vi.fn().mockResolvedValue({}),
        verify: vi.fn().mockResolvedValue({}),
        retryDelivery: vi.fn().mockResolvedValue({}),
      },
      origin,
    );
    const scoped = () => request({ workspaceId, webhookId, deliveryId });
    await target.create(scoped(), {
      url: "https://receiver.example.test/hook",
      events: ["note.created"],
    });
    await target.update(scoped(), { isEnabled: true });
    await target.remove(scoped());
    await target.rotateSecret(scoped());
    await target.verify(scoped());
    await target.retryDelivery(scoped());
    // Every mutating route, including the two that only take a route id.
    expect(origin).toHaveBeenCalledTimes(6);
  });

  it("carries the route delivery id into a replay", async () => {
    const retryDelivery = vi
      .fn()
      .mockResolvedValue({ webhookId, eventId: webhookId, scheduled: true });
    await controller({ retryDelivery }).retryDelivery(
      request({ workspaceId, webhookId, deliveryId }),
    );
    expect(retryDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, webhookId, deliveryId }),
    );
  });
});
