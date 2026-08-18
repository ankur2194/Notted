import { describe, expect, it } from "vitest";

import {
  API_KEY_SECRET_PATTERN,
  apiKeyCreateResultSchema,
  apiKeyListQuerySchema,
  apiKeyScopesSchema,
  apiKeySecretSchema,
  apiKeySummarySchema,
  createApiKeySchema,
} from "./api-key.schema";

const uuid = "30000000-0000-4000-8000-000000000001";
const secret = "ntd_pk_abcdefghijklmnopqrstuvwxyz012345";

describe("api key schemas", () => {
  it("accepts a well-formed secret and rejects lookalikes", () => {
    expect(apiKeySecretSchema.safeParse(secret).success).toBe(true);
    expect(API_KEY_SECRET_PATTERN.test(secret)).toBe(true);
    expect(apiKeySecretSchema.safeParse(`${secret}x`).success).toBe(false);
    expect(apiKeySecretSchema.safeParse("ntd_pk_short").success).toBe(false);
    expect(apiKeySecretSchema.safeParse(`nope_pk_${secret.slice(7)}`).success).toBe(false);
  });

  it("defaults create scopes to read+write and rejects empty or duplicate scopes", () => {
    const parsed = createApiKeySchema.parse({ name: "CI runner" });
    expect(parsed.scopes).toEqual(["read", "write"]);
    expect(apiKeyScopesSchema.safeParse([]).success).toBe(false);
    expect(apiKeyScopesSchema.safeParse(["read", "read"]).success).toBe(false);
    expect(apiKeyScopesSchema.safeParse(["read", "write", "admin"]).success).toBe(true);
    expect(createApiKeySchema.safeParse({ name: "x", scopes: ["owner"] }).success).toBe(false);
  });

  it("rejects a non-future expiry and unknown body keys", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(createApiKeySchema.safeParse({ name: "x", expiresAt: past }).success).toBe(false);
    expect(createApiKeySchema.safeParse({ name: "x", expiresAt: future }).success).toBe(true);
    expect(createApiKeySchema.safeParse({ name: "x", workspaceId: uuid }).success).toBe(false);
  });

  it("applies list-query defaults and coerces query-string values", () => {
    const parsed = apiKeyListQuerySchema.parse({ page: "2", includeRevoked: "true" });
    expect(parsed).toMatchObject({ page: 2, limit: 25, includeRevoked: true, sortBy: "createdAt" });
    expect(parsed.sortDirection).toBe("desc");
    expect(apiKeyListQuerySchema.safeParse({ includeRevoked: "yes" }).success).toBe(false);
    expect(apiKeyListQuerySchema.safeParse({ page: "20000" }).success).toBe(false);
    expect(apiKeyListQuerySchema.safeParse({ workspaceId: uuid }).success).toBe(false);
  });

  it("never accepts a key hash in a projected summary", () => {
    const summary = {
      id: uuid,
      workspaceId: uuid,
      name: "CI runner",
      keyPrefix: "ntd_pk_a",
      scopes: ["read"],
      lastUsedAt: null,
      expiresAt: null,
      isRevoked: false,
      createdById: uuid,
      createdAt: new Date().toISOString(),
    };
    expect(apiKeySummarySchema.safeParse(summary).success).toBe(true);
    expect(apiKeySummarySchema.safeParse({ ...summary, keyHash: "deadbeef" }).success).toBe(false);
    expect(apiKeyCreateResultSchema.safeParse({ apiKey: summary, secret }).success).toBe(true);
    expect(apiKeyCreateResultSchema.safeParse({ apiKey: summary, secret: "plain" }).success).toBe(
      false,
    );
  });
});
