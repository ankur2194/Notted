# Part 38 — Add page breaks, focus mode, and print styling

## Status

- **State:** Complete
- **Completed on:** 2026-08-06
- **Implemented by:** frontend-editor-engineer agent (Claude Opus 5), implementation-only delegation
- **Plan reference:** `Plan.md`, Part 38
- **Related records:** `docs/completed-parts/part-33-*`, `part-34-*`, `part-35-*`, `part-36-*`, `part-37-*`

## Objective

Give a note explicit, persisted page breaks; indicate where content overflows a printed
sheet without ever changing what is stored; add a focus mode that hides application
chrome and restores the prior layout when it is turned off; and produce print CSS that
outputs note content only, with a correct `@page` box, respected explicit breaks, and
common blocks kept whole. Part 63 (PDF and HTML export) reuses the page-break markup,
the `@page` builder, and `styles/print.css` directly.

## Implemented Work

- **`pageBreak` in the shared document contract (first).** `packages/shared-validators`
  now accepts `{ "type": "pageBreak" }` as a block node: no children, no marks, no
  attributes, no stray fields. `renderDocumentHtml` emits
  `<div class="notted-page-break"></div>`; the plain-text projection contributes nothing,
  byte for byte the same as `horizontalRule`, so `contentPlain` and search are unchanged.
  `normalizeUnsupportedNodes` recovers a malformed historical break the same way it
  recovers a malformed rule. `NOTE_DOCUMENT_SCHEMA_VERSION` stays `1` — the widening is
  purely additive, exactly as Parts 35 and 36 were.
- **TipTap extension.** `createPageBreakExtension()` registers a leaf atom named
  `pageBreak` with `parseHTML`/`renderHTML` matching the contract's class, plus a
  `setPageBreak()` command that splits the current block and guarantees the document does
  not end on an atom. Registered from `createNoteEditorExtensions()`, exported from the
  extensions barrel.
- **Slash command and shortcuts.** One `/page-break` entry appended to `SLASH_COMMANDS`.
  Two entries appended to `EDITOR_SHORTCUTS`: `Mod-Shift-Enter` → `insertPageBreak` and
  `Mod-Shift-f` → `toggleFocusMode`, both routed through the existing
  `EditorShortcuts.resolveHandlers` seam the way `Mod-k` is. A new `view` shortcut group
  holds focus mode. Tab is untouched: `NoteBlockTab` remains the sole Tab authority.
- **Non-destructive overflow indicators.** `pageBoundaryOffsets()` in
  `lib/notes/page-geometry.ts` is a pure function taking the measured content height, the
  printable page-content height (`pageContentHeightPx()`), and the measured offsets of the
  explicit break nodes, returning `{ offset, kind, page }` guides. `PageContainer` paints
  them into the `aria-hidden`, `pointer-events: none` overlay Part 37 left, measuring
  through one `ResizeObserver` on the scroll viewport, the paper, and a new content
  wrapper — never on render. Nothing is written back to the document.
- **Focus mode.** `lib/notes/focus-mode.ts` is a ~40-line client-only store holding one
  boolean and writing `data-notted-focus` to `document.documentElement`. `PageContainer`
  owns the `aria-pressed` toggle button, the polite announcement (fired for *any* change,
  including the editor shortcut), `Escape` to exit with focus returned to the toggle, and
  an unmount cleanup that clears the attribute. `TiptapEditor` owns the keybinding and
  swaps `EditorToolbar`'s `groups` for `FOCUS_TOOLBAR_GROUPS`, a table derived from
  `EDITOR_TOOLBAR_GROUPS`. Chrome opts out through `data-notted-focus-hide`.
- **Print.** New `apps/web/src/styles/print.css`, plain CSS, imported from `globals.css`.
  It hides chrome, neutralises the zoom transform / shadow / scroll cap / surfaces,
  applies `break-after: page` to `.notted-page-break`, `break-inside: avoid` to tables,
  quotes, code, task items and figures, `orphans`/`widows: 2`, and
  `print-color-adjust: exact`. The header/footer band is left empty for Part 63's
  Puppeteer templates. `PagePrintStyle` emits the per-note `@page` rule from
  `pageRuleCss()`.

