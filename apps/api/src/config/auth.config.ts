import { Injectable, type Provider } from "@nestjs/common";

import {
  type Environment,
  readOptionalString,
  readSecret,
  readString,
  readUrl,
  wrapConfigError,
} from "./environment-readers";

export const AUTH_CONFIG = Symbol("AUTH_CONFIG");

export interface AuthConfig {
  readonly secret: string;
  readonly baseUrl: URL;
  readonly basePath: string;
  readonly trustedOrigins: readonly string[];
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
    return Object.freeze({
      secret,
      baseUrl,
      basePath,
      trustedOrigins: Object.freeze(trustedOrigins.map((origin) => origin.origin)),
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
