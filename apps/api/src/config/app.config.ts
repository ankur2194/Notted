import { Injectable, type Provider } from "@nestjs/common";

import {
  type Environment,
  readBoolean,
  readEnum,
  readHost,
  readInteger,
  readOptionalString,
  readUrl,
  wrapConfigError,
} from "./environment-readers";

export const APP_CONFIG = Symbol("APP_CONFIG");

export const NODE_ENVIRONMENTS = ["development", "test", "production"] as const;
export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

/** Same shape `readHost` accepts, minus the IP-literal escape hatch. */
const HOSTNAME_PATTERN =
  /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)*[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/u;

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly apiHost: string;
  readonly apiPort: number;
  readonly appUrl: URL;
  readonly apiUrl: URL;
  readonly websocketUrl: URL;
  readonly logLevel: LogLevel;
  readonly trustProxyHops: number;
  readonly requestBodyLimitBytes: number;
  readonly unauthenticatedRateLimitPerMinute: number;
  readonly authenticatedRateLimitPerMinute: number;
  readonly sensitiveRateLimitPerMinute: number;
  /**
   * Part 74 — the authentication tier, tighter than `sensitive` by default.
   * It bounds BOTH the per-IP bucket in `AuthRateLimitMiddleware` and the
   * per-identifier budget in `AuthLockoutService`, so a single value answers
   * "how many credential attempts per minute" whichever side is counting.
   */
  readonly authRateLimitPerMinute: number;
  /** Part 65 — moderate per-key tier for the public REST surface. */
  readonly apiKeyRateLimitPerMinute: number;
  /**
   * Part 73 — custom domains. OFF BY DEFAULT, and the switch is real rather
   * than cosmetic: with it false the domain routes 404, the trusted-host
   * middleware is never installed, and no host but the configured ones is
   * accepted. A deployment without a wildcard-capable reverse proxy in front of
   * it cannot serve tenant hostnames, and half-enabling the feature would mean
   * telling an administrator to point DNS at an address that answers with the
   * wrong certificate.
   */
  readonly customDomainsEnabled: boolean;
  /**
   * The CNAME target administrators publish. Defaults to the APP_URL host,
   * which is right for the single-host topology; a deployment that terminates
   * tenant TLS on a separate edge names that edge here.
   */
  readonly customDomainCnameTarget: string;
}

export function parseAppConfig(environment: Environment): AppConfig {
  try {
    const nodeEnv = readEnum(environment, "NODE_ENV", NODE_ENVIRONMENTS, "development");
    const apiHost = readHost(
      environment,
      "API_HOST",
      nodeEnv === "production" ? undefined : "127.0.0.1",
    );

    const appUrl = readUrl(environment, "APP_URL", {
      allowedProtocols: ["http:", "https:"],
      fallback: nodeEnv === "production" ? undefined : "http://localhost:3000",
      originOnly: true,
      required: nodeEnv === "production",
    });
    const apiUrl = readUrl(environment, "API_URL", {
      allowedProtocols: ["http:", "https:"],
      fallback: nodeEnv === "production" ? undefined : "http://localhost:3001",
      originOnly: true,
      required: nodeEnv === "production",
    });
    const websocketUrl = readUrl(environment, "WS_URL", {
      allowedProtocols: ["ws:", "wss:"],
      fallback: nodeEnv === "production" ? undefined : "ws://localhost:3001",
      originOnly: true,
      required: nodeEnv === "production",
    });
    if (
      nodeEnv === "production" &&
      (appUrl.protocol !== "https:" ||
        apiUrl.protocol !== "https:" ||
        websocketUrl.protocol !== "wss:")
    ) {
      throw new Error("APP_URL, API_URL, and WS_URL must use HTTPS/WSS in production");
    }

    const customDomainsEnabled = readBoolean(environment, "CUSTOM_DOMAINS_ENABLED", false);
    const customDomainCnameTarget = (
      readOptionalString(environment, "CUSTOM_DOMAIN_CNAME_TARGET") ?? appUrl.hostname
    ).toLowerCase();
    if (customDomainCnameTarget.length > 253 || !HOSTNAME_PATTERN.test(customDomainCnameTarget)) {
      throw new Error("CUSTOM_DOMAIN_CNAME_TARGET must be a hostname without a protocol or port");
    }
    // A tenant cannot CNAME to a name that only resolves on our own machine, so
    // a loopback target in production is a misconfiguration that would make
    // every verification fail with a message about the tenant's DNS.
    if (
      nodeEnv === "production" &&
      (customDomainCnameTarget === "localhost" ||
        customDomainCnameTarget.endsWith(".localhost") ||
        /^\d+(?:\.\d+){3}$/u.test(customDomainCnameTarget))
    ) {
      throw new Error("CUSTOM_DOMAIN_CNAME_TARGET must be a public hostname in production");
    }

    return Object.freeze({
      nodeEnv,
      apiHost,
      apiPort: readInteger(environment, "API_PORT", 3001, 1, 65_535),
      appUrl,
      apiUrl,
      websocketUrl,
      logLevel: readEnum(environment, "LOG_LEVEL", LOG_LEVELS, "info"),
      trustProxyHops: readInteger(environment, "TRUST_PROXY_HOPS", 0, 0, 16),
      requestBodyLimitBytes: readInteger(
        environment,
        "REQUEST_BODY_LIMIT_BYTES",
        1_048_576,
        1_024,
        10_485_760,
      ),
      unauthenticatedRateLimitPerMinute: readInteger(
        environment,
        "RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE",
        60,
        1,
        100_000,
      ),
      authenticatedRateLimitPerMinute: readInteger(
        environment,
        "RATE_LIMIT_AUTHENTICATED_PER_MINUTE",
        1_000,
        1,
        1_000_000,
      ),
      sensitiveRateLimitPerMinute: readInteger(
        environment,
        "RATE_LIMIT_SENSITIVE_PER_MINUTE",
        10,
        1,
        10_000,
      ),
      authRateLimitPerMinute: readInteger(environment, "RATE_LIMIT_AUTH_PER_MINUTE", 5, 1, 10_000),
      apiKeyRateLimitPerMinute: readInteger(
        environment,
        "RATE_LIMIT_API_KEY_PER_MINUTE",
        100,
        1,
        1_000_000,
      ),
      customDomainsEnabled,
      customDomainCnameTarget,
    });
  } catch (error: unknown) {
    wrapConfigError("Invalid API environment configuration", error);
  }
}

@Injectable()
export class AppConfigProvider {
  readonly value = parseAppConfig(process.env);
}

export const appConfigProvider: Provider<AppConfig> = {
  provide: APP_CONFIG,
  inject: [AppConfigProvider],
  useFactory: (provider: AppConfigProvider): AppConfig => provider.value,
};