## Important Decisions

- **`Notted.md:127-130` names both `styles/editor.css` and `styles/print.css`; only
  `print.css` was created.** It is genuinely required standalone (Part 63 loads it into
  Puppeteer beside `renderDocumentHtml` output, and its criterion is that export fixtures
  match editor print output), so it is plain CSS with no Tailwind directives and no
  dependency on the Next.js shell. `editor.css` was **not** created: Parts 34-36 put all
  editor styles in `globals.css`, and splitting them now would be unrelated refactoring
  with real regression risk and no consumer asking for it. Recorded here per `AGENTS.md`.
- **Contract first, then editor.** Part 33's rule ("do not add an editor-only node the
  backend contract cannot validate") is why `document.schema.ts` changed before the TipTap
  extension existed. Had the order been reversed, a note containing a break would have
  been rejected by the API — and, once Part 39 lands, silently unsaved.
- **A `div`, not an `hr`.** `break-after: page` on a block box is unambiguous in every
  engine, an `hr` carries a thematic-separator semantic the node does not mean, and the
  divider command already owns `hr`. On screen the break is a dashed accent rule with a
  caption so it is never confused with a divider; it carries `role="separator"` and an
  accessible name, and the caption is decorative and removed when printing.
- **No schema-version bump.** Additive widening only. The Part 33 record requires a
  persisted version column and a reviewed backfill before a bump, neither of which exists.
- **Focus mode is not persisted.** `page-preferences.ts` was left alone. Zoom and margins
  are harmless to restore; a hidden-chrome mode that silently outlives the session it was
  chosen in is not. A reload always returns the full layout.
- **A small hand-written store rather than Zustand.** Zustand is not in the pinned matrix
  (ADR 0008) and no dependency may be added. The mode is genuinely shared client-only
  state across two components that cannot pass props (the editor reaches `PageContainer`
  as opaque `children` from a Server Component), so a `useSyncExternalStore`-backed module
  is the smallest thing that works.
- **The floating toolbar is portalled to `document.body`.** `.notted-page-paper` always
  carries a transform (`translateX(-50%)` plus the zoom scale), and a transformed ancestor
  becomes the containing block for `position: fixed` descendants. Rendered in place the
  bar would be pinned to and scaled with the sheet. The portal keeps the React tree — and
  therefore the roving tab index and every dialog — intact.
- **The focus toggle is never hidden by focus mode.** A control that disappears the moment
  it is used leaves no way back by mouse and nothing for `Escape` to restore focus to.
- **Bindings checked for collisions before committing.** `Mod-Shift-Enter`: StarterKit
  claims only `Enter`, `Mod-Enter`, and `Shift-Enter`, and ProseMirror matches the whole
  modifier set rather than a subset, so `Shift-Enter` cannot swallow it. `Mod-Shift-f`:
  the only `Mod-Shift-<letter>` bindings in play are s, b, l, e, r, j, z (this table) and
  Highlight's `Mod-Shift-h`. Neither collides; neither needed replacing.
- **Guide geometry is modelled on the continuous column.** The on-screen paper is one
  sheet with a single top and bottom margin, so printing slices it every
  `pageContentHeightPx`. That is what the guides step by. It is an indicator, not a print
  preview; real pagination is verified in the browser.

## Files and Components

