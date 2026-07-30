import { describe, expect, it } from "vitest";

import { parseAuthConfig } from "./auth.config";

describe("auth configuration", () => {
  it("requires CORS/application origin reconciliation", () => {
    expect(() =>
      parseAuthConfig({
        APP_URL: "https://app.example.test",
        BETTER_AUTH_URL: "https://api.example.test",
        BETTER_AUTH_TRUSTED_ORIGINS: "https://other.example.test",
      }),
    ).toThrow("must include APP_URL");
  });

  it("accepts explicit secure production auth configuration", () => {
    const config = parseAuthConfig({
      NODE_ENV: "production",
      APP_URL: "https://app.example.test",
      API_URL: "https://api.example.test",
      BETTER_AUTH_URL: "https://api.example.test",
      BETTER_AUTH_SECRET: "a-production-auth-secret-that-is-long-enough-123",
      BETTER_AUTH_TRUSTED_ORIGINS: "https://app.example.test",
    });
    expect(config.basePath).toBe("/api/auth");
    expect(config.magicLinkTokenTtlSeconds).toBe(900);
    expect(config.passkeyRpId).toBe("app.example.test");
    expect(config.passkeyOrigins).toEqual(["https://app.example.test"]);
    expect(config.enabledOAuthProviders).toEqual([]);
  });

  it.each([
    [{ AUTH_OAUTH_GOOGLE_CLIENT_ID: "provider-key-value-xyz" }, "GOOGLE"],
    [{ AUTH_OAUTH_GITHUB_CLIENT_SECRET: "provider-key-value-xyz" }, "GITHUB"],
    [
      {
        AUTH_OAUTH_MICROSOFT_CLIENT_ID: "provider-key-value-xyz",
        AUTH_OAUTH_MICROSOFT_CLIENT_SECRET: "provider-key-value-xyz",
      },
      "MICROSOFT",
    ],
  ])(
    "rejects partial OAuth credential tuples without reflecting values",
    (environment, provider) => {
      let message = "";
      try {
        parseAuthConfig(environment);
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain(provider);
      // The supplied placeholder must never be echoed back; the message is a
      // fixed "must be configured together" string, so assert against the token
      // rather than the word "configured" that legitimately appears there.
      expect(message).not.toContain("provider-key-value-xyz");
    },
  );

  it("enables only providers with complete credential tuples", () => {
    const secret = ["generated", crypto.randomUUID()].join("-");
    const config = parseAuthConfig({
      AUTH_OAUTH_GOOGLE_CLIENT_ID: "google-client",
      AUTH_OAUTH_GOOGLE_CLIENT_SECRET: secret,
      AUTH_OAUTH_MICROSOFT_CLIENT_ID: "microsoft-client",
      AUTH_OAUTH_MICROSOFT_CLIENT_SECRET: secret,
      AUTH_OAUTH_MICROSOFT_TENANT_ID: "tenant",
    });
    expect(config.enabledOAuthProviders).toEqual(["google", "microsoft"]);
    expect(config.oauth.github).toBeUndefined();
  });

  it("rejects insecure or RP-mismatched WebAuthn origins", () => {
    expect(() =>
      parseAuthConfig({
        APP_URL: "http://app.example.test",
        BETTER_AUTH_TRUSTED_ORIGINS: "http://app.example.test",
      }),
    ).toThrow("HTTPS");
    expect(() =>
      parseAuthConfig({
        AUTH_PASSKEY_RP_ID: "other.example.test",
      }),
    ).toThrow("parent domain");
    expect(() =>
      parseAuthConfig({
        NODE_ENV: "production",
        APP_URL: "https://localhost",
        API_URL: "https://api.example.test",
        BETTER_AUTH_URL: "https://api.example.test",
        BETTER_AUTH_SECRET: "a-production-auth-secret-that-is-long-enough-123",
        BETTER_AUTH_TRUSTED_ORIGINS: "https://localhost",
        AUTH_PASSKEY_RP_ID: "localhost",
      }),
    ).toThrow("non-local hostname in production");
  });
});
