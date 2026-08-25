import { Injectable, type Provider } from "@nestjs/common";

import {
  type Environment,
  readHost,
  readOptionalString,
  readInteger,
  readSecret,
  readString,
  readUrl,
  wrapConfigError,
} from "./environment-readers";

export const AUTH_CONFIG = Symbol("AUTH_CONFIG");

export const AUTH_OAUTH_PROVIDER_IDS = ["google", "github", "microsoft"] as const;
export type AuthOAuthProviderId = (typeof AUTH_OAUTH_PROVIDER_IDS)[number];

interface OAuthClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

interface MicrosoftOAuthCredentials extends OAuthClientCredentials {
  readonly tenantId: string;
}

export interface AuthOAuthConfig {
  readonly google?: OAuthClientCredentials;
  readonly github?: OAuthClientCredentials;
  readonly microsoft?: MicrosoftOAuthCredentials;
}

export interface AuthConfig {
  readonly secret: string;
  readonly baseUrl: URL;
  readonly basePath: string;
  readonly trustedOrigins: readonly string[];
  readonly verificationTokenTtlSeconds: number;
  readonly magicLinkTokenTtlSeconds: number;
  readonly passwordResetTokenTtlSeconds: number;
  readonly oauth: AuthOAuthConfig;
  readonly enabledOAuthProviders: readonly AuthOAuthProviderId[];
  readonly passkeyRpId: string;
  readonly passkeyOrigins: readonly string[];
  readonly recentAuthenticationSeconds: number;
  readonly twoFactorChallengeSeconds: number;
  readonly twoFactorLockoutAttempts: number;
  readonly twoFactorLockoutSeconds: number;
  /**
   * Part 74 — credential-stuffing lockout on the *identifier* (email), which is
   * the axis a distributed attacker cannot rotate. Distinct from the two-factor
   * lockout above, which counts second-factor failures for an already-identified
   * account.
   */
  readonly lockoutAttempts: number;
  readonly lockoutSeconds: number;
}

function oauthCredentials(
  environment: Environment,
  provider: "GOOGLE" | "GITHUB",
): OAuthClientCredentials | undefined {
  const clientId = readOptionalString(environment, `AUTH_OAUTH_${provider}_CLIENT_ID`);
  const clientSecret = readOptionalString(environment, `AUTH_OAUTH_${provider}_CLIENT_SECRET`);
  if (clientId === undefined && clientSecret === undefined) return undefined;
  if (clientId === undefined || clientSecret === undefined) {
    throw new Error(
      `AUTH_OAUTH_${provider}_CLIENT_ID and AUTH_OAUTH_${provider}_CLIENT_SECRET must be configured together`,
    );
  }
  if (clientId.length > 512 || Buffer.byteLength(clientSecret, "utf8") > 4_096) {
    throw new Error(`AUTH_OAUTH_${provider} credentials exceed supported lengths`);
  }
  return Object.freeze({ clientId, clientSecret });
}

function microsoftOAuthCredentials(
  environment: Environment,
): MicrosoftOAuthCredentials | undefined {
  const clientId = readOptionalString(environment, "AUTH_OAUTH_MICROSOFT_CLIENT_ID");
  const clientSecret = readOptionalString(environment, "AUTH_OAUTH_MICROSOFT_CLIENT_SECRET");
  const tenantId = readOptionalString(environment, "AUTH_OAUTH_MICROSOFT_TENANT_ID");
  if (clientId === undefined && clientSecret === undefined && tenantId === undefined)
    return undefined;
  if (clientId === undefined || clientSecret === undefined || tenantId === undefined) {
    throw new Error(
      "AUTH_OAUTH_MICROSOFT_CLIENT_ID, AUTH_OAUTH_MICROSOFT_CLIENT_SECRET, and AUTH_OAUTH_MICROSOFT_TENANT_ID must be configured together",
    );
  }
  if (
    clientId.length > 512 ||
    Buffer.byteLength(clientSecret, "utf8") > 4_096 ||
    tenantId.length > 255 ||
    !/^[a-z\d.-]+$/iu.test(tenantId)
  ) {
    throw new Error("AUTH_OAUTH_MICROSOFT credentials or tenant ID are invalid");
  }
  return Object.freeze({ clientId, clientSecret, tenantId });
}

