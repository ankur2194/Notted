import { API_KEY_PREFIX_LENGTH, API_KEY_SECRET_PATTERN } from "@notted/shared-validators";
import { describe, expect, it } from "vitest";

import { formatScopes, generateApiKeySecret, hashApiKey, parseScopes } from "./api-key-secret";
import { API_KEY_PREFIX } from "./api-keys.constants";

const PEPPER = "pepper-one-0000000000000000000000";
const OTHER_PEPPER = "pepper-two-0000000000000000000000";

describe("generateApiKeySecret", () => {
  it("emits a secret in the published wire format", () => {
    const { raw } = generateApiKeySecret();
    expect(raw.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(API_KEY_SECRET_PATTERN.test(raw)).toBe(true);
  });

  it("emits a display prefix that fits key_prefix varchar(8)", () => {
    const { raw, prefix } = generateApiKeySecret();
    expect(prefix).toHaveLength(API_KEY_PREFIX_LENGTH);
    expect(prefix).toHaveLength(8);
    expect(raw.startsWith(prefix)).toBe(true);
    // The prefix must not be able to authenticate on its own.
    expect(prefix.length).toBeLessThan(raw.length);
  });

  it("never repeats a secret", () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateApiKeySecret().raw));
    expect(secrets.size).toBe(50);
  });
});

describe("hashApiKey", () => {
  it("is deterministic for the same secret and pepper, so the unique index is the lookup", () => {
    const { raw } = generateApiKeySecret();
    expect(hashApiKey(raw, PEPPER)).toBe(hashApiKey(raw, PEPPER));
  });

  it("produces 64 hex characters and never embeds the secret", () => {
    const { raw } = generateApiKeySecret();
    const hash = hashApiKey(raw, PEPPER);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(hash).not.toBe(raw);
    expect(hash).not.toContain(raw);
    expect(hash).not.toContain(raw.slice(API_KEY_PREFIX.length));
  });

  it("separates peppers, so rotating BETTER_AUTH_SECRET invalidates every issued key", () => {
    const { raw } = generateApiKeySecret();
    expect(hashApiKey(raw, PEPPER)).not.toBe(hashApiKey(raw, OTHER_PEPPER));
  });

  it("separates secrets under one pepper", () => {
    expect(hashApiKey(generateApiKeySecret().raw, PEPPER)).not.toBe(
      hashApiKey(generateApiKeySecret().raw, PEPPER),
    );
  });
});

describe("scope encoding", () => {
  it("round-trips the stored CSV", () => {
    expect(parseScopes("read,write")).toEqual(["read", "write"]);
    expect(formatScopes(["read", "write", "admin"])).toBe("read,write,admin");
    expect(parseScopes(formatScopes(["admin"]))).toEqual(["admin"]);
  });

  it("tolerates whitespace and empty segments", () => {
    expect(parseScopes(" read , write ,")).toEqual(["read", "write"]);
    expect(parseScopes("")).toEqual([]);
    expect(parseScopes(",,")).toEqual([]);
  });

  it("drops unknown tokens rather than passing them through", () => {
    // A hand-edited or corrupt row must be able to narrow permission, never to
    // widen it, and must not turn every request with that key into a 500.
    expect(parseScopes("read,superuser")).toEqual(["read"]);
    expect(parseScopes("owner,*,admin")).toEqual(["admin"]);
    expect(parseScopes("nonsense")).toEqual([]);
    expect(parseScopes("READ")).toEqual([]);
  });

  it("collapses duplicates so the result always satisfies the uniqueness rule", () => {
    expect(parseScopes("read,read,write")).toEqual(["read", "write"]);
  });
});
