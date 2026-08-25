import { describe, expect, it } from "vitest";

import { DEFAULT_ACCENT_COLOR, PLATFORM_BRANDING_NAME, resolveBranding } from "./email-branding";

const appConfig = {
  appUrl: new URL("https://app.notted.test/dashboard?x=1"),
  apiUrl: new URL("https://api.notted.test"),
} as const;

describe("resolveBranding", () => {
  it("falls back to platform branding for workspace-less email", () => {
    expect(resolveBranding(null, appConfig)).toEqual({
      name: PLATFORM_BRANDING_NAME,
      logoUrl: null,
      accentColor: DEFAULT_ACCENT_COLOR,
      appUrl: "https://app.notted.test",
    });
  });

  it("uses a workspace accent colour when it is well formed", () => {
    const branding = resolveBranding(
      { name: "Acme", logoUrl: null, settings: { accentColor: "#0f766e" } },
      appConfig,
    );
    expect(branding.accentColor).toBe("#0f766e");
    expect(branding.name).toBe("Acme");
  });

  it.each([
    ["a string", "accentColor"],
    ["an array", ["#0f766e"]],
    ["a number", 42],
    ["null", null],
    ["a non-string accent", { accentColor: 5 }],
    ["a named colour", { accentColor: "red" }],
    ["a short hex", { accentColor: "#12345" }],
  ])("falls back to the default accent for %s settings", (_label, settings) => {
    const branding = resolveBranding({ name: "Acme", logoUrl: null, settings }, appConfig);
    expect(branding.accentColor).toBe(DEFAULT_ACCENT_COLOR);
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "  ", "not-a-url"])(
    "drops the unsafe logo URL %s",
    (logoUrl) => {
      expect(
        resolveBranding({ name: "Acme", logoUrl, settings: {} }, appConfig).logoUrl,
      ).toBeNull();
    },
  );

  it("keeps an absolute https logo URL", () => {
    const branding = resolveBranding(
      { name: "Acme", logoUrl: "https://cdn.notted.test/logo.png", settings: {} },
      appConfig,
    );
    expect(branding.logoUrl).toBe("https://cdn.notted.test/logo.png");
  });

  // Part 72: the persisted `logo_url` is an app-relative API path, so the mail
  // client — which has no base URL — must receive it already absolute.
  it("resolves an app-relative logo path against the API origin", () => {
    const branding = resolveBranding(
      {
        name: "Acme",
        logoUrl:
          "/api/v1/workspaces/11111111-1111-4111-8111-111111111111/logo/0123456789abcdef0123456789abcdef",
        settings: {},
      },
      appConfig,
    );
    expect(branding.logoUrl).toBe(
      "https://api.notted.test/api/v1/workspaces/11111111-1111-4111-8111-111111111111/logo/0123456789abcdef0123456789abcdef",
    );
  });

  it("refuses a protocol-relative value that would leave the API origin", () => {
    expect(
      resolveBranding({ name: "Acme", logoUrl: "//evil.example/logo.png", settings: {} }, appConfig)
        .logoUrl,
    ).toBeNull();
  });

  it("falls back to the platform name for a blank workspace name", () => {
    const branding = resolveBranding({ name: "   ", logoUrl: null, settings: {} }, appConfig);
    expect(branding.name).toBe(PLATFORM_BRANDING_NAME);
  });
});
