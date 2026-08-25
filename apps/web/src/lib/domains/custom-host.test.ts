import { describe, expect, it } from "vitest";

import { decideCustomHostRoute, isPrimaryHost } from "./custom-host";

const PRIMARY = "app.notted.test";
const WORKSPACE = "20000000-0000-4000-8100-000000000001";
const OTHER = "20000000-0000-4000-8100-000000000002";
const resolved = { workspaceId: WORKSPACE, slug: "acme" };

function decide(overrides: Partial<Parameters<typeof decideCustomHostRoute>[0]> = {}) {
  return decideCustomHostRoute({
    host: "notes.acme.com",
    primaryHost: PRIMARY,
    pathname: "/notes",
    method: "GET",
    resolved,
    selectedWorkspaceId: null,
    enabled: true,
    ...overrides,
  });
}

describe("isPrimaryHost", () => {
  it.each([
    ["the configured host", "app.notted.test"],
    ["the configured host in another case", "App.Notted.Test"],
    ["localhost with a port", "localhost:3000"],
    ["the loopback address", "127.0.0.1:3000"],
    ["the IPv6 loopback", "[::1]:3000"],
    ["an empty host", ""],
  ])("treats %s as primary", (_label, host) => {
    expect(isPrimaryHost(host, PRIMARY)).toBe(true);
  });

  it.each(["notes.acme.com", "notes.acme.com:443", "app.notted.test.evil.example"])(
    "treats %s as a custom host",
    (host) => {
      expect(isPrimaryHost(host, PRIMARY)).toBe(false);
    },
  );
});

describe("decideCustomHostRoute", () => {
  it("leaves the primary host entirely alone", () => {
    expect(decide({ host: PRIMARY })).toEqual({ kind: "primary" });
    expect(decide({ host: "localhost:3000", enabled: false })).toEqual({ kind: "primary" });
  });

  // The flag is a real switch: with it off, this deployment serves exactly one
  // host and has nothing to say about any other.
  it("refuses every non-primary host when the feature is disabled", () => {
    expect(decide({ enabled: false })).toEqual({ kind: "not-found" });
  });

  it("refuses a host the API cannot map to a verified workspace", () => {
    expect(decide({ resolved: null })).toEqual({ kind: "not-found" });
  });

  it("renders and pins the selection cookie to this host's workspace", () => {
    expect(decide()).toEqual({ kind: "allow", setWorkspaceCookie: WORKSPACE });
  });

  it("does not rewrite a cookie that already names this host's workspace", () => {
    expect(decide({ selectedWorkspaceId: WORKSPACE })).toEqual({
      kind: "allow",
      setWorkspaceCookie: null,
    });
  });

  // A branded hostname showing another tenant's content under its own
  // certificate is the coherence failure this rule exists to prevent.
  it("refuses a path that names a different workspace", () => {
    expect(decide({ pathname: `/workspaces/${OTHER}` })).toEqual({ kind: "not-found" });
    expect(decide({ pathname: `/workspaces/${OTHER}/settings` })).toEqual({ kind: "not-found" });
  });

  it("allows a path that names this host's own workspace", () => {
    expect(decide({ pathname: `/workspaces/${WORKSPACE}/settings` })).toMatchObject({
      kind: "allow",
    });
  });

  it("refuses the workspace-switch endpoint on a single-tenant host", () => {
    expect(decide({ pathname: "/api/shell/workspace", method: "POST" })).toEqual({
      kind: "not-found",
    });
    // The same path with a different method is not the switch operation.
    expect(decide({ pathname: "/api/shell/workspace", method: "GET" })).toMatchObject({
      kind: "allow",
    });
  });
});
