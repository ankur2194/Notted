import { createRequire } from "node:module";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

/**
 * Guards the development origin allow-list in `next.config.js`.
 *
 * Next blocks cross-origin access to `/_next/*` dev resources and allows
 * `localhost` alone by default. Every other loopback spelling then has its HMR
 * socket blocked, Turbopack's client runtime never finishes, and hydration
 * silently never happens: forms fall back to a native GET submit that reloads
 * the page with the field values in the URL. Nothing fails loudly when this
 * regresses, which is why it is asserted here rather than left to a manual
 * check.
 */
describe("development origin allow-list", () => {
  const config = require(resolve(__dirname, "../../next.config.js")) as {
    readonly allowedDevOrigins?: readonly string[];
  };

  it.each(["127.0.0.1", "[::1]"])("allows the %s loopback address", (origin) => {
    expect(config.allowedDevOrigins).toContain(origin);
  });

  it("lists only loopback addresses, so no routable host gains dev access", () => {
    const loopback = new Set(["127.0.0.1", "[::1]", "localhost"]);
    expect((config.allowedDevOrigins ?? []).filter((origin) => !loopback.has(origin))).toEqual([]);
  });
});
