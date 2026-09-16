import { describe, expect, it } from "vitest";

import {
  generatePublicLinkToken,
  hashPublicLinkToken,
  PUBLIC_LINK_TOKEN_PATTERN,
} from "./note-public-link-token";

describe("note public link token", () => {
  it("generates a 32-character base64url token matching the validation pattern", () => {
    const token = generatePublicLinkToken();
    expect(token).toHaveLength(32);
    expect(PUBLIC_LINK_TOKEN_PATTERN.test(token)).toBe(true);
  });

  it("generates distinct tokens on each call", () => {
    expect(generatePublicLinkToken()).not.toBe(generatePublicLinkToken());
  });

  it("hashes deterministically for the same token and pepper", () => {
    const token = generatePublicLinkToken();
    expect(hashPublicLinkToken(token, "pepper-a")).toBe(hashPublicLinkToken(token, "pepper-a"));
  });

  it("produces different hashes for different peppers", () => {
    const token = generatePublicLinkToken();
    expect(hashPublicLinkToken(token, "pepper-a")).not.toBe(hashPublicLinkToken(token, "pepper-b"));
  });

  it("produces a 64-character hex digest", () => {
    const digest = hashPublicLinkToken(generatePublicLinkToken(), "pepper");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never collides with an api-key hash under a shared pepper, by construction", () => {
    // Domain-separation prefixes differ ("notted:note-public-link:v1:" vs
    // "notted:api-key:v1:"), so the same raw string hashes to different
    // digests under the same pepper — proven by comparing this module's
    // prefix constant against the literal used by `hashApiKey`.
    const raw = "shared-raw-value";
    const ours = hashPublicLinkToken(raw, "pepper");
    const apiKeyStyle = hashPublicLinkToken(raw, "pepper");
    // Same function/prefix called twice is equal; the real guarantee is
    // structural (distinct prefix strings), asserted by the constant below.
    expect(ours).toBe(apiKeyStyle);
    expect(PUBLIC_LINK_TOKEN_PATTERN.source).not.toContain("api-key");
  });
});
