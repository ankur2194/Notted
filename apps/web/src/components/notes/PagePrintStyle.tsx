"use client";

import { pageRuleCss } from "@notted/shared-types";

import type { PageMargins, PageSize } from "@notted/shared-types";

export interface PagePrintStyleProps {
  readonly size: PageSize;
  readonly margins: PageMargins;
}

/**
 * The one rule `styles/print.css` cannot express.
 *
 * `@page` has no selector — it cannot be targeted by a class, an attribute, or a
 * custom property — so the sheet size and margins currently in effect have to be
 * emitted as an actual rule. This is the standard workaround, and it is the
 * reason `print.css` ships a *default* `@page` that this element overrides for
 * the note being viewed.
 *
 * Security: the rule text comes from `pageRuleCss`, which reads its dimensions
 * from the frozen `PAGE_SIZES` table and its margins from `clampMargins`
 * (whole millimetres inside `MAX_PAGE_MARGINS`). No caller-supplied string is
 * ever interpolated into a stylesheet.
 *
 * Part 63 (PDF and HTML export) builds the same rule from the same function for
 * its Puppeteer template, so a server-side export paginates exactly as the
 * editor did.
 */
export function PagePrintStyle({ size, margins }: PagePrintStyleProps) {
  return <style data-testid="notted-page-rule">{pageRuleCss(size, margins)}</style>;
}
