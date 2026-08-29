import { describe, expect, it, vi } from "vitest";

import { parseAppConfig } from "../config/app.config";
import { parseAuthConfig } from "../config/auth.config";

import { canonicalHost, VerifiedHostsService } from "./verified-hosts.service";

import type { DatabaseService } from "../database/database.service";

/**
 * A minimal Drizzle read chain. `rows` is what the terminal `.limit()` /
 * `.where()` resolves to, and `queries` counts how often the chain was built —
 * which is how the cache is asserted without reaching for timers.
 */
function database(rows: readonly unknown[], onQuery?: () => void) {
  const build = () => {
    onQuery?.();
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve([...rows]),
      then: (resolve: (value: unknown[]) => unknown) => resolve([...rows]),
    };
    return chain;
  };
  return { db: { select: build } } as unknown as DatabaseService;
}

function service(
  environment: Record<string, string> = {},
  rows: readonly unknown[] = [],
  onQuery?: () => void,
) {
  return new VerifiedHostsService(
    database(rows, onQuery),
    parseAppConfig(environment),
    parseAuthConfig(environment),
  );
}

describe("canonicalHost", () => {
  it.each([
    ["Notes.ACME.com", "notes.acme.com"],
    ["notes.acme.com.", "notes.acme.com"],
    ["notes.acme.com:3001", "notes.acme.com"],
    ["  LOCALHOST:3000 ", "localhost"],
    ["[::1]:3001", "[::1]"],
    // A BARE IPv6 literal has no host part to recover: everything before the
    // first colon is read as the host, which is empty. This is why the static
    // loopback set carries `[::1]` and not `::1` — an unbracketed entry could
    // never be matched by a canonicalized lookup.
    ["::1", ""],
  ])("folds %s to %s", (input, expected) => {
    expect(canonicalHost(input)).toBe(expected);
  });
});

describe("VerifiedHostsService static hosts", () => {
  it("always contains the configured origins and the CNAME target", () => {
    // HTTPS because `parseAuthConfig` derives `AUTH_PASSKEY_ORIGINS` from
    // `APP_URL` and refuses a non-HTTPS origin that is not `localhost`.
    const hosts = service({
      APP_URL: "https://app.local.test",
      API_URL: "https://api.local.test",
      WS_URL: "wss://api.local.test",
      BETTER_AUTH_TRUSTED_ORIGINS: "https://app.local.test",
      CUSTOM_DOMAIN_CNAME_TARGET: "edge.notted.test",
    }).staticHosts;
    expect(hosts.has("app.local.test")).toBe(true);
    expect(hosts.has("api.local.test")).toBe(true);
    expect(hosts.has("edge.notted.test")).toBe(true);
  });

  it("includes loopback outside production and not in it", () => {
    expect(service({}).staticHosts.has("127.0.0.1")).toBe(true);
    // Bracketed only — see the `canonicalHost("::1")` case above.
    expect(service({}).staticHosts.has("[::1]")).toBe(true);
    expect(service({}).staticHosts.has("::1")).toBe(false);
    const production = service({
      NODE_ENV: "production",
      API_HOST: "0.0.0.0",
      APP_URL: "https://app.example.test",
      API_URL: "https://api.example.test",
      WS_URL: "wss://api.example.test",
      // Required in production: TLS terminates at a proxy, so hops is never 0.
      TRUST_PROXY_HOPS: "1",
      BETTER_AUTH_URL: "https://api.example.test",
      BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
      BETTER_AUTH_TRUSTED_ORIGINS: "https://app.example.test",
      CUSTOM_DOMAIN_CNAME_TARGET: "edge.example.test",
    });
    expect(production.staticHosts.has("127.0.0.1")).toBe(false);
    expect(production.staticHosts.has("app.example.test")).toBe(true);
  });
});

