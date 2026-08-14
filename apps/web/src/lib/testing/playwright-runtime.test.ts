import { describe, expect, it } from "vitest";

import { playwrightDiagnostics } from "./playwright-runtime";

describe("playwrightDiagnostics", () => {
  it("retains default failure evidence", () => {
    expect(playwrightDiagnostics({})).toEqual({
      htmlReport: true,
      trace: "retain-on-failure",
      screenshot: "only-on-failure",
      video: "retain-on-failure",
    });
  });

  it("disables heavy artifacts only in explicit lightweight local mode", () => {
    expect(playwrightDiagnostics({ PLAYWRIGHT_LIGHTWEIGHT_MODE: "true" })).toEqual({
      htmlReport: false,
      trace: "off",
      screenshot: "off",
      video: "off",
    });
  });

  it("retains CI diagnostics even when lightweight mode is present", () => {
    expect(playwrightDiagnostics({ CI: "true", PLAYWRIGHT_LIGHTWEIGHT_MODE: "true" })).toEqual({
      htmlReport: true,
      trace: "retain-on-failure",
      screenshot: "only-on-failure",
      video: "retain-on-failure",
    });
  });
});