| Path | Purpose |
|---|---|
| `packages/shared-validators/src/document.schema.ts` | `pageBreak` node type, block membership, leaf/attr/mark rules, HTML render, migration recovery, `NOTE_DOCUMENT_PAGE_BREAK_CLASS` |
| `packages/shared-validators/src/document.schema.test.ts` | Part 38 contract suite: acceptance, rejection matrix, HTML, plain text, migration, version |
| `packages/shared-validators/src/index.ts`, `note.schema.ts` | Re-export the new class constant |
| `apps/web/src/components/editor/extensions/page-break.ts` | The `pageBreak` TipTap node and `setPageBreak()` |
| `apps/web/src/components/editor/extensions/note-editor-extensions.ts` | Registers the node in the per-instance factory |
| `apps/web/src/components/editor/extensions/index.ts` | Barrel re-exports |
| `apps/web/src/components/editor/slash-commands.ts` | `/page-break` entry |
| `apps/web/src/components/editor/keyboard-shortcuts.ts` | `pageBreak` and `focusMode` shortcuts, `view` group, two handler ids |
| `apps/web/src/components/editor/toolbar-commands.ts` | `FOCUS_TOOLBAR_GROUPS`, derived from `EDITOR_TOOLBAR_GROUPS` |
| `apps/web/src/components/editor/TiptapEditor.tsx` | Both new shortcut handlers; portalled focus toolbar |
| `apps/web/src/lib/notes/focus-mode.ts` | The focus-mode store and `data-notted-focus` |
| `apps/web/src/lib/notes/page-geometry.ts` | `pageContentHeightPx`, `pageBoundaryOffsets`, `pageRuleCss`, `MAX_PAGE_BOUNDARIES` |
| `apps/web/src/components/notes/PageContainer.tsx` | Content measurement, guides, focus toggle, Escape handling, announcements, unmount restore |
| `apps/web/src/components/notes/PagePrintStyle.tsx` | Emits the per-note `@page` rule |
| `apps/web/src/components/notes/NoteDetailView.tsx` | Marks breadcrumbs and the header card as chrome |
| `apps/web/src/components/layout/DashboardShell.tsx`, `TopBar.tsx` | Mark the sidebar and top bar as chrome; `notted-shell-offset` hook |
| `apps/web/src/styles/print.css` | Standalone print stylesheet (Part 63 reuses it directly) |
| `apps/web/src/styles/globals.css` | Imports `print.css`; page-break node, guide, and focus-mode rules |

## Database and Data Changes

None. `pageBreak` is a leaf node inside the existing `notes.content` JSON column; the
contract version is unchanged and no migration, backfill, or seed change is required.
Rollback is safe in one direction only: a note saved with a break, opened by a build
without the contract change, would fail validation and be recovered to text. That is the
usual constraint on an additive contract change and is why the contract shipped first.

## API, Configuration, and Operational Changes

No new routes, environment variables, queues, ports, or feature flags. The API's note
validation now accepts one additional node type through the shared contract; both the
tRPC and `/api/v1` surfaces pick it up automatically because both reuse
`noteDocumentSchema`. `packages/shared-validators/dist` was rebuilt so the web app
resolves the new export. Defaults are safe for development and production.

## Security and Tenant-Isolation Notes

- The node carries no attributes at all, so there is no attacker-controlled value to
  validate, escape, or render. `NODE_ALLOWED_FIELDS.pageBreak` is `{ "type" }` and
  `NODE_ALLOWED_ATTRS.pageBreak` is empty; children, marks, and stray fields are rejected.
- `renderDocumentHtml` emits a fixed literal string with no interpolation.
- `pageRuleCss()` interpolates only frozen `PAGE_SIZES` dimensions and `clampMargins()`
  output (whole millimetres inside `MAX_PAGE_MARGINS`), so no caller-supplied string can
  reach the emitted `<style>`. CSS injection through the `@page` rule is not possible.
- Focus mode and the guides are local view state; nothing is persisted to browser storage
  and no request is made. `TiptapEditor` still performs zero network I/O.
- No authorization or tenant-scoping surface changed. Backend policy remains authoritative;
  the focus toggle is offered regardless of `canUpdate` because reading a note in focus
  mode requires no write permission.

## Verification Evidence

Both stated criteria were performed in Chromium on 2026-08-06 by `apps/web/e2e/print-export.spec.ts`, against the real Compose stack. The containerised invocation, and why it was needed, is documented in the Part 37 record's Verification Evidence section; the same command runs both specs.

**A4 and Letter snapshots.** Real PDFs, written to `apps/web/test-results/playwright/print-export-*/` and attached to the run:

