import type { CSSProperties } from "react";

/**
 * Part 72 runtime theming.
 *
 * Tailwind 4 compiles `bg-primary` / `ring-ring` to `var(--color-primary)` and
 * `var(--color-ring)` AT THE USE SITE, so overriding those two custom properties
 * on the shell root re-tints every primary surface, button, and focus ring below
 * it without a single component knowing branding exists. That is the whole
 * mechanism — no theme provider, no class permutations, no stylesheet rewrite.
 *
 * The shape is checked here, immediately before the value becomes a style, even
 * though the API validated it on write and the shell schema validated it on
 * read. This is the last hop before an arbitrary string would be interpolated
 * into CSS, and `#rrggbb` is the only thing that may make it through.
 *
 * `--color-ring` moves with `--color-primary` deliberately: a focus ring that
 * stayed slate on a re-tinted button is the accessibility bug this feature would
 * otherwise ship. `--color-primary-foreground` is deliberately NOT touched —
 * the server refuses any accent below 3:1 against white, so near-white text
 * stays legible on every accent that can be saved.
 */
export function accentStyle(accentColor: string | null | undefined): CSSProperties | undefined {
  if (typeof accentColor !== "string" || !/^#[0-9a-f]{6}$/iu.test(accentColor)) return undefined;
  return {
    "--color-primary": accentColor,
    "--color-ring": accentColor,
  } as CSSProperties;
}
