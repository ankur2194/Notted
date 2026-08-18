import { describe, expect, it } from "vitest";

import { parseExportConfig } from "./export.config";

describe("export configuration", () => {
  it("freezes bounded defaults with PDF export disabled", () => {
    const value = parseExportConfig({});
    expect(Object.isFrozen(value)).toBe(true);
    expect(value).toEqual({
      chromiumPath: null,
      renderTimeoutMs: 30_000,
      maxArtifactBytes: 26_214_400,
    });
  });

  it("treats an empty or whitespace-only path as absent", () => {
    expect(parseExportConfig({ EXPORT_CHROMIUM_PATH: "" }).chromiumPath).toBeNull();
    expect(parseExportConfig({ EXPORT_CHROMIUM_PATH: "   " }).chromiumPath).toBeNull();
  });

  it("accepts an absolute Chromium path", () => {
    expect(parseExportConfig({ EXPORT_CHROMIUM_PATH: "/usr/bin/chromium" }).chromiumPath).toBe(
      "/usr/bin/chromium",
    );
  });

  it("rejects a relative Chromium path", () => {
    expect(() => parseExportConfig({ EXPORT_CHROMIUM_PATH: "usr/bin/chromium" })).toThrow(
      "EXPORT_CHROMIUM_PATH must be an absolute path",
    );
  });

  it("rejects a Chromium path containing a NUL byte", () => {
    expect(() =>
      parseExportConfig({ EXPORT_CHROMIUM_PATH: `/usr/bin/chromium${String.fromCharCode(0)}` }),
    ).toThrow("EXPORT_CHROMIUM_PATH must not contain a NUL byte");
  });

  it("bounds the render timeout", () => {
    expect(parseExportConfig({ EXPORT_RENDER_TIMEOUT_MS: "60000" }).renderTimeoutMs).toBe(60_000);
    expect(() => parseExportConfig({ EXPORT_RENDER_TIMEOUT_MS: "999" })).toThrow();
    expect(() => parseExportConfig({ EXPORT_RENDER_TIMEOUT_MS: "300001" })).toThrow();
  });

  it("bounds the max artifact size", () => {
    expect(parseExportConfig({ EXPORT_MAX_ARTIFACT_BYTES: "10485760" }).maxArtifactBytes).toBe(
      10_485_760,
    );
    expect(() => parseExportConfig({ EXPORT_MAX_ARTIFACT_BYTES: "1048575" })).toThrow();
    expect(() => parseExportConfig({ EXPORT_MAX_ARTIFACT_BYTES: "209715201" })).toThrow();
  });

  it("wraps parse failures with a consistent prefix", () => {
    expect(() => parseExportConfig({ EXPORT_RENDER_TIMEOUT_MS: "not-a-number" })).toThrow(
      "Invalid export configuration",
    );
  });
});