| Snapshot | MediaBox | Pages |
|---|---|---|
| `note-a4.pdf` | 594.96 x 841.92 pt (210mm x 297mm, Chromium rounds to 0.01 pt) | 2 |
| `note-letter.pdf` | 612 x 792 pt (8.5in x 11in, exact) | 2 |

`page.pdf({ preferCSSPageSize: true })` takes the sheet size from the generated `@page` rule, so these figures prove the rule actually drives the output rather than a default paper size. The page counts are the pagination check: the note holds two short paragraphs separated by one explicit `pageBreak`, and each sheet size yields exactly two pages, so the break — not content overflow — is what started the second page. The PDFs are parsed for `/MediaBox` and `/Type /Page` directly from the bytes, inflating any Flate streams with `node:zlib`, so no PDF dependency was added (ADR 0008).

**"Only note content"** is asserted against the DOM under `page.emulateMedia({ media: "print" })`, where `print.css` is genuinely in effect — the strongest available form, since PDF text is subset-encoded and not reliably readable without a font-mapping parser. Under print media the spec confirms zero visible `button`, `nav`, `input` or `select` elements anywhere on the page, plus specifically that `.notted-page-controls`, `.notted-page-breaks`, the layout live region, `[role="toolbar"]`, `#workspace-navigation` and `.skip-link` are all hidden, while the note body remains visible. Links are deliberately excluded from that sweep: a link inside a note is content and should print. It also confirms the paper drops `transform`, `position` and `padding` in print, so `@page` alone owns the margins.

**Focus mode** is confirmed by mouse (the toggle sets `data-notted-focus`, hides `[data-notted-focus-hide]`, and shows the floating toolbar), by `Escape` (exits and returns focus to the toggle), and by the `Mod+Shift+F` keybinding from inside the editor.

**One real defect was found and fixed by this pass.** `setPageBreak()` inserted the break and left the atom *node-selected*, so the very next character a writer typed replaced it — insert a page break, keep typing, and the break silently disappeared. No jsdom test could catch it, because calling the command directly never types the next character. `page-break.ts` now moves the caret into the block after the break, and `editor-page-break.test.tsx` gained a regression test that was confirmed to fail against the old command and pass against the new one.

| Check | Result | Notes |
|---|---|---|
| `pnpm format:check` | Pass | Clean across all 4 workspace tasks and the root Prettier pass. |
| `pnpm lint` | Pass | 4/4 tasks at `--max-warnings 0`. |
| `pnpm type-check` | Pass | 6/6 tasks. |
| `pnpm test` (`DATABASE_URL` exported) | Pass | 6/6 tasks: web 77 files, api 61 passed + 2 skipped, shared-validators 9, shared-types 2, plus 11 root `node --test` script tests. |
| `pnpm test:ci` (`DATABASE_URL` exported, `--force`) | Pass | 6/6 uncached. Coverage — web 81.28/74.68/84.87/83.36, api 79.26/72.44/83.68/81.12, shared-validators 84.26/78.48/95.76/87.33, shared-types 100. All above the 70% thresholds. |
| `pnpm build` (production-like `NEXT_PUBLIC_*`) | Pass | 4/4 tasks; compiled and generated 16/16 static pages. |
| `playwright test --project=chromium print-export.spec.ts` (containerised, see Part 37 record) | Pass | 1 test, real stack. Produced both PDF snapshots and covers focus mode by mouse and keyboard. |

## Known Limitations and Follow-up Work

- ~~**Print/PDF pagination is unverified in a browser.**~~ **Resolved.** `apps/web/e2e/print-export.spec.ts`
  now produces and asserts the A4 and Letter snapshots in Chromium; see Verification
  Evidence. jsdom still reports every rect as zero and has no `ResizeObserver`, which
  remains why the boundary arithmetic is a pure function — the browser run checks the
  printed output, not the on-screen guides.
- **The on-screen overflow guides are still only verified in jsdom.** The browser pass
  checks printed pagination, which is what the Plan criterion asks for; it does not
  measure where the dashed guides land relative to the real page boundaries. Those two can
  disagree, because the guides are drawn against the on-screen paper while print re-lays
  the content under `@page`. Worth measuring during Part 76.