export function parseAuthConfig(environment: Environment): AuthConfig {
  try {
    const production = environment.NODE_ENV === "production";
    const secret =
      readSecret(environment, "BETTER_AUTH_SECRET", {
        fallback: production ? undefined : "notted-development-auth-secret-change-me",
        minimumLength: 32,
        required: production,
      }) ?? "";
    if (production && /(?:change|example|password|notted)/iu.test(secret)) {
      throw new Error("BETTER_AUTH_SECRET must be a non-placeholder production secret");
    }
    const baseUrl = readUrl(environment, "BETTER_AUTH_URL", {
      allowedProtocols: ["http:", "https:"],
      fallback:
        readOptionalString(environment, "API_URL") ??
        (production ? undefined : "http://localhost:3001"),
      originOnly: true,
      required: production,
    });
    if (production && baseUrl.protocol !== "https:") {
      throw new Error("BETTER_AUTH_URL must use HTTPS in production");
    }
    const basePath = readString(environment, "BETTER_AUTH_BASE_PATH", "/api/auth");
    if (!/^\/[a-z\d/_-]*$/u.test(basePath) || basePath.endsWith("/")) {
      throw new Error("BETTER_AUTH_BASE_PATH must be an absolute path without a trailing slash");
    }
    const trustedOriginValues = (
      readOptionalString(environment, "BETTER_AUTH_TRUSTED_ORIGINS") ??
      readOptionalString(environment, "APP_URL") ??
      (production ? undefined : "http://localhost:3000")
    )?.split(",");
    if (trustedOriginValues === undefined || trustedOriginValues.length === 0) {
      throw new Error("BETTER_AUTH_TRUSTED_ORIGINS is required");
    }
    const trustedOrigins = trustedOriginValues.map((value) =>
      readUrl({ origin: value.trim() }, "origin", {
        allowedProtocols: ["http:", "https:"],
        originOnly: true,
        required: true,
      }),
    );
    if (production && trustedOrigins.some((origin) => origin.protocol !== "https:")) {
      throw new Error("BETTER_AUTH_TRUSTED_ORIGINS must use HTTPS in production");
    }
    const appOrigin = readUrl(environment, "APP_URL", {
      allowedProtocols: ["http:", "https:"],
      fallback: production ? undefined : "http://localhost:3000",
      originOnly: true,
      required: production,
    }).origin;
    if (!trustedOrigins.some((origin) => origin.origin === appOrigin)) {
      throw new Error("BETTER_AUTH_TRUSTED_ORIGINS must include APP_URL");
    }
    const oauth = Object.freeze({
      google: oauthCredentials(environment, "GOOGLE"),
      github: oauthCredentials(environment, "GITHUB"),
      microsoft: microsoftOAuthCredentials(environment),
    });
    const passkeyRpId = readHost(
      environment,
      "AUTH_PASSKEY_RP_ID",
      new URL(appOrigin).hostname,
    ).toLowerCase();
    if (
      production &&
      (passkeyRpId === "localhost" ||
        passkeyRpId.includes(":") ||
        /^\d+(?:\.\d+){3}$/u.test(passkeyRpId))
    ) {
      throw new Error("AUTH_PASSKEY_RP_ID must be a non-local hostname in production");
    }
    const passkeyOriginValues = (
      readOptionalString(environment, "AUTH_PASSKEY_ORIGINS") ?? appOrigin
    ).split(",");
    const passkeyOrigins = passkeyOriginValues.map((value) =>
      readUrl({ origin: value.trim() }, "origin", {
        allowedProtocols: ["http:", "https:"],
        originOnly: true,
        required: true,
      }),
    );
    for (const origin of passkeyOrigins) {
      const localDevelopmentOrigin =
        !production && origin.protocol === "http:" && origin.hostname === "localhost";
      if (origin.protocol !== "https:" && !localDevelopmentOrigin) {
        throw new Error(
          "AUTH_PASSKEY_ORIGINS must use HTTPS except for http://localhost development",
        );
      }
      if (origin.hostname !== passkeyRpId && !origin.hostname.endsWith(`.${passkeyRpId}`)) {
        throw new Error(
          "AUTH_PASSKEY_RP_ID must equal or be a parent domain of every passkey origin",
        );
      }
      if (!trustedOrigins.some((trustedOrigin) => trustedOrigin.origin === origin.origin)) {
        throw new Error("AUTH_PASSKEY_ORIGINS must be included in BETTER_AUTH_TRUSTED_ORIGINS");
      }
    }
    return Object.freeze({
      secret,
      baseUrl,
      basePath,
      trustedOrigins: Object.freeze(trustedOrigins.map((origin) => origin.origin)),
      verificationTokenTtlSeconds: readInteger(
        environment,
        "AUTH_VERIFICATION_TOKEN_TTL_SECONDS",
        3_600,
        300,
        86_400,
      ),
      magicLinkTokenTtlSeconds: readInteger(
        environment,
        "AUTH_MAGIC_LINK_TOKEN_TTL_SECONDS",
        900,
        60,
        3_600,
      ),
      passwordResetTokenTtlSeconds: readInteger(
        environment,
        "AUTH_PASSWORD_RESET_TOKEN_TTL_SECONDS",
        3_600,
        300,
        86_400,
      ),
      oauth,
      enabledOAuthProviders: Object.freeze(
        AUTH_OAUTH_PROVIDER_IDS.filter((provider) => oauth[provider] !== undefined),
      ),
      passkeyRpId,
      passkeyOrigins: Object.freeze(passkeyOrigins.map((origin) => origin.origin)),
      recentAuthenticationSeconds: readInteger(
        environment,
        "AUTH_RECENT_AUTH_SECONDS",
        600,
        60,
        3_600,
      ),
      twoFactorChallengeSeconds: readInteger(
        environment,
        "AUTH_TWO_FACTOR_CHALLENGE_SECONDS",
        600,
        60,
        900,
      ),
      twoFactorLockoutAttempts: readInteger(
        environment,
        "AUTH_TWO_FACTOR_LOCKOUT_ATTEMPTS",
        10,
        3,
        20,
      ),
      twoFactorLockoutSeconds: readInteger(
        environment,
        "AUTH_TWO_FACTOR_LOCKOUT_SECONDS",
        900,
        60,
        3_600,
      ),
      lockoutAttempts: readInteger(environment, "AUTH_LOCKOUT_ATTEMPTS", 10, 3, 100),
      lockoutSeconds: readInteger(environment, "AUTH_LOCKOUT_SECONDS", 900, 60, 86_400),
    });
  } catch (error: unknown) {
    wrapConfigError("Invalid auth configuration", error);
  }
}

@Injectable()
export class AuthConfigProvider {
  readonly value = parseAuthConfig(process.env);
}

export const authConfigProvider: Provider<AuthConfig> = {
  provide: AUTH_CONFIG,
  inject: [AuthConfigProvider],
  useFactory: (provider: AuthConfigProvider): AuthConfig => provider.value,
};
