# Part 34 — Build the basic editor and toolbar

## Status

- **State:** Complete
- **Completed on:** 2026-08-03
- **Implemented by:** Frontend-editor implementation subagent, two independent quality reviews, one fix pass, and lead resolution
- **Plan reference:** `Plan.md`, Part 34
- **Related records:** Parts 31, 32, and 33; Parts 35 and 36 (same session); ADRs 0001 and 0008

## Objective

Turn the Part 33 document contract into the actual editing surface: a TipTap editor instance, a complete formatting toolbar that reflects active state, and a keyboard-shortcut help dialog whose listed bindings are guaranteed to work.

## Implemented Work

- Added `TiptapEditor.tsx`, the single client boundary that owns the editor instance. It migrates and validates its input through `prepareNoteDocumentForEditor` before TipTap ever sees it, renders migration-notice and safe-error states, sets `immediatelyRender: false` so Next.js SSR does not produce a hydration mismatch, and destroys the instance on unmount.
- Added `EditorToolbar.tsx` as a data-driven toolbar over `EDITOR_TOOLBAR_GROUPS`: block type (paragraph, headings 1–6), bold, italic, underline, strike, inline code, subscript, superscript, the 15 contract font sizes, four alignments, text colour, highlight, link, bullet/ordered/task lists, blockquote, horizontal rule, code block, undo, and redo. Every control reports active state and carries a matching accessible name and tooltip.
- Implemented the toolbar as an APG roving-tabindex widget: one tab stop, Left/Right/Home/End navigation, wrap-around, and 44px minimum touch targets, so the toolbar stays keyboard-operable when it wraps on narrow screens.
- Added `KeyboardShortcutsDialog.tsx` with `Cmd/Ctrl + /` and bare `?` triggers (the `?` trigger is suppressed inside the editor and inside form controls) plus a visible toolbar button, so keyboard-only users have a non-shortcut path.
- Added `keyboard-shortcuts.ts` as the single source of truth for bindings. The help dialog renders from it and the `EditorShortcuts` extension registers from it, so the advertised list and the real keymap cannot drift.
- Added `LinkDialog.tsx` and `ColorPickerDialog.tsx` in place of `window.prompt` and an unconstrained colour input. Links are validated with `sanitizeDocumentUrl` before application; colours come from a fixed `#rrggbb` palette that is re-validated before it touches the document.
- Added `document-sync.ts` (`stableStringify`, `areDocumentsEquivalent`) so the reconciliation effect only calls `setContent` when the incoming document genuinely differs from the editor's own JSON.
- Replaced the "Editor not available yet" placeholder in `NoteDetailView.tsx` with the live editor, gated deny-by-default on `note.capabilities.canUpdate === true && !note.isDeleted`.

## Important Decisions

