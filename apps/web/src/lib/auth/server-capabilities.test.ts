import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAuthCapabilities } from "@/lib/auth/server-capabilities";

const capabilities = {
  oauthProviders: [
    { id: "google", label: "Google" },
    { id: "github", label: "GitHub" },
  ],
  passkeyEnabled: true,
  twoFactorEnabled: true,
  nonRememberedSessionSeconds: 3_600,
  rememberedSessionSeconds: 2_592_000,
  recentAuthenticationSeconds: 900,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("auth capabilities read", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("returns a well-formed capabilities payload without sending credentials", async () => {
    fetchMock.mockResolvedValue(jsonResponse(capabilities));

    await expect(getAuthCapabilities()).resolves.toEqual({
      status: "available",
      value: capabilities,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe("/api/v1/auth/capabilities");
    expect(init?.cache).toBe("no-store");
    // The endpoint is public; forwarding session cookies would be pointless
    // exposure of credentials to a route that never reads them.
    expect(init?.credentials).toBeUndefined();
  });

  it("accepts an empty provider list", async () => {
    const withoutProviders = { ...capabilities, oauthProviders: [] };
    fetchMock.mockResolvedValue(jsonResponse(withoutProviders));

    await expect(getAuthCapabilities()).resolves.toEqual({
      status: "available",
      value: withoutProviders,
    });
  });

  it.each([401, 404, 500, 503] as const)("reports %s as unavailable", async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));

    await expect(getAuthCapabilities()).resolves.toEqual({ status: "unavailable" });
  });

  /**
   * The capabilities payload decides which sign-in methods the UI offers. A
   * malformed or partially-true payload must not be rendered: advertising a
   * provider the server does not actually support sends users into a dead end,
   * and `passkeyEnabled`/`twoFactorEnabled` are checked for exact `true` rather
   * than truthiness so a `"false"` string cannot enable a control.
   */
  it.each([
    ["a non-object body", "unavailable-body"],
    ["a null body", null],
    ["a missing provider list", { ...capabilities, oauthProviders: undefined }],
    ["a provider list that is not an array", { ...capabilities, oauthProviders: {} }],
    [
      "an unknown provider id",
      { ...capabilities, oauthProviders: [{ id: "facebook", label: "Facebook" }] },
    ],
    ["a provider without a label", { ...capabilities, oauthProviders: [{ id: "google" }] }],
    ["a null provider entry", { ...capabilities, oauthProviders: [null] }],
    ["passkeys not exactly enabled", { ...capabilities, passkeyEnabled: "true" }],
    ["two-factor not exactly enabled", { ...capabilities, twoFactorEnabled: 1 }],
    ["a non-numeric session lifetime", { ...capabilities, nonRememberedSessionSeconds: "3600" }],
    ["a non-numeric remembered lifetime", { ...capabilities, rememberedSessionSeconds: null }],
    ["a non-numeric recent-auth window", { ...capabilities, recentAuthenticationSeconds: "900" }],
  ])("refuses %s", async (_label, body) => {
    fetchMock.mockResolvedValue(jsonResponse(body));

    await expect(getAuthCapabilities()).resolves.toEqual({ status: "unavailable" });
  });

  it("reports a thrown request as unavailable rather than failing the render", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));

    await expect(getAuthCapabilities()).resolves.toEqual({ status: "unavailable" });
  });
});
