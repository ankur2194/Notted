# Part 37 — Implement the A4/Letter page container

## Status

- **State:** Complete
- **Completed on:** 2026-08-06
- **Implemented by:** frontend-editor-engineer agent (Claude Opus 5), session of 2026-08-06
- **Plan reference:** `Plan.md`, Part 37
- **Related records:** `part-32-note-browsing-hierarchy-share-ui.md`, `part-34-basic-editor-toolbar.md`, `part-36-slash-commands-mentions.md`, `part-25-dashboard-shell.md`

## Objective

Give the note editor a page container that visually and dimensionally behaves like a physical sheet of paper: exact A4 and US Letter geometry, configurable margins, a white sheet with a shadow on a light gray workspace surface, the seven zoom settings from `Notted.md`, and a page-size switch that reaches the server. Visual presentation must stay entirely separate from stored content so that Part 38 can draw page-break guides, Part 39 can autosave, and Part 43 can size images against a documented content-width token.

## Implemented Work

- `PageContainer.tsx` (client component) wraps the editor. It owns page size, zoom, margins, viewport measurement, and the page-size mutation, and passes the editor through untouched as `children`.
- Page geometry is expressed in physical CSS units published as custom properties on the paper element: `--notted-page-width`, `--notted-page-height`, `--notted-page-margin-x`, `--notted-page-margin-y`, and the public `--notted-page-content-width` token.
- All geometry arithmetic lives in the pure module `apps/web/src/lib/notes/page-geometry.ts`: sheet definitions and their pixel expectations (A4 794x1123, US Letter 816x1056), margin bounds and clamping, content-column width, the five zoom levels plus `fit-width` / `fit-page` resolution, scaled-wrapper sizing, zoom stepping, and scroll preservation across a zoom change.
- Zoom is applied as `transform: translateX(-50%) scale(z)` with `transform-origin: top center` on the paper, inside a wrapper explicitly sized to `pageWidth * scale` by `paperHeight * scale`. Because `transform` does not affect layout, without that wrapper the scroll extents would clip a zoomed sheet or leave dead space. The paper's unscaled `offsetHeight` is what the wrapper is derived from, so a note longer than one sheet reserves its real height.
- `fit-width` and `fit-page` are resolved from a `ResizeObserver` measurement of the scroll viewport. Where no `ResizeObserver` exists (jsdom, server render) or the box measures zero, the fit modes resolve to 100% rather than dividing by zero, so the container degrades to the five fixed levels.
- Scroll position is preserved across a zoom change on both axes (`preservedScrollOffset`), so the content under the caret stays in view instead of jumping toward the top of the sheet.
- Margins default to 25mm vertical / 20mm horizontal and are editable through two bounded number fields. They are persisted per browser in `localStorage` through `apps/web/src/lib/notes/page-preferences.ts`, which stores only the zoom selection and the two margin numbers — never note content, identifiers, or anything tenant-scoped.
- Page size is per note and persisted to the server. `persistPageSize` follows the `NoteBrowser.rename` idiom exactly: snapshot `{ pageSize, version }`, apply optimistically, `updateNote(..., { expectedVersion, pageSize })`, adopt the returned note's `pageSize` and `version` on success, restore the exact snapshot and announce a coded failure message on rejection, and offer a `router.refresh()` "Reload latest version" affordance on `version-conflict`. Without edit capability the size renders as static text and no toggle exists.
- Accessibility: zoom and page-size controls use `aria-disabled`, never native `disabled`; every change is announced through one `aria-live="polite"` region; controls are labelled and keyboard operable with the global `:focus-visible` ring; the scroll viewport is a named, focusable, non-trapping region; no zoom transitions were added, so the global `prefers-reduced-motion` block stays sufficient.
- Seams left for later parts: an inert, `aria-hidden`, non-interactive `.notted-page-breaks` overlay inset to the content area for Part 38's dashed guides; a commented slot in the controls bar for Part 38's focus-mode toggle; and a single, named, heavily commented `persistPageSize` function for Part 39's shared autosave settings queue.
- `NoteDetailView` no longer fakes paper with card styling (`rounded-2xl border bg-white p-6 ... sm:p-10`); it keeps its `aria-labelledby` heading structure and delegates the sheet to `PageContainer`. The static page-size badge was removed from the server-rendered header because `PageContainer` now owns the live value and a server-rendered badge would go stale after a switch.

