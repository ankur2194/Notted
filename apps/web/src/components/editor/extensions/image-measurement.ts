/**
 * Layout reads for the image node view: how wide the printed column is, and how
 * much the page is scaled.
 *
 * Split out of `CustomImage.ts`. Both functions are DOM reads with no editor,
 * no node and no state — and both return `null`/`1` rather than throwing when
 * the environment has no layout, which is what lets the resize gesture degrade
 * to the contract bound in jsdom instead of failing.
 */

/* -------------------------------------------------------------------------- */
/* Measurement                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The printable content width, in the paper's own untransformed pixels.
 *
 * `--notted-page-content-width` is published by `page-geometry.ts` precisely so
 * that this part can clamp against it (`globals.css` says so at the token's
 * definition). The arithmetic is deliberately **not** repeated here: two
 * independent derivations of "page width minus margins" drift the first time a
 * margin default changes.
 *
 * The token is a `calc()` in physical units, so it is resolved the only way a
 * custom property can be: by giving a throwaway element that width and reading
 * the used value back. `offsetWidth` is read rather than `getBoundingClientRect`
 * because the paper carries a zoom `transform` and `offsetWidth` reports layout
 * pixels, which is the space an inline `width` is expressed in.
 *
 * Returns `null` when there is no paper ancestor (a standalone editor), or when
 * the environment has no layout at all (jsdom reports every box as zero). The
 * caller then falls back to the contract bound — see `resolveImageResizeBounds`.
 */
export function measurePageContentWidth(element: HTMLElement | null): number | null {
  if (element === null || typeof document === "undefined") return null;
  const paper = element.closest<HTMLElement>(".notted-page-paper");
  if (paper === null) return null;
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.height = "0";
  probe.style.width = "var(--notted-page-content-width)";
  paper.append(probe);
  const measured = probe.offsetWidth;
  probe.remove();
  return measured > 0 ? measured : null;
}

/**
 * Viewport pixels per layout pixel for this element.
 *
 * **This is not the Part 42 "do not divide by the zoom scale" case, and the
 * difference is the whole reason this function exists.** Part 42's finding
 * (Decision 7, and the comment in `handleDrop` below) is that `posAtCoords`
 * compares `clientX` against `getBoundingClientRect()`, and *both* are already
 * in scaled viewport space — so dividing one of them is wrong.
 *
 * A resize is the other arrangement. A pointer delta is in scaled viewport
 * space, but the value being written is an inline `width`, which is a **layout**
 * length the zoom transform is applied to afterwards. The two sides are in
 * different spaces, so the delta has to be converted exactly once.
 *
 * The factor is *measured* — the element's own rect divided by its own layout
 * box — rather than read from the zoom store. That way it is correct for any
 * nesting of transforms, correct at 100 % (where it is exactly 1), and it cannot
 * drift from whatever `PageContainer` is actually doing.
 */
export function pointerScaleOf(element: HTMLElement): number {
  const layout = element.offsetWidth;
  if (layout <= 0) return 1;
  const rendered = element.getBoundingClientRect().width;
  if (!Number.isFinite(rendered) || rendered <= 0) return 1;
  return rendered / layout;
}
