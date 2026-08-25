import { describe, expect, it, vi } from "vitest";

import { verifyDomain, verificationRecordName, verificationRecordValue } from "./domain-verifier";

import type { DomainDnsResolver } from "./domain-verifier";

const HOST = "notes.acme.com";
const TARGET = "edge.notted.test";
const TOKEN = "0123456789abcdef0123456789abcdef";

function resolver(overrides: Partial<DomainDnsResolver> = {}): DomainDnsResolver {
  return {
    resolveTxt: vi.fn(async () => [[`notted-verify=${TOKEN}`]]),
    resolveCname: vi.fn(async () => [TARGET]),
    lookup: vi.fn(async () => [{ address: "203.0.113.10" }]),
    ...overrides,
  };
}

describe("verification record rendering", () => {
  it("publishes the token under the _notted-verify label", () => {
    expect(verificationRecordName(HOST)).toBe("_notted-verify.notes.acme.com");
    expect(verificationRecordValue(TOKEN)).toBe(`notted-verify=${TOKEN}`);
  });
});

describe("verifyDomain", () => {
  const base = { hostname: HOST, token: TOKEN, cnameTarget: TARGET, timeoutMs: 50 };

  it("accepts a matching TXT record plus a CNAME to the configured target", async () => {
    await expect(verifyDomain({ ...base, resolver: resolver() })).resolves.toEqual({ ok: true });
  });

  it("ignores case and a trailing root dot on the CNAME answer", async () => {
    const dns = resolver({ resolveCname: vi.fn(async () => ["EDGE.Notted.Test."]) });
    await expect(verifyDomain({ ...base, resolver: dns })).resolves.toEqual({ ok: true });
  });

  it("rejoins a TXT value split across character-strings", async () => {
    const dns = resolver({
      resolveTxt: vi.fn(async () => [["notted-verify=", TOKEN]]),
    });
    await expect(verifyDomain({ ...base, resolver: dns })).resolves.toEqual({ ok: true });
  });

  it("reports txt_missing when the ownership record does not resolve", async () => {
    const dns = resolver({
      resolveTxt: vi.fn(() => Promise.reject(new Error("ENOTFOUND"))),
    });
    await expect(verifyDomain({ ...base, resolver: dns })).resolves.toEqual({
      ok: false,
      reason: "txt_missing",
    });
  });

  it("reports txt_missing for an empty answer", async () => {
    const dns = resolver({ resolveTxt: vi.fn(async () => []) });
    await expect(verifyDomain({ ...base, resolver: dns })).resolves.toEqual({
      ok: false,
      reason: "txt_missing",
    });
  });

  it("reports txt_mismatch when another workspace's token is published", async () => {
    const dns = resolver({
      resolveTxt: vi.fn(async () => [["notted-verify=deadbeef"]]),
    });
    await expect(verifyDomain({ ...base, resolver: dns })).resolves.toEqual({
      ok: false,
      reason: "txt_mismatch",
    });
  });

  it("reports cname_mismatch when the name is delegated elsewhere", async () => {
    const dns = resolver({
      resolveCname: vi.fn(async () => ["edge.someone-else.test"]),
      lookup: vi.fn(async (hostname: string) =>
        hostname === HOST ? [{ address: "198.51.100.1" }] : [{ address: "203.0.113.10" }],
      ),
    });
    await expect(verifyDomain({ ...base, resolver: dns })).resolves.toEqual({
      ok: false,
      reason: "cname_mismatch",
    });
  });

  it("accepts an apex whose addresses are a subset of the target's", async () => {
    const dns = resolver({
      resolveCname: vi.fn(() => Promise.reject(new Error("ENODATA"))),
      lookup: vi.fn(async (hostname: string) =>
        hostname === HOST
          ? [{ address: "203.0.113.10" }]
          : [{ address: "203.0.113.10" }, { address: "203.0.113.11" }],
      ),
    });
    await expect(verifyDomain({ ...base, resolver: dns })).resolves.toEqual({ ok: true });
  });

  // A host that resolves to us AND somewhere else is not delegated to us.
  it("refuses an apex that also resolves to an address the target does not", async () => {
    const dns = resolver({
      resolveCname: vi.fn(() => Promise.reject(new Error("ENODATA"))),
      lookup: vi.fn(async (hostname: string) =>
        hostname === HOST
          ? [{ address: "203.0.113.10" }, { address: "198.51.100.1" }]
          : [{ address: "203.0.113.10" }],
      ),
    });
    await expect(verifyDomain({ ...base, resolver: dns })).resolves.toEqual({
      ok: false,
      reason: "cname_mismatch",
    });
  });

  it("reports dns_failure when the address fallback cannot resolve at all", async () => {
    const dns = resolver({
      resolveCname: vi.fn(() => Promise.reject(new Error("ENODATA"))),
      lookup: vi.fn(() => Promise.reject(new Error("SERVFAIL"))),
    });
    await expect(verifyDomain({ ...base, resolver: dns })).resolves.toEqual({
      ok: false,
      reason: "dns_failure",
    });
  });

  // The bound is what stops a hung resolver from holding an admin's request
  // open for the platform default, which can be tens of seconds.
  it("treats a resolver that never answers as a missing record", async () => {
    const dns = resolver({ resolveTxt: vi.fn(() => new Promise<string[][]>(() => {})) });
    await expect(verifyDomain({ ...base, resolver: dns, timeoutMs: 10 })).resolves.toEqual({
      ok: false,
      reason: "txt_missing",
    });
  });
});
