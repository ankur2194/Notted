import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";

import { AuthorizationPolicyService } from "../authorization/authorization-policy.service";
import { actorFromPrincipal } from "../authorization/authorization.contracts";
import { ApiHttpException } from "../common/errors/api-http.exception";

import { getAuthPrincipal } from "./auth-principal";
import { AuthSecurityService } from "./auth-security.service";
import { AuthGuard } from "./auth.guard";
import { AuthService } from "./auth.service";

import type {
  AuthCapabilities,
  AuthenticatedPrincipal,
  AuthSecurityOverview,
} from "@notted/shared-types";
import type { Request } from "express";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly security: AuthSecurityService,
    private readonly authorization: AuthorizationPolicyService,
  ) {}

  @Get("capabilities")
  capabilities(): AuthCapabilities {
    return this.auth.capabilities();
  }

  @Get("session")
  @UseGuards(AuthGuard)
  session(@Req() request: Request): AuthenticatedPrincipal {
    const principal = getAuthPrincipal(request);
    if (principal === undefined) {
      throw new Error("Auth guard did not attach a principal");
    }
    return principal;
  }

  @Get("security")
  @UseGuards(AuthGuard)
  securityOverview(@Req() request: Request): Promise<AuthSecurityOverview> {
    const principal = this.principal(request);
    this.authorizeCurrentUserSession(principal, "session.list", principal.sessionId);
    return this.security.overview(principal);
  }

  @Post("sessions/revoke-others")
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  async revokeOtherSessions(@Req() request: Request): Promise<{ readonly status: true }> {
    const principal = this.principal(request);
    this.auth.assertTrustedMutationOrigin(request);
    this.auth.requireRecentAuthentication(principal);
    this.authorizeCurrentUserSession(principal, "session.revoke", principal.sessionId);
    await this.security.revokeOtherSessions(principal);
    return { status: true };
  }

  @Delete("sessions/:sessionId")
  @UseGuards(AuthGuard)
  async revokeSession(
    @Req() request: Request,
    @Param("sessionId") sessionId: string,
  ): Promise<{ readonly status: true }> {
    const principal = this.principal(request);
    this.auth.assertTrustedMutationOrigin(request);
    this.auth.requireRecentAuthentication(principal);
    this.authorizeCurrentUserSession(principal, "session.revoke", sessionId);
    await this.security.revokeSession(principal, sessionId);
    return { status: true };
  }

  private principal(request: Request): AuthenticatedPrincipal {
    const principal = getAuthPrincipal(request);
    if (principal === undefined) {
      throw new Error("Auth guard did not attach a principal");
    }
    return principal;
  }

  private authorizeCurrentUserSession(
    principal: AuthenticatedPrincipal,
    action: "session.list" | "session.revoke",
    sessionId: string,
  ): void {
    const decision = this.authorization.decide({
      actor: actorFromPrincipal(principal),
      action,
      resource: {
        kind: "session",
        id: sessionId,
        workspaceId: null,
        project: null,
        loadedAt: new Date().toISOString(),
        relationsValid: true,
      },
      tenant: { workspaceId: null, membershipRole: null, membershipLoadedAt: null },
    });
    if (!decision.allowed) {
      throw new ApiHttpException(decision.httpStatus, {
        code:
          decision.code === "authorization.unauthenticated"
            ? "UNAUTHENTICATED"
            : decision.code === "authorization.recent_authentication_required"
              ? "RECENT_AUTHENTICATION_REQUIRED"
              : "FORBIDDEN",
        message: decision.safeMessage,
      });
    }
  }
}
