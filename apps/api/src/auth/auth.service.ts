import { HttpStatus, Inject, Injectable } from "@nestjs/common";

import { ApiHttpException } from "../common/errors/api-http.exception";
import { setTrustedPrincipal } from "../common/rate-limit/trusted-principal";
import { AUTH_CONFIG, type AuthConfig } from "../config/auth.config";
import { RETENTION_CONFIG, type RetentionConfig } from "../config/retention.config";

import { getAuthPrincipal, setAuthPrincipal } from "./auth-principal";
import { BETTER_AUTH_INSTANCE } from "./auth.tokens";

import type { BetterAuthInstance } from "./better-auth.setup";
import type { AuthCapabilities, AuthenticatedPrincipal } from "@notted/shared-types";
import type { Request } from "express";

export function toWebHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers.set(name, value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    }
  }
  return headers;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(BETTER_AUTH_INSTANCE) private readonly auth: BetterAuthInstance | null,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(RETENTION_CONFIG) private readonly retention: RetentionConfig,
  ) {}

  capabilities(): AuthCapabilities {
    const labels = { google: "Google", github: "GitHub", microsoft: "Microsoft" } as const;
    return Object.freeze({
      oauthProviders: Object.freeze(
        this.config.enabledOAuthProviders.map((id) => Object.freeze({ id, label: labels[id] })),
      ),
      passkeyEnabled: true,
      twoFactorEnabled: true,
      nonRememberedSessionSeconds: this.retention.sessionShortLivedHours * 60 * 60,
      rememberedSessionSeconds: this.retention.sessionRememberMeDays * 24 * 60 * 60,
      recentAuthenticationSeconds: this.config.recentAuthenticationSeconds,
    });
  }

  /** Internal availability seam for transports that must distinguish outage from no session. */
  isAvailable(): boolean {
    return this.auth !== null;
  }

  assertTrustedMutationOrigin(request: Request): void {
    const origin = request.header("origin");
    if (origin === undefined || !this.config.trustedOrigins.includes(origin)) {
      throw new ApiHttpException(HttpStatus.FORBIDDEN, {
        code: "CSRF_ORIGIN_INVALID",
        message: "The request origin is not allowed.",
      });
    }
  }

  requireRecentAuthentication(principal: AuthenticatedPrincipal): void {
    if (!principal.isFresh) {
      throw new ApiHttpException(HttpStatus.FORBIDDEN, {
        code: "RECENT_AUTHENTICATION_REQUIRED",
        message: "Confirm your identity to continue.",
      });
    }
  }

  async authenticate(request: Request): Promise<AuthenticatedPrincipal | null> {
    if (this.auth === null) {
      return null;
    }
    const existing = getAuthPrincipal(request);
    if (existing !== undefined) {
      return existing;
    }
    const result = await this.auth.api.getSession({ headers: toWebHeaders(request) });
    if (result === null) {
      return null;
    }
    const createdAt = result.session.createdAt;
    const principal: AuthenticatedPrincipal = Object.freeze({
      userId: result.user.id,
      sessionId: result.session.id,
      method: "opaque-session",
      assurance: "single-factor",
      expiresAt: result.session.expiresAt.toISOString(),
      authenticatedAt: createdAt.toISOString(),
      isFresh: Date.now() - createdAt.getTime() <= this.config.recentAuthenticationSeconds * 1_000,
    });
    setAuthPrincipal(request, principal);
    setTrustedPrincipal(request, { actorId: principal.userId, kind: "user" });
    return principal;
  }
}
