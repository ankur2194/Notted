// Part 73 — the custom-domain transport.
//
// REST only, no tRPC subrouter: `apps/web` reaches this from workspace settings
// through the same REST client the sibling admin surfaces use, and a second
// transport with no caller is a second thing to keep authorized.
//
// EVERY HANDLER CARRIES `@RequireAuthorization`. Part 65's `ApiKeyRouteGuard` is
// a default-deny APP_GUARD, so a missing decorator does not merely skip a check
// — it makes the route 403 for every API key while still serving session
// callers. The public resolve route lives in its own controller for exactly that
// reason: it is the one route here that is deliberately unauthorized, and mixing
// it into this class would make the rule "every handler is authorized" untrue.
//
// Both mutations additionally require a trusted mutation origin (CSRF), matching
// the workspace logo and Bull Board precedents.

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import { setWorkspaceDomainSchema, uuidSchema } from "@notted/shared-validators";

import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthService } from "../auth/auth.service";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { RateLimitTier } from "../common/rate-limit/rate-limit.decorator";
import { getRequestId } from "../common/request/request-context";

import { DomainsService } from "./domains.service";

import type { AuthenticatedPrincipal, WorkspaceDomainResult } from "@notted/shared-types";
import type { Request } from "express";

function workspaceIdFromRoute(request: Request): string {
  return uuidSchema.parse(request.params.workspaceId);
}

const domainAuthorization = (action: "settings.read" | "settings.update") => ({
  action,
  workspaceId: workspaceIdFromRoute,
  resource: () => ({ kind: "settings" as const }),
});

@Controller("workspaces/:workspaceId/domain")
export class DomainsController {
  constructor(
    private readonly domains: DomainsService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @RequireAuthorization(domainAuthorization("settings.read"))
  read(@Req() request: Request): Promise<WorkspaceDomainResult> {
    return this.domains.read(this.scope(request));
  }

  /**
   * `sensitive` tier. Claiming a hostname writes to a GLOBALLY UNIQUE column, so
   * an unthrottled caller could walk a wordlist and squat every name it wanted.
   * The tier makes that cost what it should.
   */
  @Put()
  @HttpCode(HttpStatus.OK)
  @RateLimitTier("sensitive")
  @RequireAuthorization(domainAuthorization("settings.update"))
  set(@Req() request: Request, @Body() rawBody: unknown): Promise<WorkspaceDomainResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = setWorkspaceDomainSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.domains.set({ ...this.scope(request), hostname: body.data.hostname });
  }

  /** `sensitive` tier: each call makes this server perform outbound DNS lookups. */
  @Post("verify")
  @HttpCode(HttpStatus.OK)
  @RateLimitTier("sensitive")
  @RequireAuthorization(domainAuthorization("settings.update"))
  verify(@Req() request: Request): Promise<WorkspaceDomainResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.domains.verify(this.scope(request));
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @RequireAuthorization(domainAuthorization("settings.update"))
  remove(@Req() request: Request): Promise<WorkspaceDomainResult> {
    this.auth.assertTrustedMutationOrigin(request);
    return this.domains.remove(this.scope(request));
  }

  private scope(request: Request): {
    readonly principal: AuthenticatedPrincipal;
    readonly workspaceId: string;
    readonly requestId: string | null;
  } {
    const principal = getAuthPrincipal(request);
    if (principal === undefined) throw new Error("Authorization guard did not attach a principal");
    return {
      principal,
      workspaceId: workspaceIdFromRoute(request),
      requestId: getRequestId(request) ?? null,
    };
  }

  private invalid(): never {
    throw new ApiHttpException(HttpStatus.UNPROCESSABLE_ENTITY, {
      code: "VALIDATION_ERROR",
      message: "The request body was not valid.",
    });
  }
}
