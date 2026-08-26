/**
 * The chrome that must not survive into a printed page, shared by every spec
 * that proves it.
 *
 * NOT a `*.spec.ts`: `playwright.config.ts` collects only that pattern from
 * `./e2e`, so a plain module is safe here — the `./accounts.ts` and
 * `./mailpit.ts` precedent. The list lives here rather than being exported
 * from `print-export.spec.ts` for a stronger reason than tidiness: importing a
 * spec file *executes* it, so its `test.describe` blocks would re-register —
 * and re-run — inside whichever file merely wanted the array.
 */

/**
 * Chrome that `print.css` must remove from every snapshot. That file is
 * `@notted/shared-validators/print.css`, imported by `src/styles/globals.css`
 * and loaded standalone by the Part 63 Puppeteer exporter — the same bytes on
 * both paths, which is why one list can stand for both.
 */
export const PRINT_HIDDEN_SELECTORS = [
  ".notted-page-controls",
  ".notted-page-breaks",
  '[data-testid="note-layout-status"]',
  '[role="toolbar"]',
  "#workspace-navigation",
  ".skip-link",
] as const;
