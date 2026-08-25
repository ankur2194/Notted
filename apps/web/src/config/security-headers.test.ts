import { createRequire } from "node:module";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

// `security-headers.js` is CJS at the apps/web root (next.config.js must
// `require()` it directly), and `allowJs` is not set in tsconfig.base.json —
// so, like `dev-origins.test.ts` next to this file, it is loaded with
// `require()` and an inline type assertion rather than a static import.
const { buildSecurityHeaders } = require(resolve(__dirname, "../../security-headers.js")) as {
  buildSecurityHeaders: (options: {
    apiUrl?: string;
    wsUrl?: string;
    production: boolean;
  }) => { key: string; value: string }[];
};

const API_ORIGIN = "https://api.example.test";
const WS_ORIGIN = "wss://api.example.test";

function headerValue(
  headers: readonly { key: string; value: string }[],
  key: string,
): string | undefined {
  return headers.find((header) => header.key === key)?.value;
}

function cspDirectives(headers: readonly { key: string; value: string }[]): string[] {
  const csp = headerValue(headers, "Content-Security-Policy");
  return csp?.split("; ") ?? [];
}

describe("buildSecurityHeaders", () => {
  it("locks down script-src and enables upgrade-insecure-requests in production", () => {
    const headers = buildSecurityHeaders({
      apiUrl: API_ORIGIN,
      wsUrl: WS_ORIGIN,
      production: true,
    });
    const csp = headerValue(headers, "Content-Security-Policy") ?? "";

    expect(cspDirectives(headers)).toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain(" ws:");
    expect(headerValue(headers, "Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });

  it("relaxes script-src and omits HSTS entirely outside production", () => {
    const headers = buildSecurityHeaders({
      apiUrl: API_ORIGIN,
      wsUrl: WS_ORIGIN,
      production: false,
    });
    const csp = headerValue(headers, "Content-Security-Policy") ?? "";

    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("ws: wss:");
    expect(headers.some((header) => header.key === "Strict-Transport-Security")).toBe(false);
  });

  it.each([true, false])(
    "always includes the baseline lockdown directives (production=%s)",
    (production) => {
      const headers = buildSecurityHeaders({ apiUrl: API_ORIGIN, wsUrl: WS_ORIGIN, production });
      const directives = cspDirectives(headers);

      expect(directives).toContain("frame-ancestors 'none'");
      expect(directives).toContain("object-src 'none'");
      expect(directives).toContain("base-uri 'self'");
      expect(directives).toContain("form-action 'self'");
      expect(directives).toContain("default-src 'self'");
      expect(headerValue(headers, "X-Frame-Options")).toBe("DENY");
      expect(headerValue(headers, "X-Content-Type-Options")).toBe("nosniff");
      expect(headerValue(headers, "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
      expect(headerValue(headers, "Permissions-Policy")).toBe(
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      );
    },
  );

  it("names the configured API and WS origins in img-src and connect-src", () => {
    const headers = buildSecurityHeaders({
      apiUrl: API_ORIGIN,
      wsUrl: WS_ORIGIN,
      production: true,
    });
    const directives = cspDirectives(headers);
    const imgSrc = directives.find((directive) => directive.startsWith("img-src"));
    const connectSrc = directives.find((directive) => directive.startsWith("connect-src"));

    expect(imgSrc).toContain(API_ORIGIN);
    expect(connectSrc).toContain(API_ORIGIN);
    expect(connectSrc).toContain(WS_ORIGIN);
  });

  it("tolerates a malformed apiUrl without throwing", () => {
    expect(() =>
      buildSecurityHeaders({ apiUrl: "not a url", wsUrl: WS_ORIGIN, production: true }),
    ).not.toThrow();

    const headers = buildSecurityHeaders({
      apiUrl: "not a url",
      wsUrl: WS_ORIGIN,
      production: true,
    });

    expect(headerValue(headers, "Content-Security-Policy")).toContain("default-src 'self'");
  });
});
