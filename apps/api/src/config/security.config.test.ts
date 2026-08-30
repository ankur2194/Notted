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

  /*
   * The error an operator reads is the whole value of a startup check. A
   * colonless entry used to reach the base64 length test on a version string
   * `indexOf(":") === -1` had silently truncated, so `123456` — a key pasted
   * without its `version:` prefix — failed with "must decode to exactly 32
   * bytes", pointing at the key material instead of the missing prefix.
   */
  it("names the missing version prefix rather than the key length", () => {
    expect(() => parseSecurityConfig({ DATA_ENCRYPTION_KEYS: "123456" })).toThrow(
      /must use version:base64 entries/u,
    );
    expect(() =>
      parseSecurityConfig({ DATA_ENCRYPTION_KEYS: PRODUCTION_KEY.slice(2) }),
    ).toThrow(/must use version:base64 entries/u);
    // A well-formed entry still parses, and a genuinely short key still gets
    // the length message.
    expect(parseSecurityConfig({ DATA_ENCRYPTION_KEYS: PRODUCTION_KEY }).encryptionKeys).toHaveLength(1);
    expect(() => parseSecurityConfig({ DATA_ENCRYPTION_KEYS: "1:c2hvcnQ=" })).toThrow(
      /decode to exactly 32 bytes/u,
    );
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