- **The focus-mode keybinding does not fire on a read-only note.** `EditorShortcuts`
  registers through ProseMirror's keymap, and `prosemirror-view` only routes `keydown`
  through its `editHandlers`, gated on `view.editable` — so no editor-scoped binding
  reaches a read-only note. Judged acceptable: focus mode stays fully available there
  through `PageContainer`'s `Focus mode` button, which is a real `<button>` rendered for
  read-only notes too, and `Escape` still exits through a document-level listener. This is
  asserted in `editor-page-break.test.tsx`. The one honest wart is that
  `KeyboardShortcutsDialog` advertises `Mod+Shift+F` unconditionally, including on a
  read-only note where it will not fire. Promoting the binding to a `global`-scope
  shortcut would fix both and is a small, self-contained follow-up.
- **The portalled focus toolbar sits at the end of the tab order**, because it is a child
  of `document.body`. Judged low impact: no focus is actually lost when the mode is
  toggled — the React tree, and so the roving tab index and every dialog, is unchanged —
  and `Escape` plus the always-visible toggle keep the mode escapable. A future part may
  still want a roving landmark or an explicit focus hand-off.
- **`EditorToolbar` remounts when focus mode is toggled**, because it moves between the
  in-place position and the portal. Judged low impact for the same reason: nothing that
  was focused is destroyed by the toggle in practice, and the toggle button itself lives
  in `PageContainer`, outside the portalled subtree. Worth revisiting only if a future
  part gives the toolbar focusable state that must survive the move.
- **The break guides drift slightly from print pagination.** `readExplicitBreaks` measures
  the on-screen `.notted-page-break` element, which carries `margin: 1.75em 0` from
  `globals.css`, whereas `print.css` sets `margin: 0` on the same node. So a guide's offset
  is a few pixels below where the printed break actually falls. Cosmetic only: the guides
  are advisory, nothing is written back to the document, and print pagination is the
  browser's, not the guides'.
- **A much larger source of the same drift was fixed after Review #2.** Pagination was
  originally measured from `.notted-page-content`, which also carries the editor toolbar
  and the migration / read-only notices — all of them chrome that `print.css` hides. That
  pushed every implicit boundary down by roughly the toolbar's height (about 12% of an A4
  column). Measurement now runs on the `.notted-editor-content` prose column, and the
  distance from the paper's content box to the first printed line is tracked separately as
  `flowOffset` so the overlay still lines up. The remaining drift is only the margin
  difference described above.
- **The guides model the continuous on-screen column**, not per-page margin repetition.
  This matches how the paper actually flows on screen and is an indicator rather than a
  print preview.
- **Part 63** must reuse `styles/print.css` and `pageRuleCss()` rather than restating
  either, or exported PDFs will drift from what the editor showed.
- **Part 39 (autosave)** must treat a page break like any other content change; nothing
  here persists.

## Handoff Notes

- `packages/shared-validators` is consumed through `dist`, not `src`. Run
  `pnpm --filter @notted/shared-validators build` after touching the contract or the web
  app will not see the new export.
- Three suites assert **exact set equality** and will fail the moment a command or
  shortcut is added without a behavioural expectation: `editor-slash-commands.test.tsx`
  (`COMMAND_EXPECTATIONS`), `editor-shortcuts.test.tsx` (`EDITOR_CASES` +
  `GLOBAL_CASE_IDS`), and `suggestion-modules.test.ts` (the ordered id list).
  `keyboard-shortcuts-dialog.test.tsx` asserts the row count equals
  `EDITOR_SHORTCUTS.length`. Do not weaken any of them.
- The focus-mode store is module-level. Tests that toggle it **must** reset it
  (`afterEach(() => setFocusMode(false))`), or the attribute leaks into the next test in
  the same file. Three suites already do this.
- `.notted-page-paper` always has a transform. Anything that needs `position: fixed`
  relative to the viewport from inside the page must be portalled out, as the focus
  toolbar is.
- `print.css` must stay plain CSS with no Tailwind directives and no dependency on the app
  shell — Part 63 loads it standalone.
