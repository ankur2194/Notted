import { describe, expect, it } from "vitest";

import { parseAiConfig } from "./ai.config";
import { parseAuthConfig } from "./auth.config";
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
      () => parseAiConfig({ FEATURE_AI_ENABLED: "true" }),
      "at least one AI provider key is required",
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
});
