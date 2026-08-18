// Part 65 — default-deny blast radius for API-key requests.
//
// The 19 existing `/api/v1` controllers ARE the public API, so an API key can
// physically reach any route the router exposes. Every route that MATTERS
// carries `@RequireAuthorization(...)`, whose guard resolves a workspace and
// runs the policy. This APP_GUARD closes the remainder: if a request is
// authenticated by an API key and lands on a handler with no authorization
// spec — a health probe, an account-level route, anything added later without
// one — it is refused rather than silently admitted.
//
// IT ALSO ENFORCES THE READ SCOPE BY HTTP METHOD. `decideApiKey` derives
// read-vs-write from the ACTION NAME, and a handful of legitimate routes mutate
// under a read-class action: `POST :noteId/copy` authorizes `note.read` on the
// SOURCE note, `POST tasks/bulk` authorizes `workspace.read` on the workspace,
// the notification routes authorize `workspace.read`. For a session that is
// correct — the service re-authorizes the real mutation underneath. For an API
// key it is not, because that second check runs through `authorizeUser` against
// the key CREATOR's role and never sees the key's scopes: the transport action
// is the only scope check on the path. A method check closes the whole class at
// once, including any route added later, rather than one action name at a time.

import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import {
  AUTHORIZATION_HTTP_SPEC,
  type HttpAuthorizationSpec,
} from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";

import { getApiKeyActor } from "./api-key-context";

import type { Request } from "express";

/** RFC 9110 safe methods. Everything else changes state by definition. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

@Injectable()
export class ApiKeyRouteGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // API keys only ever arrive over HTTP; WebSocket and queue contexts have no
    // request object to inspect.
    if (context.getType() !== "http") return true;
    const request = context.switchToHttp().getRequest<Request>();
    const actor = getApiKeyActor(request);
    if (actor === undefined) return true;
    const spec = this.reflector.getAllAndOverride<HttpAuthorizationSpec | undefined>(
      AUTHORIZATION_HTTP_SPEC,
      [context.getHandler(), context.getClass()],
    );
    if (spec === undefined) this.refuse();
    // A key holding neither `write` nor `admin` may only use a safe method,
    // whatever action the route declares.
    const writes = actor.scopes.includes("write") || actor.scopes.includes("admin");
    if (!writes && !SAFE_METHODS.has((request.method ?? "").toUpperCase())) this.refuse();
    return true;
  }

  private refuse(): never {
    throw new ApiHttpException(HttpStatus.FORBIDDEN, {
      code: "FORBIDDEN",
      message: "You are not allowed to do that.",
    });
  }
}
