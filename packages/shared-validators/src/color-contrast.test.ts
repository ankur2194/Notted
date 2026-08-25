import { describe, expect, it } from "vitest";

import {
  ACCENT_CONTRAST_MIN_RATIO,
  ACCENT_CONTRAST_TARGET_RATIO,
  accentContrast,
  contrastRatio,
  relativeLuminance,
} from "./color-contrast";

describe("relativeLuminance", () => {
  it("anchors the two endpoints of the sRGB range", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 6);
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 6);
  });

  it("returns null rather than throwing on a value that is not #rrggbb", () => {
    for (const value of ["", "#fff", "2563eb", "#2563eg", "#2563eb99", "javascript:1"]) {
      expect(relativeLuminance(value)).toBeNull();
    }
  });
});

describe("contrastRatio", () => {
  it("reports the 21:1 maximum for black on white, in either argument order", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
  });

  it("reports 1:1 for a colour against itself", () => {
    expect(contrastRatio("#2563eb", "#2563eb")).toBeCloseTo(1, 6);
  });

  it("is null when either colour is malformed", () => {
    expect(contrastRatio("#2563eb", "red")).toBeNull();
    expect(contrastRatio("red", "#2563eb")).toBeNull();
  });
});

describe("accentContrast", () => {
  it("passes the seeded default accent", () => {
    const result = accentContrast("#2563eb");
    expect(result).not.toBeNull();
    // Computed from the WCAG formula, not copied from a browser tool.
    expect(result?.ratioOnWhite).toBeCloseTo(5.17, 2);
    expect(result?.level).toBe("ok");
  });

  it("warns on a colour that clears 3:1 but not 4.5:1", () => {
    const result = accentContrast("#ef4444");
    expect(result?.level).toBe("warn");
    expect(result?.ratioOnWhite).toBeGreaterThanOrEqual(ACCENT_CONTRAST_MIN_RATIO);
    expect(result?.ratioOnWhite).toBeLessThan(ACCENT_CONTRAST_TARGET_RATIO);
  });

  it("fails a light amber that cannot be read on white", () => {
    const result = accentContrast("#fbbf24");
    expect(result?.level).toBe("fail");
    expect(result?.ratioOnWhite).toBeLessThan(ACCENT_CONTRAST_MIN_RATIO);
  });

  it("is null for a malformed accent", () => {
    expect(accentContrast("not-a-colour")).toBeNull();
  });
});