- **The editor performs no network I/O.** Part 39 owns autosave; Part 34 exposes `onDocumentChange` and `onEditorReady` as seams and nothing more. A test asserts `fetch` is never called from `TiptapEditor`, and that assertion must keep passing.
- **Content restoration on remount** required normalizing the incoming document through `editor.schema.nodeFromJSON(...).toJSON()` before comparing it. Without that, ProseMirror's filled-in default attributes made every mount look like a change, which pushed a spurious `setContent` into the history and made Undo appear available on a pristine note.
- **TipTap 2.27.1 already binds `Mod-Shift-s` to strike**, so no custom binding was added for it. The only documented shortcut TipTap lacks is `Mod-k` (insert link), which the `EditorShortcuts` extension supplies. `Mod-k` is deliberately editor-scoped only: `Notted.md` reserves global `Cmd/Ctrl+K` for the future global search bar.
- **Undo/redo use `aria-disabled`, not the native `disabled` attribute.** A natively disabled button is unfocusable and would break the roving tab index; the click handlers no-op when unavailable.
- **Read-only mode renders only the help group** of the toolbar rather than a fully disabled toolbar, so formatting controls are genuinely absent while the shortcuts dialog stays reachable.
- Radix restores focus to a `DialogTrigger`, but these dialogs are opened programmatically, so `useDialogFocusRestore` tracks the last focus outside the dialog and restores it in `onCloseAutoFocus`.
- **The note body is now client-rendered only.** `NoteDetailView` no longer emits a server-derived plain-text projection, so the server HTML for a note contains the title, breadcrumbs, and toolbar shell but not the note text. This is a deliberate consequence of removing the duplicate rendering surface; if first-paint or no-JS reading ever matters, it needs a separate pre-hydration slot.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/web/src/components/editor/TiptapEditor.tsx` | Client editor boundary: migration, instance lifecycle, reconciliation, read-only and error states |
| `apps/web/src/components/editor/EditorToolbar.tsx` | Data-driven roving-tabindex toolbar with active-state reflection |
| `apps/web/src/components/editor/toolbar-commands.ts` | Toolbar group/item table and the command layer; the extension seam for Parts 35/36 |
| `apps/web/src/components/editor/keyboard-shortcuts.ts` | Single source of truth for bindings, platform formatting, and binding matching |
| `apps/web/src/components/editor/extensions/editor-shortcuts.ts` | Registers `source: "notted"` bindings with lazily resolved handlers |
| `apps/web/src/components/editor/KeyboardShortcutsDialog.tsx` | Help dialog rendered directly from the shortcut table |
| `apps/web/src/components/editor/LinkDialog.tsx` | Accessible link add/edit/remove with URL sanitization and inline errors |
| `apps/web/src/components/editor/ColorPickerDialog.tsx` | Bounded swatch picker for text colour and highlight |
| `apps/web/src/components/editor/editor-colors.ts` | Validated `#rrggbb` palettes |
| `apps/web/src/components/editor/document-sync.ts` | Key-order-independent document comparison for reconciliation |
| `apps/web/src/components/editor/useRovingToolbar.ts` | APG toolbar keyboard behaviour |
| `apps/web/src/components/editor/useDialogFocusRestore.ts` | Focus restoration for programmatically opened dialogs |
| `apps/web/src/components/notes/NoteDetailView.tsx` | Mounts the editor with permission and trash gating |
| `apps/web/src/styles/globals.css` | `.notted-editor-content` typography and focus styles |
| `apps/web/src/test/editor-harness.tsx` | Shared render harness (`renderEditor`, `userEventKeysFor`, `pressKey`) |

## Database and Data Changes

None. No schema, migration, seed, or contract change. Part 34 consumes the Part 33 contract unchanged.

## API, Configuration, and Operational Changes

- No route, transport, environment variable, port, queue, or deployment change.
- No new dependencies. Everything needed was already installed at TipTap 2.27.1.
- `apps/web/src/test/setup.ts` gained `Range.getClientRects` and `Range.getBoundingClientRect` stubs. jsdom implements neither, and ProseMirror calls both on every transaction's scroll-into-view, so without them every transaction threw.

## Security and Tenant-Isolation Notes

- Untrusted and historical JSON never reaches TipTap directly; `prepareNoteDocumentForEditor` migrates and validates first, and an unrecoverable document renders a safe error state instead of throwing.
- Link application goes through `sanitizeDocumentUrl`; `javascript:` and `data:` URLs are refused with a visible error and no mark is applied. Colours are constrained to a fixed palette and re-validated in the command layer.
- No `dangerouslySetInnerHTML` and no `innerHTML` anywhere in the editor.
- Editing is deny-by-default: a missing or false `canUpdate` capability, or a trashed note, yields a non-editable editor. This is a UI affordance only — authorization remains a backend invariant enforced by the Part 24 policy layer.
- No authentication, authorization, tenant query, logging, secret, or storage behaviour changed.

## Verification Evidence

Gates were run serially at the end of the combined Parts 34–36 session; the numbers below are that final run.