- Chrome hides itself by carrying `data-notted-focus-hide` and/or `data-notted-print-hide`.
  Add the attribute to new chrome rather than adding a component-specific selector to
  either stylesheet.

## Amendment — 2026-08-16: `print.css` and page geometry relocated for Part 63

Part 63 (PDF and HTML export) needed the same `@page` rule and the same print stylesheet
this part built, rendered server-side in `apps/api` rather than in the browser. Two files
this record lists under **Files and Components** moved out of `apps/web` as a direct
consequence:

- **`apps/web/src/styles/print.css`** moved, via `git mv`, to
  **`packages/shared-validators/print.css`** at that package's root — not under `src/`,
  since it is a plain CSS asset, not TypeScript source to compile. It is exposed through
  the package's `exports` map as `"./print.css"` (alongside the package's normal `"."`
  entry) and listed in `files` so it ships in the published package contents. `globals.css`
  now imports it by the bare specifier `@import "@notted/shared-validators/print.css";`
  rather than a relative path, so the one stylesheet has exactly one location regardless of
  which app resolves it.
- **`apps/web/src/lib/notes/page-geometry.ts`**, and its colocated test, moved to
  **`packages/shared-types/src/page-geometry.ts`** and is re-exported from that package's
  barrel (`export * from "./page-geometry"`). This is the pure, framework-free arithmetic
  this record's Implemented Work section describes (`PAGE_SIZES`, `pageRuleCss`,
  `clampMargins`, `pageBoxPx`, `exactPx`, and the rest) — no DOM, no React, no Zod — so the
  move is a relocation, not a rewrite.

**Why it had to move rather than being imported in place:** ADR 0001 forbids one app
importing another app's source, and the production API container image contains no
`apps/web` sources at all — there is nothing there for `apps/api` to reach into even if the
architecture allowed it. `packages/shared-types` and `packages/shared-validators` are the
one place both `apps/web` and `apps/api` already depend on, so that is where code needed by
both belongs.

**Consequence for a future reader:** the print stylesheet and the page geometry now have
**two consumers**, not one. A change to either affects both the editor's on-screen print
output (`PagePrintStyle`, `globals.css`) **and** every PDF/HTML artifact Part 63's export
renderer produces (`apps/api/src/export/export-html.ts`, which reads `print.css` verbatim
through `printStylesheet()` and builds the same `@page` rule through `pageRuleCss()`). This
record's existing **Files and Components** table and the `print.css` path referenced
throughout **Implemented Work** and **Important Decisions** above describe the file at its
original `apps/web` location as it stood when this part was completed on 2026-08-06; they
are left as written, per this repository's append-only convention for completed-part
records, rather than edited to chase the move.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-06 | frontend-editor-engineer (Claude Opus 5) | Initial record, state In progress |
| 2026-08-06 | frontend-editor-engineer (Review #1 fix pass) | Recorded four accepted limitations (read-only `Mod+Shift+F` and the dialog advertising it unconditionally, the portalled toolbar's tab-order position, the `EditorToolbar` remount on toggle, and the break-guide margin drift versus print); fixed the ESLint ignore gap that made `pnpm lint` unrunnable after a local Playwright run; recorded the gates actually run. Print/PDF snapshots still unverified. |
| 2026-08-06 | Claude Opus 5 (browser verification pass) | Produced the A4 and Letter PDF snapshots in Chromium for the first time via `apps/web/e2e/print-export.spec.ts`, run inside the official Playwright container. Found and fixed a real defect the browser alone could expose: `setPageBreak()` left the break node-selected, so the next typed character deleted it — the caret now lands in the block after the break, with a regression test proven to fail against the old command. State moved to `Complete`. |
| 2026-08-16 | backend-platform-engineer agent (Claude Sonnet 5) | Amendment: recorded `print.css`'s move to `packages/shared-validators/print.css` and `page-geometry.ts`'s move to `packages/shared-types/src/page-geometry.ts`, both made by Part 63 so the API's PDF/HTML export renderer can reuse them without an app importing an app (ADR 0001). No behavioural change to this part's own scope. |