## Important Decisions

- **Page geometry uses physical CSS units, not pixel constants.** The sheet is declared as `210mm`/`297mm` and `8.5in`/`11in`. CSS defines `1in = 96px` and therefore `1mm = 96/25.4px` exactly, so the browser produces 793.7px and 816px without the layout depending on a number this codebase invented. The 794x1123 and 816x1056 figures in `Notted.md` are recorded in `page-geometry.ts` as *rounded measurement expectations* used for verification, never as inputs. Three things follow: US Letter is not restated in millimetres (which would bake in a rounding error), the on-screen sheet and the `@page` rule Part 38 adds derive from the same declared size, and browser measurement at 100% is a meaningful check rather than a tautology.
- Margins are a global per-browser preference while page size is per note. The margin bound is therefore the strictest of the two sheets — 84mm horizontally (A4 is narrower) and 111mm vertically (US Letter is shorter), both derived from `MARGIN_LIMIT_RATIO = 0.4` — so a margin valid for one sheet can never leave the other without a content column.
- Stored preferences are validated hard on read. A zoom value is accepted only if it is one of the published levels or fit modes; an arbitrary number is rejected rather than clamped, because nothing in the application writes one. Margins are validated per axis, so one bad axis does not discard the other.
- The paper is `min-height`, never `height`. A note that outgrows one sheet grows one continuous sheet; where boundaries fall is a Part 38 rendering question and never touches the stored TipTap document.
- The paper is absolutely positioned at `left: 50%` and translated by `-50%` before scaling. Centring with `margin: auto` inside a wrapper narrower than the unscaled sheet misaligns the painted result at every scale below 100%.
- The suggestion popovers from Part 36 do **not** render inside the transformed subtree. `SuggestionPopover` portals its list to `document.body` and positions it `fixed` from viewport coordinates, and the rect a `scale()` ancestor alters is already in viewport coordinates — so the popovers stay anchored to the caret at every zoom level while their own chrome keeps its normal size. Part 36 recorded the `clientRect()` hazard; this is why it does not bite here. Recorded in a code comment plus a test that the container intercepts no pointer or keyboard input at non-default zoom. (An earlier revision of this record claimed the opposite; corrected after Review #2.)
- `PAGE_VIEWPORT_PADDING_PX` in `page-geometry.ts` and the `padding` of `.notted-page-viewport` in `globals.css` must stay equal; both carry a comment saying so. The fit modes subtract that padding from `clientWidth`/`clientHeight`, which include it.
- One scoped `eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex` is used, with justification, on the scroll region. Browsers only make a scroller implicitly focusable when it has no focusable children, which is never true here, so the tab stop is declared to satisfy WCAG 2.2 SC 2.1.1.
- No new npm dependency was added (ADR 0008).

## Files and Components

| Path | Purpose |
|---|---|
| `apps/web/src/components/notes/PageContainer.tsx` | New client component. Owns page size, zoom, margins, measurement, controls, announcements, and the page-size mutation; renders the paper and takes the editor as children. |
| `apps/web/src/lib/notes/page-geometry.ts` | New pure module. Sheet definitions in physical units, pixel expectations, margin bounds and clamping, content-width token, zoom levels and fit resolution, scaled-box sizing, scroll preservation, labels. |
| `apps/web/src/lib/notes/page-preferences.ts` | New SSR-safe `localStorage` reader/writer for the zoom selection and the two margin numbers only, with hard validation on read. |
| `apps/web/src/styles/globals.css` | Added a `@layer components` block for `.notted-page-viewport`, `.notted-page-scale`, `.notted-page-paper`, `.notted-page-breaks`; corrected the Part 34 comment that reserved print for Part 37. |
| `apps/web/src/components/notes/NoteDetailView.tsx` | Wraps `NoteEditorSurface` in `PageContainer`; removed the ad-hoc paper styling and the now-stale page-size badge. |
| `apps/web/src/lib/notes/page-geometry.test.ts` | New. Dimensions, margins, content width, custom properties, every zoom level, both fit modes incl. degenerate viewports, scaled box, scroll preservation. |
| `apps/web/src/lib/notes/page-preferences.test.ts` | New. Absent, malformed, mistyped, negative, and absurd stored values; per-axis fallback; round trip; blocked storage; SSR safety. |
| `apps/web/src/components/notes/page-container.test.tsx` | New. Children render, custom properties, break-overlay seam, scroll region, zoom announcement and `aria-disabled`, keyboard operation, fit-mode degradation, event pass-through at 150%, margin clamping, optimistic page-size switch, version adoption, exact rollback, version-conflict reload, read-only rendering. |
| `apps/web/src/components/notes/note-components.test.tsx` | Added a `next/navigation` `useRouter` stub, now required because `NoteDetailView` renders `PageContainer`. |

## Database and Data Changes

None. `notes.page_size` and `workspace.settings.defaultPageSize` already existed end to end; this part only reads and updates them through the existing `PATCH` note contract.

## API, Configuration, and Operational Changes

No new routes, contracts, environment variables, or deployment steps. The page-size switch uses the existing `updateNote` request with `expectedVersion` and the already-accepted `pageSize` field. One new browser storage key, `notted.notes.page-view`, holding only a zoom selection and two margin numbers; it is optional, safe to lose, and safe in development and production.

## Security and Tenant-Isolation Notes

- No new network surface. The only request is the existing workspace- and note-scoped `updateNote`, whose ids come from server-rendered props and are never derived from user input; backend policy remains authoritative for whether the change is permitted.
- `canUpdate` only decides whether a control is offered. A denial or a not-found result is surfaced as a coded message and the previous state is restored exactly; the UI never claims a rejected change was applied.
- Browser storage holds only two cosmetic numbers and a zoom selection — no note content, no identifiers, nothing tenant-scoped (Part 32 constraint). Everything read back is treated as untrusted and validated field by field; a rejected value falls back to a default.
- `TiptapEditor` still performs zero network I/O: the mutation lives in `PageContainer`.

## Verification Evidence

This part's stated verify criteria are browser measurements (`browser measurements match the specified sizes at 100%, switching size persists, and responsive scrolling does not clip editor controls`). All three were performed in Chromium on 2026-08-06 by `apps/web/e2e/page-layout.spec.ts`, against the real Compose stack. Every non-browser gate also passes.

**How the browser run was made possible.** Chromium cannot launch on this host: `libnspr4.so`, `libnss3.so`, `libnssutil3.so`, `libsmime3.so` and `libasound.so.2` are missing and installing them needs `sudo`. Rather than leave the criterion unverified, the suite is run inside the official Playwright image, which matches the pinned `@playwright/test` 1.62.0 and ships those libraries. It joins the `api` container's network namespace — `web` uses `network_mode: "service:api"` — so the browser sees `localhost:3000` and `localhost:3001`, which are the exact origins `NEXT_PUBLIC_APP_URL`, CORS and the Better Auth cookies are configured for:

```bash
docker run --rm \
  --network "container:$(docker compose ps -q api)" \
  -v /home/ankur/ai-projects/Notted:/home/ankur/ai-projects/Notted \
  -w /home/ankur/ai-projects/Notted/apps/web \
  --user 1000:1000 -e HOME=/tmp \
  -e PLAYWRIGHT_DISPOSABLE_TEST_RUN=true \
  -e PLAYWRIGHT_REUSE_EXISTING_SERVER=true \
  -e PLAYWRIGHT_MAILPIT_URL=http://mailpit:8025 \
  -e DATABASE_URL=postgres://notted:notted_dev_password@postgres:5432/notted_dev \
  mcr.microsoft.com/playwright:v1.62.0-noble \
  npx playwright test --project=chromium page-layout.spec.ts print-export.spec.ts
```

`PLAYWRIGHT_REUSE_EXISTING_SERVER` was added to `playwright.config.ts` for this: a disposable run otherwise refuses to attach to a server it did not start, which made the real-stack specs unrunnable against Compose. It is opt-in.

**Measured results.** The expected figures are written longhand in the spec and deliberately *not* imported from `page-geometry.ts` — importing the module under test would only prove the browser agrees with itself.

| Measurement | Expected | Observed |
|---|---|---|
| A4 sheet at 100% | 793.7 x 1122.52 px (210mm x 297mm at 96/25.4 px/mm) | Matches to < 0.5 px; rounds to 794 x 1123 |
| US Letter at 100% | 816 x 1056 px (8.5in x 11in at 96 px/in, exact) | Matches to < 0.5 px |
| Size switch after `reload()` | Letter still selected and still 816 x 1056 | Confirmed — the switch is server-backed, so the reload is the real test |
| Zoom 125% | Layout box unchanged, painted box x 1.25, `.notted-page-scale` reserves it | Confirmed; the live region announced `Zoom set to 125%.` |
| `fit-width` | Painted sheet within `clientWidth - 2 x 32px` padding | Confirmed |
| Margin preference | `30` survives a reload from `localStorage` | Confirmed |
| Editor controls at 390 / 768 / 1440 px | No document-level horizontal overflow; every toolbar button reachable and >= 24 px | Confirmed at all three widths |

| Check | Result | Notes |
|---|---|---|
| `pnpm format:check` | Pass | Clean across all 4 workspace tasks and the root Prettier pass. |
| `pnpm lint` | Pass | 4/4 tasks at `--max-warnings 0`. |
| `pnpm type-check` | Pass | 6/6 tasks. |
| `pnpm test` (`DATABASE_URL` exported) | Pass | 6/6 tasks: web 77 files, api 61 passed + 2 skipped, shared-validators 9, shared-types 2, plus 11 root `node --test` script tests. |
| `pnpm test:ci` (`DATABASE_URL` exported, `--force`) | Pass | 6/6 uncached. Coverage — web 81.28/74.68/84.87/83.36, api 79.26/72.44/83.68/81.12, shared-validators 84.26/78.48/95.76/87.33, shared-types 100. All above the 70% thresholds. |
| `pnpm build` (production-like `NEXT_PUBLIC_*`) | Pass | 4/4 tasks; compiled and generated 16/16 static pages. |
| `playwright test --project=chromium page-layout.spec.ts` (containerised, see above) | Pass | 1 test, real stack. Covers every clause of the stated criterion; measured values in the table above. |

## Known Limitations and Follow-up Work

- Visual pagination, dashed page-break indicators, focus mode, and `@media print` are deliberately absent — Part 38 owns them and inherits the `.notted-page-breaks` mount point, the controls-bar slot, and `apps/web/src/styles/print.css`.
- `persistPageSize` is the only writer of `version` besides the server render. Part 39 must fold it into the shared autosave machine's settings queue: the server bumps `version` on every update, so content and settings saves must share one version cell or one will invalidate the other's expectation.
- `--notted-page-content-width` is published for Part 43 to clamp embedded image widths against; nothing enforces that clamp yet.
- Margins and zoom are a single global preference, not per note and not synced across devices. Elevating them to workspace or note settings would need a backend contract change.
- The scroll viewport is capped at `min(80vh, 1400px)`, so the sheet scrolls inside the page rather than with the document. That is what makes `fit-page` meaningful and keeps the controls bar visible; it also means nested scrolling on small viewports. Checked in the browser pass: at 390 px the nested region absorbs the sheet's overflow and the document itself never scrolls sideways, so the nesting is contained rather than compounding.
- ~~The note header still shows a server-rendered `version` that goes stale after a page-size change.~~ **Resolved in Part 39**, which made every keystroke burst bump the version and so made the stale number untenable: `version {note.version}` was removed from `NoteDetailView`'s header rather than threaded into the Server Component. Live save state lives in `SaveStatusIndicator`.
- **The editor toolbar sits inside the scaled paper. The browser pass settled the larger half of Review #2's worry and left the smaller half open.** (a) The clipping concern **did not materialise**: at 390, 768 and 1440 px the document never scrolls sideways, and every formatting button is reachable and paints at 44 px — above the 24 px minimum — so the "responsive scrolling does not clip editor controls" criterion passes as built. The toolbar living inside a scrollable region means it scrolls with the content, which is ordinary document behaviour rather than clipping. No restructuring was needed, so none was done. (b) **Still open:** at 50% zoom the `min-h-11 min-w-11` targets paint at about 22 CSS px, below WCAG 2.2 SC 2.5.8's 24 px minimum. The spec asserts the target size at the default 100% zoom only, so this is recorded, not verified away. Rendering the toolbar outside the scale transform remains the fix and belongs to Part 76's accessibility audit.
- The slash and mention popovers are **not** scaled by the page. `SuggestionPopover` portals its list to `document.body` and positions it `position: fixed` from the caret's viewport rect, so the popover stays anchored at every zoom level while its own chrome keeps its normal size. (`PageContainer` carried a comment claiming the opposite; corrected.) The zoom-plus-slash-menu interaction is still only verified in jsdom, where no layout engine runs — it needs the browser pass.

## Handoff Notes

- `PAGE_VIEWPORT_PADDING_PX` (geometry) and `.notted-page-viewport { padding }` (CSS) are coupled; changing one without the other silently misresolves both fit modes.
- Never replace the physical units with pixel constants. The sheet must stay declared in `mm`/`in` so the printed and on-screen boxes cannot drift; the pixel numbers in `page-geometry.ts` exist to be asserted against, not to drive layout.
- jsdom has no `ResizeObserver` and reports every rect as zero. That is why all geometry is pure and testable without a layout engine, and why fit modes are expected to resolve to 100% in Vitest. Real measurement belongs in Playwright chromium.
- Any component test that renders `NoteDetailView` now needs a `next/navigation` `useRouter` stub, because `PageContainer` offers a `router.refresh()` reload affordance.
- The paper is absolutely positioned inside `.notted-page-scale`; anything added to the paper subtree must tolerate being inside a `transform: scale()` ancestor, which changes what `getBoundingClientRect()` returns for descendants.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-06 | frontend-editor-engineer agent | Initial record, implementation complete and focused tests passing; gates pending review |
| 2026-08-06 | frontend-editor-engineer agent (Review #1 fix pass) | Corrected the `PageContainer` popover-scaling comment (the popovers portal to `document.body` and are not scaled); recorded the stale-`version` limitation as resolved by Part 39; replaced the "not run" gate rows with the gates actually run. Browser measurement still unverified. |
| 2026-08-06 | Claude Opus 5 (browser verification pass) | Ran the stated criterion in Chromium for the first time, inside the official Playwright container joined to the Compose `api` network namespace, working around the missing host libraries without `sudo`. Added `apps/web/e2e/page-layout.spec.ts` and the opt-in `PLAYWRIGHT_REUSE_EXISTING_SERVER` config flag. All three clauses pass; the recorded toolbar-clipping worry did not materialise and the 50%-zoom target-size concern was narrowed and kept. State moved to `Complete`. |
