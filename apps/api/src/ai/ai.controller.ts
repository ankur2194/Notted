// Part 67 — the workspace AI surface over the versioned REST API.
//
// REST only, no tRPC subrouter: `apps/web` reaches this from workspace settings
// through the same REST client the sibling admin surfaces (API keys, webhooks,
// exports, notifications) use, and a second transport with no caller is a
// second thing to keep authorized.
//
// EVERY HANDLER CARRIES `@RequireAuthorization`, WITHOUT EXCEPTION. Part 65's
// `ApiKeyRouteGuard` is a default-deny APP_GUARD: an API-key request may only
// reach a handler that carries `AUTHORIZATION_HTTP_SPEC` metadata, so a missing
// decorator does not merely skip a check — it makes the route 403 for every API
// key while still serving session callers. That asymmetry is exactly the kind
// of bug nobody notices for a month.
//
// TWO ACTIONS, TWO AUDIENCES. `ai.configure` is owner/admin and `HIGH_RISK`
// (so it demands a fresh session) because it writes provider key material;
// `ai.use` reaches editors and backs the deliberately thin `GET status`.
// Nothing in this file re-implements any of that.
//
// `PUT`, not `PATCH`: `aiConfigUpdateSchema` is the whole desired
// configuration, so the write is a replacement and the verb should say so.

import { Body, Controller, Get, HttpStatus, Put, Query, Req } from "@nestjs/common";
import { aiConfigUpdateSchema, aiUsageQuerySchema, uuidSchema } from "@notted/shared-validators";

import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthService } from "../auth/auth.service";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { RateLimitTier } from "../common/rate-limit/rate-limit.decorator";
import { getRequestId } from "../common/request/request-context";

import { AiService } from "./ai.service";

import type {
  AiConfigView,
  AiStatus,
  AiUsageSummary,
  AuthenticatedPrincipal,
} from "@notted/shared-types";
import type { Request } from "express";

function routeUuid(request: Request): string {
  return uuidSchema.parse(request.params.workspaceId);
}

/** Every route on this controller addresses the workspace itself. */
const workspaceAuthorization = (action: "ai.configure" | "ai.use") => ({
  action,
  workspaceId: (request: Request) => routeUuid(request),
  resource: () => ({ kind: "workspace" as const }),
});

@Controller("workspaces/:workspaceId/ai")
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly auth: AuthService,
  ) {}

  @Get("config")
  @RequireAuthorization(workspaceAuthorization("ai.configure"))
  getConfig(@Req() request: Request): Promise<AiConfigView> {
    return this.ai.getConfig(this.scope(request));
  }

  /**
   * `sensitive` tier: this is the route a stolen admin session would use to
   * swap in an attacker's provider key, and it is the only route in the product
   * that accepts one. It should not be reachable at the general allowance.
   */
  @Put("config")
  @RateLimitTier("sensitive")
  @RequireAuthorization(workspaceAuthorization("ai.configure"))
  updateConfig(@Req() request: Request, @Body() rawBody: unknown): Promise<AiConfigView> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = aiConfigUpdateSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.ai.updateConfig({ ...this.scope(request), ...body.data });
  }

  /**
   * `sensitive` tier as well, despite being a read: it aggregates across the
   * whole `ai_usage` table for the workspace over a window the caller chooses,
   * so it is the most expensive query on this surface by a wide margin.
   */
  @Get("usage")
  @RateLimitTier("sensitive")
  @RequireAuthorization(workspaceAuthorization("ai.configure"))
  getUsage(@Req() request: Request, @Query() rawQuery: unknown): Promise<AiUsageSummary> {
    const query = aiUsageQuerySchema.safeParse(rawQuery);
    if (!query.success) this.invalid();
    return this.ai.getUsage({ ...this.scope(request), ...query.data });
  }

  @Get("status")
  @RequireAuthorization(workspaceAuthorization("ai.use"))
  getStatus(@Req() request: Request): Promise<AiStatus> {
    return this.ai.getStatus(this.scope(request));
  }

  private scope(request: Request) {
    return {
      principal: this.principal(request),
      workspaceId: routeUuid(request),
      requestId: getRequestId(request) ?? null,
    };
  }

  private principal(request: Request): AuthenticatedPrincipal {
    const principal = getAuthPrincipal(request);
    if (principal === undefined) throw new Error("Authorization guard did not attach a principal");
    return principal;
  }

  private invalid(): never {
    throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
      code: "VALIDATION_ERROR",
      message: "The request is invalid.",
    });
  }
}
