import { describe, expect, it } from "vitest";

import { parseSecurityConfig } from "./security.config";

const PRODUCTION_KEY = "1:BAsSGSAnLjU8Q0pRWF9mbXR7gomQl56lrLO6wcjP1t0=";

describe("security configuration", () => {
  it("refuses to read WEBHOOK_ALLOW_INSECURE_URLS in production", () => {
    // The flag unblocks `http:` and loopback delivery. A production deployment
    // that inherited a development environment file — or a copy-pasted `=true`
    // — must not gain that, so production never consults the variable at all.
    const value = parseSecurityConfig({
      NODE_ENV: "production",
      DATA_ENCRYPTION_KEYS: PRODUCTION_KEY,
      WEBHOOK_ALLOW_INSECURE_URLS: "true",
    });
    expect(value.webhookAllowInsecureUrls).toBe(false);

    // Outside production the same variable is honoured, which is what lets an
    // integration test target an in-process receiver on 127.0.0.1.
    expect(
      parseSecurityConfig({ WEBHOOK_ALLOW_INSECURE_URLS: "true" }).webhookAllowInsecureUrls,
    ).toBe(true);
    expect(parseSecurityConfig({}).webhookAllowInsecureUrls).toBe(false);
  });

  it("bounds the outbound webhook request timeout", () => {
    expect(parseSecurityConfig({}).webhookRequestTimeoutMs).toBe(10_000);
    expect(
      parseSecurityConfig({ WEBHOOK_REQUEST_TIMEOUT_MS: "1000" }).webhookRequestTimeoutMs,
    ).toBe(1_000);
    // Out of range fails startup rather than being clamped: a 100ms timeout
    // would fail every honest receiver, and a 60s one would pin a worker.
    expect(() => parseSecurityConfig({ WEBHOOK_REQUEST_TIMEOUT_MS: "999" })).toThrow();
    expect(() => parseSecurityConfig({ WEBHOOK_REQUEST_TIMEOUT_MS: "30001" })).toThrow();
  });
});