| Check | Result | Notes |
|---|---|---|
| `pnpm install --frozen-lockfile` | Pass | Lockfile consistent |
| `pnpm build:packages` | Pass | Shared packages built before dependents |
| `pnpm exec turbo run lint --concurrency=1 --force` | Pass | 4/4 tasks, `--max-warnings 0` |
| `pnpm exec eslint eslint.config.mjs --max-warnings 0` | Pass | Exit 0 |
| `pnpm format:check` | Pass | All packages plus root |
| `pnpm exec turbo run type-check --concurrency=1 --force` | Pass | 6/6 tasks |
| `pnpm exec turbo run test --concurrency=1 --force` | Pass | web 58 files / 476 tests; api 539 passed + 54 skipped; shared-validators 175; shared-types 3 |
| `node --test scripts/*.test.mjs` | Pass | 4 tests |
| Production-env `pnpm exec turbo run build --concurrency=1 --force` | Pass | 4/4; 26 web routes emitted |
| `pnpm audit:prod` | Pass | No new vulnerabilities |
| `git diff --check` | Pass | No whitespace errors |
| `pnpm --filter @notted/web exec vitest run --coverage` | **Fail (branches only)** | Statements 70.05%, branches 63.31%, functions 73.28%, lines 72.52%. Resolved 2026-08-04 — see limitations |
| Playwright / E2E | Not run | No browsers provisioned; no E2E spec added this session |
| Docker / compose | Not run | No gate required containers; no compose file or port was touched |

Part-34-specific coverage: `editor-toolbar.test.tsx`, `editor-shortcuts.test.tsx`, `tiptap-editor.test.tsx`, `keyboard-shortcuts-dialog.test.tsx`, `editor-modules.test.ts`.

## Known Limitations and Follow-up Work

- ~~**Branch coverage (63.31%) is below the 70% threshold, so `pnpm test:ci` fails.**~~ **Resolved on 2026-08-04**; see the coverage remediation record below. Two things in the original note were wrong: only `apps/web` had been measured, so the claim that this was the sole cause of the `pnpm test:ci` failure was incorrect — `@notted/shared-types` (0% functions) and `@notted/api` (53.64% statements) were failing too. The characterization of the shortfall as pre-existing debt outside this work was accurate.
- Real-browser behaviour is unverified: caret geometry, print, and pointer-driven interactions are stubbed to zero rects in jsdom. Part 76 owns browser validation.
- Typing into contenteditable, clipboard interaction, drag/drop, and pointer selection are not directly testable in jsdom; commands and keymaps are driven through the real editor instead.
- Part 37 owns `PageContainer` and zoom, Part 38 owns page breaks/focus mode/print, Part 39 owns autosave. The editor is deliberately layout-agnostic and persists nothing.

## Handoff Notes

- **Adding a toolbar control:** append to `EDITOR_TOOLBAR_GROUPS` in `toolbar-commands.ts`. A `kind: "button"` item needs no component change; a `kind: "control"` item needs one branch in `EditorToolbar.renderControl`.
- **Adding a shortcut:** add it to `EDITOR_SHORTCUTS`. If it is a TipTap default use `source: "tiptap"`; otherwise use `source: "notted"` and register it via the `EditorShortcuts` extension. `editor-shortcuts.test.tsx` asserts exact set equality between the declared ids and the proven expectation map, so a new shortcut fails the suite until a real behavioural expectation is added. **Do not weaken that test** — it is what guarantees the help dialog never advertises a binding that does not work.
- `keyboard-shortcuts-dialog.test.tsx` asserts the dialog row count equals `EDITOR_SHORTCUTS.length`, closing the same loop from the other side.
- Part 39 should consume `onDocumentChange` (contract-valid documents only) and `onEditorReady`. Note that `TiptapEditor` stops emitting `onDocumentChange` when the editor produces a contract-invalid document — autosave must surface that state rather than silently stop saving.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-03 | Part 34 coordinated delivery | Implemented and verified the editor, toolbar, and shortcuts help dialog |
