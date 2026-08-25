// Part 72 — WCAG 2.2 relative luminance and contrast, as pure arithmetic.
//
// It lives in `@notted/shared-validators` because BOTH sides need the same
// number: `WorkspacesService.validateSettings` refuses an accent that cannot be
// read, and the settings form shows the reader the ratio BEFORE they save. Two
// implementations of the same formula would eventually disagree, and the one
// that disagreed would be the one the user saw.
//
// The reference colour is WHITE, not the theme's `--color-primary-foreground`
// (`#f8fafc`). The accent is applied as a surface colour under near-white text
// and next to a white page, so white is the strictest of the comparisons that
// actually occur — judging against `#f8fafc` would report a slightly kinder
// ratio than the page really has.
//
// Formulae: WCAG 2.2 relative luminance (sRGB, gamma 2.4) and the (L1+0.05) /
// (L2+0.05) contrast ratio.

/** Below this an accent is refused outright: 3:1 is the WCAG 2.2 non-text (1.4.11) floor. */
export const ACCENT_CONTRAST_MIN_RATIO = 3;

/** At or above this an accent also carries normal-size text safely (1.4.3 AA). */
export const ACCENT_CONTRAST_TARGET_RATIO = 4.5;

const WHITE = "#ffffff";
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

function linearChannel(byteValue: number): number {
  const channel = byteValue / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/**
 * WCAG relative luminance of a `#rrggbb` colour, or `null` when the input is
 * not that shape. Returning `null` rather than throwing keeps every caller —
 * including a render pass over untrusted persisted `jsonb` — total.
 */
export function relativeLuminance(color: string): number | null {
  if (!HEX_COLOR.test(color)) return null;
  const red = linearChannel(Number.parseInt(color.slice(1, 3), 16));
  const green = linearChannel(Number.parseInt(color.slice(3, 5), 16));
  const blue = linearChannel(Number.parseInt(color.slice(5, 7), 16));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** Contrast ratio between two `#rrggbb` colours, 1–21. `null` if either is malformed. */
export function contrastRatio(first: string, second: string): number | null {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  if (firstLuminance === null || secondLuminance === null) return null;
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * `fail` is REFUSED by the API (422 `ACCENT_CONTRAST_TOO_LOW`); `warn` is
 * allowed but told to the person choosing it. Two levels rather than one
 * because an accent used only as a border or a chip is legitimate at 3.2:1, and
 * refusing every colour that cannot also carry body text would reject most
 * brand palettes.
 */
export type AccentContrastLevel = "fail" | "warn" | "ok";

export interface AccentContrast {
  /** Ratio of the accent against white, rounded to two decimals. */
  readonly ratioOnWhite: number;
  readonly level: AccentContrastLevel;
}

/** `null` for anything that is not a `#rrggbb` colour. */
export function accentContrast(accent: string): AccentContrast | null {
  const ratio = contrastRatio(accent, WHITE);
  if (ratio === null) return null;
  return Object.freeze({
    ratioOnWhite: Math.round(ratio * 100) / 100,
    level:
      ratio < ACCENT_CONTRAST_MIN_RATIO
        ? "fail"
        : ratio < ACCENT_CONTRAST_TARGET_RATIO
          ? "warn"
          : "ok",
  });
}
