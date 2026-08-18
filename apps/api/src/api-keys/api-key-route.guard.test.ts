import { type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";

import {
  AUTHORIZATION_HTTP_SPEC,
  type HttpAuthorizationSpec,
} from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";

import { setApiKeyActor } from "./api-key-context";
import { ApiKeyRouteGuard } from "./api-key-route.guard";

import type { Request } from "express";

const API_KEY_ID = "60000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "60000000-0000-4000-8100-000000000001";

const spec: HttpAuthorizationSpec = {
  action: "apiKey.list",
  workspaceId: () => WORKSPACE_ID,
  resource: () => ({ kind: "workspace" }),
};

class UnguardedController {
  handler(): void {
    // No @RequireAuthorization: the route the blast-radius guard must refuse.
  }
}

class GuardedController {
  handler(): void {
    // Metadata attached below, exactly as @RequireAuthorization would.
  }
}
Reflect.defineMetadata(AUTHORIZATION_HTTP_SPEC, spec, GuardedController.prototype.handler);

type HandlerHolder = { prototype: { handler: () => void } };

function httpContext(target: HandlerHolder, request: Request): ExecutionContext {
  return {
    getType: () => "http",
    getClass: () => target,
    getHandler: () => target.prototype.handler,
    switchToHttp: () => ({ getRequest: <T = Request>() => request as T }),
  } as unknown as ExecutionContext;
}

function apiKeyRequest(
  scopes: readonly ("read" | "write" | "admin")[] = ["read", "write", "admin"],
  method = "GET",
): Request {
  const request = { method } as Request;
  setApiKeyActor(request, {
    kind: "api-key",
    apiKeyId: API_KEY_ID,
    workspaceId: WORKSPACE_ID,
    scopes,
  });
  return request;
}

describe("ApiKeyRouteGuard", () => {
  it("refuses an api-key request on a handler with no authorization spec", () => {
    const guard = new ApiKeyRouteGuard(new Reflector());
    let thrown: unknown;
    try {
      guard.canActivate(httpContext(UnguardedController, apiKeyRequest()));
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiHttpException);
    const error = thrown as ApiHttpException;
    expect(error.getStatus()).toBe(403);
    expect(error.safeResponse.code).toBe("FORBIDDEN");
    // An admin-scoped key is refused too: scope breadth is not the point.
    expect(error.safeResponse.message).toBe("You are not allowed to do that.");
  });

  it("admits an api-key request on a handler that carries the spec", () => {
    const guard = new ApiKeyRouteGuard(new Reflector());
    expect(guard.canActivate(httpContext(GuardedController, apiKeyRequest()))).toBe(true);
  });

  // The class of bug this closes: a mutating route whose declared action is
  // read-class (`POST :noteId/copy` → `note.read`, `POST tasks/bulk` →
  // `workspace.read`, `PUT .../shares/:userId` before its action was corrected).
  // `decideApiKey` reads those as reads, and the service re-check runs as the
  // key's CREATOR, so without this the scope would never be consulted at all.
  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "refuses %s from a read-only key even on a route that carries a spec",
    (method) => {
      const guard = new ApiKeyRouteGuard(new Reflector());
      let thrown: unknown;
      try {
        guard.canActivate(httpContext(GuardedController, apiKeyRequest(["read"], method)));
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ApiHttpException);
      expect((thrown as ApiHttpException).getStatus()).toBe(403);
    },
  );

  it("admits a read-only key on safe methods and any key that can write", () => {
    const guard = new ApiKeyRouteGuard(new Reflector());
    for (const method of ["GET", "head", "OPTIONS"]) {
      expect(
        guard.canActivate(httpContext(GuardedController, apiKeyRequest(["read"], method))),
      ).toBe(true);
    }
    expect(
      guard.canActivate(httpContext(GuardedController, apiKeyRequest(["write"], "POST"))),
    ).toBe(true);
    expect(
      guard.canActivate(httpContext(GuardedController, apiKeyRequest(["admin"], "DELETE"))),
    ).toBe(true);
  });

  it("never interferes with a session request, spec or no spec", () => {
    const guard = new ApiKeyRouteGuard(new Reflector());
    expect(guard.canActivate(httpContext(UnguardedController, {} as Request))).toBe(true);
    expect(guard.canActivate(httpContext(GuardedController, {} as Request))).toBe(true);
  });

  it("ignores non-HTTP execution contexts", () => {
    const guard = new ApiKeyRouteGuard(new Reflector());
    const context = {
      getType: () => "ws",
      switchToHttp: () => {
        throw new Error("must not inspect a WebSocket context as HTTP");
      },
    } as unknown as ExecutionContext;
    expect(guard.canActivate(context)).toBe(true);
  });
});
