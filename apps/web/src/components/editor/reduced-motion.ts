/**
 * One shared `prefers-reduced-motion` observer (Part 43).
 *
 * Part 41 produces a **static first-frame poster** for the `medium` and
 * `thumbnail` renditions and preserves animation only in `full`. An animated GIF
 * therefore has an already-processed still available at no extra cost, and
 * WCAG 2.2 SC 2.2.2 (Pause, Stop, Hide) is satisfied by choosing it rather than
 * by adding a play/pause control to every image. `CustomImage`'s node view reads
 * `prefersReducedMotion()` when it paints and re-paints on `subscribe`.
 *
 * A single module-level `MediaQueryList` is used rather than one per node view:
 * a note may carry up to `maxImages` figures, and a hundred identical media
 * listeners is a hundred identical callbacks on every system preference change.
 *
 * Everything is guarded for the server render and for environments without
 * `matchMedia` (a preference that cannot be read is treated as "not set", which
 * is the accessible default only because the alternative — assuming reduced
 * motion for everyone — would silently drop animation the author intended).
 */

const QUERY = "(prefers-reduced-motion: reduce)";

let mediaQuery: MediaQueryList | null | undefined;

function query(): MediaQueryList | null {
  if (mediaQuery !== undefined) return mediaQuery;
  mediaQuery =
    typeof globalThis.matchMedia === "function" ? (globalThis.matchMedia(QUERY) ?? null) : null;
  return mediaQuery;
}

export function prefersReducedMotion(): boolean {
  return query()?.matches === true;
}

/**
 * Subscribe to preference changes. Returns an unsubscribe function; calling it
 * is required, and a caller that cannot subscribe still gets a valid no-op so
 * teardown never has to branch.
 */
export function subscribeToReducedMotion(listener: () => void): () => void {
  const list = query();
  if (list === null) return (): void => undefined;
  const handler = (): void => listener();
  // `addEventListener` is the modern form; `addListener` is kept for Safari
  // versions that still only implement the deprecated one. Neither is assumed
  // to exist, because jsdom's `MediaQueryList` has historically had gaps.
  if (typeof list.addEventListener === "function") {
    list.addEventListener("change", handler);
    return (): void => list.removeEventListener("change", handler);
  }
  if (typeof list.addListener === "function") {
    list.addListener(handler);
    return (): void => list.removeListener(handler);
  }
  return (): void => undefined;
}

/** Test seam: drops the cached `MediaQueryList` so a stub can replace it. */
export function resetReducedMotionForTests(): void {
  mediaQuery = undefined;
}
