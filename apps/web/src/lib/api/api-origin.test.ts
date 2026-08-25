import { afterEach, describe, expect, it, vi } from "vitest";

import { apiAssetUrl, apiOrigin, wsOrigin } from "./api-origin";

import { publicEnvironment } from "@/config/public-environment";

const APP_ORIGIN = new URL(publicEnvironment.NEXT_PUBLIC_APP_URL).origin;
const API_ORIGIN = new URL(publicEnvironment.NEXT_PUBLIC_API_URL).origin;
const WS_ORIGIN = new URL(publicEnvironment.NEXT_PUBLIC_WS_URL).origin;

/**
 * `jsdom` supplies a real `window.location` that cannot be reassigned, so the
 * host is moved by redefining the property for the duration of one case.
 */
function onHost(origin: string): void {
  const url = new URL(origin);
  vi.stubGlobal("window", {
    ...globalThis.window,
    location: {
      host: url.host,
      hostname: url.hostname,
      origin: url.origin,
      protocol: url.protocol,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiOrigin", () => {
  it("is the origin of the configured public API URL on the primary host", () => {
    onHost(APP_ORIGIN);
    expect(apiOrigin()).toBe(API_ORIGIN);
  });

  // Part 73. The bundle is built once and served on every tenant hostname, so a
  // build-time API origin would send a cross-origin request whose host-only
  // session cookie is not attached.
  it("is the page's own origin on a custom host", () => {
    onHost("https://notes.acme.com");
    expect(apiOrigin()).toBe("https://notes.acme.com");
  });

  it("falls back to the configured value when there is no window (server render)", () => {
    vi.stubGlobal("window", undefined);
    expect(apiOrigin()).toBe(API_ORIGIN);
    expect(wsOrigin()).toBe(WS_ORIGIN);
  });
});

describe("wsOrigin", () => {
  it("is the configured socket origin on the primary host", () => {
    onHost(APP_ORIGIN);
    expect(wsOrigin()).toBe(WS_ORIGIN);
  });

  it.each([
    ["https://notes.acme.com", "wss://notes.acme.com"],
    ["http://notes.acme.test:3000", "ws://notes.acme.test:3000"],
  ])("maps %s to %s on a custom host", (page, expected) => {
    onHost(page);
    expect(wsOrigin()).toBe(expected);
  });
});

describe("apiAssetUrl", () => {
  it("resolves an app-relative API path against the API origin", () => {
    onHost(APP_ORIGIN);
    expect(apiAssetUrl("/api/v1/workspaces/abc/logo/token")).toBe(
      `${API_ORIGIN}/api/v1/workspaces/abc/logo/token`,
    );
  });

  it("follows the page origin on a custom host", () => {
    onHost("https://notes.acme.com");
    expect(apiAssetUrl("/api/v1/workspaces/abc/logo/token")).toBe(
      "https://notes.acme.com/api/v1/workspaces/abc/logo/token",
    );
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["a protocol-relative host", "//evil.example/logo.png"],
    ["an absolute http URL", "http://evil.example/logo.png"],
    ["an absolute https URL", "https://evil.example/logo.png"],
    ["a javascript scheme", "javascript:alert(1)"],
    ["a data scheme", "data:image/svg+xml,<svg/>"],
    ["a bare relative path", "logo.png"],
  ])("returns null for %s", (_label, value) => {
    expect(apiAssetUrl(value)).toBeNull();
  });
});
