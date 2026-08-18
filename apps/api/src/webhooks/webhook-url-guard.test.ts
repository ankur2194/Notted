import { describe, expect, it } from "vitest";

import {
  guardedLookup,
  inspectWebhookUrl,
  isBlockedAddress,
  resolveWebhookHost,
  WEBHOOK_BLOCKED_ERROR_CODE,
  type WebhookDnsLookup,
  type WebhookUrlGuardOptions,
} from "./webhook-url-guard";

const STRICT: WebhookUrlGuardOptions = {
  allowInsecureUrls: false,
  selfHostnames: ["app.notted.test", "api.notted.test"],
};
const RELAXED: WebhookUrlGuardOptions = { allowInsecureUrls: true, selfHostnames: [] };

const PUBLIC_ADDRESS = { address: "93.184.216.34", family: 4 };
const PRIVATE_ADDRESS = { address: "169.254.169.254", family: 4 };
const PUBLIC_V6_ADDRESS = { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 };

describe("inspectWebhookUrl — L1 scheme allow-list", () => {
  it("accepts https", () => {
    const verdict = inspectWebhookUrl("https://ok.example/hook", STRICT);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.url.hostname).toBe("ok.example");
  });

  it("rejects http unless insecure URLs are explicitly allowed", () => {
    expect(inspectWebhookUrl("http://ok.example/hook", STRICT).ok).toBe(false);
    expect(inspectWebhookUrl("http://ok.example/hook", RELAXED).ok).toBe(true);
  });

  it.each([
    ["file", "file:///etc/passwd"],
    ["ftp", "ftp://ok.example/hook"],
    ["gopher", "gopher://ok.example/hook"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/plain,hello"],
    ["not a URL", "ok.example/hook"],
    ["empty", ""],
  ])("rejects %s", (_label, raw) => {
    expect(inspectWebhookUrl(raw, RELAXED)).toEqual({ ok: false, reason: "url_rejected" });
  });
});

describe("inspectWebhookUrl — L2 embedded credentials", () => {
  it.each([
    "https://user:pass@ok.example/hook",
    "https://user@ok.example/hook",
    "https://:pass@ok.example/hook",
  ])("rejects %s", (raw) => {
    expect(inspectWebhookUrl(raw, STRICT).ok).toBe(false);
  });
});

describe("inspectWebhookUrl — L3 hostname deny-list", () => {
  it.each([
    ["localhost", "https://localhost/hook"],
    ["trailing dot", "https://localhost./hook"],
    ["upper case", "https://LOCALHOST/hook"],
    ["*.localhost", "https://foo.localhost/hook"],
    ["*.local", "https://printer.local/hook"],
    ["*.internal", "https://svc.internal/hook"],
    ["cloud metadata", "https://metadata.google.internal/computeMetadata/v1/"],
    ["our own app host", "https://app.notted.test/hook"],
    ["our own api host", "https://API.notted.test/hook"],
  ])("rejects %s", (_label, raw) => {
    expect(inspectWebhookUrl(raw, STRICT).ok).toBe(false);
  });

  it("still rejects the deny-list with insecure URLs allowed", () => {
    expect(inspectWebhookUrl("http://svc.internal/hook", RELAXED).ok).toBe(false);
  });

  it("does not reject a merely similar public hostname", () => {
    expect(inspectWebhookUrl("https://notlocalhost.example/hook", STRICT).ok).toBe(true);
    expect(inspectWebhookUrl("https://local.example/hook", STRICT).ok).toBe(true);
  });
});

describe("isBlockedAddress — L4 address deny-list", () => {
  it.each([
    "169.254.169.254",
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    // Deprecated v4-COMPATIBLE forms of the same loopback address.
    "::127.0.0.1",
    "::7f00:1",
    // Non-compressed spellings escape `unmapIpv4`'s regexes; the `::/96`
    // subnet catches them because BlockList canonicalises.
    "::0:7f00:1",
    "::0:a9fe:a9fe",
    "0:0:0:0:0:0:7f00:1",
    "192.88.99.1",
    "224.0.0.1",
    "not-an-address",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address, STRICT)).toBe(true);
  });

  it.each(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])(
    "allows the public address %s",
    (address) => {
      expect(isBlockedAddress(address, STRICT)).toBe(false);
    },
  );

  it("relaxes ONLY loopback when insecure URLs are allowed", () => {
    expect(isBlockedAddress("127.0.0.1", RELAXED)).toBe(false);
    expect(isBlockedAddress("::1", RELAXED)).toBe(false);
    for (const address of ["10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254"]) {
      expect(isBlockedAddress(address, RELAXED)).toBe(true);
    }
  });

  it("ignores brackets and zone ids", () => {
    expect(isBlockedAddress("[::1]", STRICT)).toBe(true);
    expect(isBlockedAddress("fe80::1%eth0", STRICT)).toBe(true);
  });
});

