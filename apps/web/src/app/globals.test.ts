import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function luminance(hex: string) {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4),
    );
  if (!channels || channels.length !== 3) throw new Error(`Invalid color: ${hex}`);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(first: string, second: string) {
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("semantic color tokens", () => {
  it.each([
    ["success", "success-foreground"],
    ["warning", "warning-foreground"],
    ["muted", "muted-foreground"],
  ])("%s pair meets WCAG AA normal-text contrast", (backgroundName, foregroundName) => {
    const css = readFileSync(resolve("src/app/globals.css"), "utf8");
    const background = css.match(new RegExp(`--color-${backgroundName}: (#[0-9a-f]{6})`))?.[1];
    const foreground = css.match(new RegExp(`--color-${foregroundName}: (#[0-9a-f]{6})`))?.[1];

    expect(background).toBeDefined();
    expect(foreground).toBeDefined();
    expect(contrast(background!, foreground!)).toBeGreaterThanOrEqual(4.5);
  });
});
