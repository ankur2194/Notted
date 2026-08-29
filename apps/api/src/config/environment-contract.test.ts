import { describe, expect, it } from "vitest";

import { parseAiConfig } from "./ai.config";
import { parseAppConfig } from "./app.config";
import { parseAuthConfig } from "./auth.config";
import { parseExportConfig } from "./export.config";
import { parseFeaturesConfig } from "./features.config";
import { parseImageProcessingConfig } from "./image-processing.config";
import { parseMeilisearchConfig } from "./meilisearch.config";
import { parseMinioConfig } from "./minio.config";
import { parseRedisConfig } from "./redis.config";
import { parseSecurityConfig } from "./security.config";
import { parseSmtpConfig } from "./smtp.config";
import { environmentForValidation, validateApiEnvironment } from "./validate-api-environment";

describe("server environment contract", () => {
  it("supplies development defaults and freezes every configuration object", () => {
    const configs = [
      parseFeaturesConfig({}),
      parseRedisConfig({}),
      parseMinioConfig({}),
      parseMeilisearchConfig({}),
      parseSmtpConfig({}),
      parseAuthConfig({}),
      parseSecurityConfig({}),
      parseImageProcessingConfig({}),
      parseAiConfig({}),
      parseExportConfig({}),
    ];

    expect(configs.every(Object.isFrozen)).toBe(true);
    expect(parseFeaturesConfig({})).toEqual({
      redisEnabled: true,
      storageEnabled: true,
      searchEnabled: true,
      emailEnabled: true,
      aiEnabled: false,
      registrationEnabled: true,
      realtimeEnabled: true,
      collaborationEnabled: true,
    });
    expect(parseRedisConfig({}).url).toBe("redis://127.0.0.1:6379");
    expect(parseMinioConfig({}).attachmentsBucket).toBe("notted-attachments");
    expect(parseMeilisearchConfig({}).host).toBe("http://127.0.0.1:7700");
    expect(parseSmtpConfig({}).port).toBe(1025);
    expect(parseSecurityConfig({}).maximumUploadBytes).toBe(50 * 1_024 * 1_024);
    // Part 41: every image budget must have a safe default so
    // `env:validate --production` passes with none of them set.
    expect(parseImageProcessingConfig({})).toEqual({
      maximumImageUploadBytes: 15 * 1_024 * 1_024,
      maximumImagePixels: 50_000_000,
      maximumAnimationFrames: 400,
      processingTimeoutMs: 20_000,
      maximumSvgSourceBytes: 2 * 1_024 * 1_024,
      maximumHeicUploadBytes: 8 * 1_024 * 1_024,
      heicDecodeTimeoutMs: 10_000,
    });
    expect(parseAiConfig({})).toEqual({
      enabled: false,
      requestTimeoutMs: 120_000,
      openAi: undefined,
      claude: undefined,
      embeddings: {
        enabled: false,
        provider: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        model: "text-embedding-3-small",
        dimensions: 1536,
        maxSourceCharacters: 24_000,
        requestTimeoutMs: 30_000,
      },
    });
    expect(parseExportConfig({})).toEqual({
      chromiumPath: null,
      renderTimeoutMs: 30_000,
      maxArtifactBytes: 26_214_400,
    });
  });

  it("forces production semantics for the production validation preflight", () => {
    const environment = environmentForValidation({}, true);

    expect(environment.NODE_ENV).toBe("production");
    expect(() => validateApiEnvironment(environment)).toThrowError(
      "Invalid API environment configuration: API_HOST is required",
    );
  });

  it("accepts a display name in the configured sender mailbox", () => {
    expect(parseSmtpConfig({ EMAIL_FROM: "Notted <noreply@example.com>" }).from).toBe(
      "Notted <noreply@example.com>",
    );
  });

  it("accepts complete production dependency and secret configuration", () => {
    const environment = {
      NODE_ENV: "production",
      FEATURE_REDIS_ENABLED: "true",
      FEATURE_STORAGE_ENABLED: "true",
      FEATURE_SEARCH_ENABLED: "true",
      FEATURE_EMAIL_ENABLED: "true",
      FEATURE_AI_ENABLED: "true",
      REDIS_URL: "rediss://app:redis-secret-with-16-bytes@cache.internal:6379",
      MINIO_ENDPOINT: "objects.internal",
      MINIO_PORT: "9443",
      MINIO_USE_SSL: "true",
      MINIO_ACCESS_KEY: "service-account",
      MINIO_SECRET_KEY: "a-strong-storage-secret-with-32-bytes",
      MEILISEARCH_HOST: "https://search.internal",
      MEILISEARCH_API_KEY: "a-strong-search-master-key-with-32-bytes",
      EMAIL_SMTP_HOST: "smtp.internal",
      EMAIL_SMTP_PORT: "465",
      EMAIL_SMTP_SECURE: "true",
      EMAIL_SMTP_USER: "mailer",
      EMAIL_SMTP_PASSWORD: "smtp-password-with-16-bytes",
      EMAIL_FROM: "noreply@example.com",
      BETTER_AUTH_SECRET: "a-strong-auth-secret-that-is-long-enough",
      BETTER_AUTH_URL: "https://api.example.com",
      APP_URL: "https://app.example.com",
      BETTER_AUTH_TRUSTED_ORIGINS: "https://app.example.com",
      DATA_ENCRYPTION_KEYS: "7:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      AI_OPENAI_API_KEY: "sk-example-key-longer-than-twenty-bytes",
      AI_OPENAI_MODEL: "gpt-example",
    } as const;

    expect(parseRedisConfig(environment).url).toBe(environment.REDIS_URL);
    expect(parseMinioConfig(environment)).toMatchObject({
      endPoint: "objects.internal",
      port: 9443,
      useSsl: true,
    });
    expect(parseMeilisearchConfig(environment).host).toBe("https://search.internal");
    expect(parseSmtpConfig(environment)).toMatchObject({
      host: "smtp.internal",
      port: 465,
      secure: true,
      user: "mailer",
    });
    expect(parseAuthConfig(environment).baseUrl.origin).toBe("https://api.example.com");
    expect(parseSecurityConfig(environment).activeEncryptionKeyVersion).toBe(7);
    expect(parseAiConfig(environment).openAi?.model).toBe("gpt-example");
  });

  it.each([
    [() => parseFeaturesConfig({ FEATURE_SEARCH_ENABLED: "yes" }), "must be either true or false"],
    [() => parseRedisConfig({ NODE_ENV: "production" }), "REDIS_URL is required"],
    [
      () =>
        parseRedisConfig({
          NODE_ENV: "production",
          REDIS_URL: "rediss://app:short@cache.internal:6379",
        }),
      "strong non-placeholder password",
    ],
    [() => parseRedisConfig({ REDIS_URL: "http://localhost:6379" }), "redis or rediss"],
    [
      () => parseMinioConfig({ MINIO_BUCKET_ATTACHMENTS: "Invalid_Bucket" }),
      "DNS-compatible bucket",
    ],
    [() => parseMeilisearchConfig({ MEILISEARCH_API_KEY: "short" }), "at least 16 bytes"],
    [
      () => parseSmtpConfig({ EMAIL_SMTP_USER: "user-only" }),
      "EMAIL_SMTP_USER and EMAIL_SMTP_PASSWORD",
    ],
    [
      () =>
        parseSmtpConfig({
          NODE_ENV: "production",
          FEATURE_EMAIL_ENABLED: "true",
          EMAIL_SMTP_HOST: "smtp.internal",
          EMAIL_FROM: "noreply@example.com",
        }),
      "required when email is enabled in production",
    ],
    [() => parseSmtpConfig({ EMAIL_FROM: "not-an-address" }), "valid mailbox"],
    [() => parseAuthConfig({ BETTER_AUTH_SECRET: "short" }), "at least 32 bytes"],
    [
      () => parseSecurityConfig({ DATA_ENCRYPTION_KEYS: "1:c2hvcnQ=" }),
      "decode to exactly 32 bytes",
    ],
    [
      () => parseAiConfig({ AI_REQUEST_TIMEOUT_MS: "0" }),
      "AI_REQUEST_TIMEOUT_MS must be an integer",
    ],
    [
      () => parseImageProcessingConfig({ MAX_IMAGE_PIXELS: "500" }),
      "Invalid image processing configuration",
    ],
    [
      () => parseImageProcessingConfig({ IMAGE_PROCESSING_TIMEOUT_MS: "twenty-seconds" }),
      "IMAGE_PROCESSING_TIMEOUT_MS must be an integer",
    ],
    [
      () => parseImageProcessingConfig({ MAX_IMAGE_ANIMATION_FRAMES: "0" }),
      "MAX_IMAGE_ANIMATION_FRAMES must be an integer",
    ],
    [
      // The image ceiling can only be lowered by the generic transport ceiling,
      // never raised above it.
      () =>
        parseImageProcessingConfig({
          MAX_UPLOAD_SIZE_BYTES: String(4 * 1_024 * 1_024),
          MAX_IMAGE_UPLOAD_BYTES: String(32 * 1_024 * 1_024),
        }),
      "MAX_IMAGE_UPLOAD_BYTES must be an integer",
    ],
    [
      () => parseExportConfig({ EXPORT_CHROMIUM_PATH: "relative/chromium" }),
      "EXPORT_CHROMIUM_PATH must be an absolute path",
    ],
    [() => parseExportConfig({ EXPORT_RENDER_TIMEOUT_MS: "999" }), "Invalid export configuration"],
  ])("rejects invalid environment input without accepting coercion", (parse, message) => {
    expect(parse).toThrowError(message);
  });

  it("lowers the image ceiling with the generic upload ceiling", () => {
    const lowered = parseImageProcessingConfig({
      MAX_UPLOAD_SIZE_BYTES: String(4 * 1_024 * 1_024),
    });

    expect(lowered.maximumImageUploadBytes).toBe(4 * 1_024 * 1_024);
    expect(parseImageProcessingConfig({ MAX_IMAGE_PIXELS: "1000000" }).maximumImagePixels).toBe(
      1_000_000,
    );
  });

  it("does not include secret values in validation errors", () => {
    const secrets = ["smtp-secret-value", "tiny-meili-secret", "tiny-auth-secret"];
    const actions = [
      () =>
        parseSmtpConfig({
          EMAIL_SMTP_PASSWORD: secrets[0],
        }),
      () => parseMeilisearchConfig({ MEILISEARCH_API_KEY: secrets[1] }),
      () => parseAuthConfig({ BETTER_AUTH_SECRET: secrets[2] }),
    ];

    actions.forEach((action, index) => {
      let message = "";
      try {
        action();
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toContain(secrets[index]);
    });
  });

  it("allows disabled optional integrations in production without credentials", () => {
    const environment = {
      NODE_ENV: "production",
      FEATURE_STORAGE_ENABLED: "false",
      FEATURE_SEARCH_ENABLED: "false",
      FEATURE_EMAIL_ENABLED: "false",
      FEATURE_REDIS_ENABLED: "false",
    } as const;

    expect(parseRedisConfig(environment).enabled).toBe(false);
    expect(parseMinioConfig(environment).enabled).toBe(false);
    expect(parseMeilisearchConfig(environment).enabled).toBe(false);
    expect(parseSmtpConfig(environment).enabled).toBe(false);
  });

  // Part 73 — custom domains ship OFF, and the CNAME target defaults to the
  // APP_URL host so a single-host deployment needs no extra variable at all.
  it("defaults custom domains off with the APP_URL host as the CNAME target", () => {
    expect(parseAppConfig({}).customDomainsEnabled).toBe(false);
    expect(parseAppConfig({}).customDomainCnameTarget).toBe("localhost");
    expect(
      parseAppConfig({ APP_URL: "https://App.Example.test", CUSTOM_DOMAINS_ENABLED: "true" }),
    ).toMatchObject({ customDomainsEnabled: true, customDomainCnameTarget: "app.example.test" });
    expect(
      parseAppConfig({ CUSTOM_DOMAIN_CNAME_TARGET: "Edge.Example.test" }).customDomainCnameTarget,
    ).toBe("edge.example.test");
  });

  it("ships metrics off and refuses a weak metrics token in production", () => {
    // `null` is what makes `GET /metrics` answer 404 rather than exposing the
    // endpoint before an operator has configured it.
    expect(parseAppConfig({}).metricsToken).toBeNull();
    expect(parseAppConfig({ METRICS_TOKEN: "  " }).metricsToken).toBeNull();
    expect(parseAppConfig({ METRICS_TOKEN: " scrape-token " }).metricsToken).toBe("scrape-token");

    const production = {
      NODE_ENV: "production",
      API_HOST: "0.0.0.0",
      APP_URL: "https://app.example.test",
      API_URL: "https://api.example.test",
      WS_URL: "wss://api.example.test",
      // Required in production since the TRUST_PROXY_HOPS check below; carried
      // here so this test still measures the metrics token and nothing else.
      TRUST_PROXY_HOPS: "1",
    } as const;

    expect(() => parseAppConfig({ ...production, METRICS_TOKEN: "short-token" })).toThrow(
      "METRICS_TOKEN",
    );
    // Unset stays valid in production: the endpoint is simply off.
    expect(parseAppConfig(production).metricsToken).toBeNull();
    expect(parseAppConfig({ ...production, METRICS_TOKEN: "a".repeat(32) }).metricsToken).toBe(
      "a".repeat(32),
    );
    // A short value outside production is a developer convenience, not a risk.
    expect(parseAppConfig({ METRICS_TOKEN: "dev" }).metricsToken).toBe("dev");
  });

  it("rejects a malformed or loopback CNAME target", () => {
    expect(() => parseAppConfig({ CUSTOM_DOMAIN_CNAME_TARGET: "https://edge.example" })).toThrow(
      "CUSTOM_DOMAIN_CNAME_TARGET",
    );
    expect(() => parseAppConfig({ CUSTOM_DOMAIN_CNAME_TARGET: "edge.example:443" })).toThrow(
      "CUSTOM_DOMAIN_CNAME_TARGET",
    );
    // A tenant cannot CNAME to a name that only resolves on our own machine.
    expect(() =>
      parseAppConfig({
        NODE_ENV: "production",
        API_HOST: "0.0.0.0",
        APP_URL: "https://app.example.test",
        API_URL: "https://api.example.test",
        WS_URL: "wss://api.example.test",
        CUSTOM_DOMAIN_CNAME_TARGET: "localhost",
      }),
    ).toThrow("CUSTOM_DOMAIN_CNAME_TARGET must be a public hostname in production");
  });

  it("refuses TRUST_PROXY_HOPS=0 in production, where there is always a proxy", () => {
    const production = {
      NODE_ENV: "production",
      API_HOST: "0.0.0.0",
      APP_URL: "https://app.example.test",
      API_URL: "https://api.example.test",
      WS_URL: "wss://api.example.test",
    } as const;

    /*
     * Zero is the default, and in production it is always wrong: APP_URL/API_URL
     * are required to be https/wss while this process serves plain HTTP, so TLS
     * is terminated in front of it and there is at least one hop. At zero,
     * `main.ts` disables `trust proxy` and every rate-limit tier collapses into
     * one bucket keyed by the proxy's address, every audit row records the
     * proxy, and `X-Forwarded-Host` is ignored so custom domains answer 421.
     *
     * The check is "not zero" rather than "must be set" on purpose:
     * `apps/api/.env.example` ships TRUST_PROXY_HOPS=0, so a
     * presence-only check would be satisfied by the value that is wrong.
     */
    expect(() => parseAppConfig(production)).toThrow(
      "TRUST_PROXY_HOPS must be at least 1 in production",
    );
    expect(parseAppConfig({ ...production, TRUST_PROXY_HOPS: "1" }).trustProxyHops).toBe(1);
    expect(parseAppConfig({ ...production, TRUST_PROXY_HOPS: "2" }).trustProxyHops).toBe(2);
    // Outside production, zero is the correct default: no proxy is in front.
    expect(parseAppConfig({}).trustProxyHops).toBe(0);
  });

  // Part 74 — authentication rate-limit and account-lockout defaults.
  it("defaults the authentication rate-limit and lockout thresholds", () => {
    expect(parseAppConfig({}).authRateLimitPerMinute).toBe(5);
    expect(parseAuthConfig({}).lockoutAttempts).toBe(10);
    expect(parseAuthConfig({}).lockoutSeconds).toBe(900);
  });

  it.each([
    [
      () => parseAppConfig({ RATE_LIMIT_AUTH_PER_MINUTE: "0" }),
      "RATE_LIMIT_AUTH_PER_MINUTE must be an integer between 1 and 10000",
    ],
    [
      () => parseAuthConfig({ AUTH_LOCKOUT_ATTEMPTS: "2" }),
      "AUTH_LOCKOUT_ATTEMPTS must be an integer between 3 and 100",
    ],
    [
      () => parseAuthConfig({ AUTH_LOCKOUT_SECONDS: "30" }),
      "AUTH_LOCKOUT_SECONDS must be an integer between 60 and 86400",
    ],
  ])("rejects an out-of-range Part 74 threshold", (parse, message) => {
    expect(parse).toThrowError(message);
  });
});
