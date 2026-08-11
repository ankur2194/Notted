import type { Progress } from "@notted/shared-types";

/**
 * The two arithmetic operations every progress reading in the product needs.
 *
 * Both live here rather than inline at each call site so the note card, the
 * note header and the project rollup cannot drift into three slightly
 * different roundings of the same number.
 */

/**
 * Sums several readings into one.
 *
 * No parts is a legitimate call — a surface with nothing to count — and yields
 * an empty reading rather than throwing, so callers never guard the spread.
 */
export function combineProgress(...parts: readonly Progress[]): Progress {
  return parts.reduce<Progress>(
    (sum, part) => ({ done: sum.done + part.done, total: sum.total + part.total }),
    { done: 0, total: 0 },
  );
}

/**
 * Integer percent complete.
 *
 * A zero total is 0%, never `NaN`: an empty checklist has made no progress, and
 * `NaN` would reach the DOM as an unparsable `width` and an invalid
 * `aria-valuenow`.
 */
export function progressPercent(progress: Progress): number {
  return progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
}