describe("resolveWebhookHost — L5 pre-flight resolution", () => {
  const stub = (addresses: readonly { address: string; family: number }[]): WebhookDnsLookup => {
    return () => Promise.resolve(addresses);
  };

  it("rejects an empty answer", async () => {
    await expect(resolveWebhookHost("ok.example", STRICT, stub([]))).resolves.toBe("dns_blocked");
  });

  it("rejects a split answer that mixes a public and a private address", async () => {
    // Round-robin rebinding: approving on the first answer alone would let the
    // socket dial the private one.
    await expect(
      resolveWebhookHost("ok.example", STRICT, stub([PUBLIC_ADDRESS, PRIVATE_ADDRESS])),
    ).resolves.toBe("dns_blocked");
  });

  it("accepts an answer where every address is public", async () => {
    await expect(
      resolveWebhookHost("ok.example", STRICT, stub([PUBLIC_ADDRESS, { ...PUBLIC_ADDRESS }])),
    ).resolves.toBe("ok");
  });

  it("treats a resolver failure as blocked", async () => {
    const failing: WebhookDnsLookup = () => Promise.reject(new Error("ENOTFOUND"));
    await expect(resolveWebhookHost("ok.example", STRICT, failing)).resolves.toBe("dns_blocked");
  });
});

describe("guardedLookup — L6 connect-time re-check", () => {
  interface LookupOutcome {
    readonly errorCode: string | undefined;
    readonly errorMessage: string;
    readonly address: unknown;
  }

  const call = (
    lookup: ReturnType<typeof guardedLookup>,
    hostname = "rebind.example",
    all = false,
    family: 0 | 4 | 6 = 0,
  ): Promise<LookupOutcome> =>
    new Promise((resolve) => {
      lookup(hostname, { all, family }, (error, address) => {
        const failure: NodeJS.ErrnoException | null = error;
        resolve({
          errorCode: failure?.code,
          errorMessage: failure?.message ?? "",
          address,
        });
      });
    });

  it("blocks the second answer of a TTL-0 rebind after approving the first", async () => {
    const answers = [PUBLIC_ADDRESS, PRIVATE_ADDRESS];
    let index = 0;
    const rebinding: WebhookDnsLookup = () => Promise.resolve([answers[index++]!]);
    const lookup = guardedLookup(STRICT, rebinding);

    const first = await call(lookup);
    expect(first.errorCode).toBeUndefined();
    expect(first.address).toBe(PUBLIC_ADDRESS.address);

    const second = await call(lookup);
    expect(second.errorCode).toBe(WEBHOOK_BLOCKED_ERROR_CODE);
    // The URL is admin-supplied and may carry a token: it must never be quoted.
    expect(second.errorMessage).not.toContain("rebind.example");
  });

  it("blocks an empty answer and a failing resolver", async () => {
    const empty = await call(guardedLookup(STRICT, () => Promise.resolve([])));
    expect(empty.errorCode).toBe(WEBHOOK_BLOCKED_ERROR_CODE);

    const failing = await call(guardedLookup(STRICT, () => Promise.reject(new Error("EAI_AGAIN"))));
    expect(failing.errorCode).toBe(WEBHOOK_BLOCKED_ERROR_CODE);
  });

  it("returns every address when the socket asked for all of them", async () => {
    const lookup = guardedLookup(STRICT, () => Promise.resolve([PUBLIC_ADDRESS]));
    const result = await call(lookup, "ok.example", true);
    expect(result.errorCode).toBeUndefined();
    expect(result.address).toEqual([PUBLIC_ADDRESS]);
  });

  // Handing back a family the socket did not ask for produced a connect error
  // that had nothing to do with the endpoint, and the delivery log recorded it
  // as `connection_failed`.
  it("returns only the family the socket asked for", async () => {
    const both = [PUBLIC_ADDRESS, PUBLIC_V6_ADDRESS];
    const lookup = guardedLookup(STRICT, () => Promise.resolve(both));

    await expect(call(lookup, "ok.example", false, 4)).resolves.toMatchObject({
      address: PUBLIC_ADDRESS.address,
    });
    await expect(call(lookup, "ok.example", false, 6)).resolves.toMatchObject({
      address: PUBLIC_V6_ADDRESS.address,
    });
    await expect(call(lookup, "ok.example", true, 6)).resolves.toMatchObject({
      address: [PUBLIC_V6_ADDRESS],
    });
  });

  it("reports a family miss as ENOTFOUND, not as an SSRF denial", async () => {
    // A v4-only host dialled over v6 is a resolution failure; classifying it
    // `dns_blocked` would log a legitimate endpoint as a security event.
    const lookup = guardedLookup(STRICT, () => Promise.resolve([PUBLIC_ADDRESS]));
    await expect(call(lookup, "ok.example", false, 6)).resolves.toMatchObject({
      errorCode: "ENOTFOUND",
    });
  });
});