describe("VerifiedHostsService.isTrustedHost", () => {
  it("answers for static hosts without touching the database", async () => {
    const queries = vi.fn();
    const hosts = service({ CUSTOM_DOMAINS_ENABLED: "true" }, [], queries);
    await expect(hosts.isTrustedHost("localhost:3000")).resolves.toBe(true);
    expect(queries).not.toHaveBeenCalled();
  });

  // The flag is a real switch, not a label: with it off, no tenant hostname is
  // ever trusted and the table is never read.
  it("refuses every non-static host and reads nothing when the feature is off", async () => {
    const queries = vi.fn();
    const hosts = service({}, [{ id: "row" }], queries);
    await expect(hosts.isTrustedHost("notes.acme.com")).resolves.toBe(false);
    expect(queries).not.toHaveBeenCalled();
  });

  it("trusts a verified tenant host and caches the answer", async () => {
    const queries = vi.fn();
    const hosts = service({ CUSTOM_DOMAINS_ENABLED: "true" }, [{ id: "row" }], queries);
    await expect(hosts.isTrustedHost("Notes.ACME.com")).resolves.toBe(true);
    await expect(hosts.isTrustedHost("notes.acme.com.")).resolves.toBe(true);
    expect(queries).toHaveBeenCalledTimes(1);
  });

  it("re-reads after an invalidation", async () => {
    const queries = vi.fn();
    const hosts = service({ CUSTOM_DOMAINS_ENABLED: "true" }, [{ id: "row" }], queries);
    await hosts.isTrustedHost("notes.acme.com");
    hosts.invalidate("notes.acme.com");
    await hosts.isTrustedHost("notes.acme.com");
    expect(queries).toHaveBeenCalledTimes(2);
  });

  it("fails closed on a database error without caching the refusal", async () => {
    let calls = 0;
    const failing = {
      db: {
        select: () => {
          calls += 1;
          throw new Error("connection terminated");
        },
      },
    } as unknown as DatabaseService;
    const hosts = new VerifiedHostsService(
      failing,
      parseAppConfig({ CUSTOM_DOMAINS_ENABLED: "true" }),
      parseAuthConfig({}),
    );
    await expect(hosts.isTrustedHost("notes.acme.com")).resolves.toBe(false);
    await expect(hosts.isTrustedHost("notes.acme.com")).resolves.toBe(false);
    // A transient fault must not pin a real tenant host to "untrusted".
    expect(calls).toBe(2);
  });
});

describe("VerifiedHostsService.isTrustedOriginSync", () => {
  it("answers for configured origins with no prior lookup", () => {
    const hosts = service({ CUSTOM_DOMAINS_ENABLED: "true" });
    expect(hosts.isTrustedOriginSync("http://localhost:3000")).toBe(true);
    expect(hosts.isTrustedOriginSync("https://notes.acme.com")).toBe(false);
  });

  it("answers for a tenant origin only after the host has been admitted", async () => {
    const hosts = service({ CUSTOM_DOMAINS_ENABLED: "true" }, [{ id: "row" }]);
    expect(hosts.isTrustedOriginSync("https://notes.acme.com")).toBe(false);
    await hosts.isTrustedHost("notes.acme.com");
    expect(hosts.isTrustedOriginSync("https://notes.acme.com")).toBe(true);
  });

  it("refuses a malformed origin", () => {
    const hosts = service({ CUSTOM_DOMAINS_ENABLED: "true" });
    expect(hosts.isTrustedOriginSync("not-a-url")).toBe(false);
    expect(hosts.isTrustedOriginSync("")).toBe(false);
  });
});

describe("VerifiedHostsService.verifiedOriginsFor", () => {
  it("returns nothing when the feature is off", async () => {
    await expect(
      service({}, [{ hostname: "notes.acme.com" }]).verifiedOriginsFor(),
    ).resolves.toEqual([]);
  });

  it("renders every verified hostname as an origin", async () => {
    const hosts = service({ CUSTOM_DOMAINS_ENABLED: "true" }, [{ hostname: "notes.acme.com" }]);
    await expect(hosts.verifiedOriginsFor()).resolves.toEqual(["https://notes.acme.com"]);
    await expect(hosts.verifiedOriginsFor("http")).resolves.toEqual(["http://notes.acme.com"]);
  });
});
