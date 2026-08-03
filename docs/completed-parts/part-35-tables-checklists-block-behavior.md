# Part 35 — Add tables, checklists, markdown shortcuts, and block behavior

## Status

- **State:** Complete
- **Completed on:** 2026-08-03
- **Implemented by:** Frontend-editor implementation subagent, two independent quality reviews, one fix pass, and lead resolution
- **Plan reference:** `Plan.md`, Part 35
- **Related records:** Parts 33 and 34; Part 36 (same session); ADR 0008

## Objective

Extend the editor with the advanced block content `Notted.md` specifies — resizable tables, nested checklists, syntax-highlighted code blocks, placeholder and cursor affordances — and make every documented markdown shortcut work without disturbing ordinary text, with a single coherent Tab/Shift+Tab rule.

## Implemented Work

- **Widened the shared document contract** (`packages/shared-validators/src/document.schema.ts`) with `table`, `tableRow`, `tableHeader`, and `tableCell`, including `colspan`/`rowspan`/`colwidth` validation, structure rules, allow-listed HTML rendering, tab/newline plain-text extraction, and bounded migration/recovery for historical table-ish input.
- Added explicit table bounds to `NOTE_DOCUMENT_LIMITS`: `maxTableRows: 100`, `maxTableColumns: 32`, `maxTableCells: 600` (document-wide, nested tables included), `maxTableCellSpan: 100`, `maxTableColumnWidth: 2000`.
- Replaced the free-text `codeBlock.language` rule with a bounded registry: `NOTE_DOCUMENT_CODE_LANGUAGES` (14 languages) plus `normalizeNoteDocumentCodeLanguage`, which maps aliases and returns `null` for anything else.
- Registered Table/TableRow/TableHeader/TableCell with `resizable: true`, and added `extensions/table-column-width.ts` so column width is adjustable from the keyboard, not only by pointer drag.
- Removed the Part 33 neutering of `TaskItem`, restoring its node view, input rules, and keyboard shortcuts with `nested: true`, so nested checklists work and each checkbox carries its own accessible name.
- Replaced StarterKit's plain code block with `CodeBlockLowlight` over a bounded lowlight registry, and re-enabled gap cursor and drop cursor (they were disabled in Part 33) with the CSS they need.
- Added `Placeholder` with the brief's exact "Start writing..." copy.
- Added `extensions/note-block-tab.ts` as the single Tab authority (priority 200), and `extensions/table-limits.ts` so every table growth path refuses to build a document the contract would reject.
- Added a table toolbar control (`TableMenuDialog.tsx`) covering insert, add/delete row and column, merge, split, toggle header row, delete table, and column width, plus a code-block language selector constrained to the registry.

## Important Decisions

- **`NOTE_DOCUMENT_SCHEMA_VERSION` was not bumped.** The table additions are a purely additive widening. **However, the `codeBlock.language` change is a genuine narrowing, not a widening** — the earlier contract accepted any string up to 64 characters. Record this honestly:
  - No stored, seeded, or fixture document is affected. `codeBlock` appears nowhere in `apps/api` seed data, migrations, API fixtures, or `packages/*` fixtures — this was verified independently by both reviewers.
  - A document carrying an out-of-registry language now fails `safeParseNoteDocument`. The client read path recovers it: `prepareNoteDocumentForEditor` → `migrateNoteDocument` renormalizes the language to `null`, the document then validates, and the user sees the "older content format was repaired" notice. The language attribute — and therefore that block's highlighting — is lost; the code text is preserved.
  - The API does **not** migrate on read (`NotesService.toDetail` casts the stored row), so a future non-web `/api/v1` consumer that writes back what it read would be rejected. That is a latent hazard to address if such a consumer appears.
  - The version constant was left alone because it is contract-only and has no database column. Bumping it would change nothing at runtime, and Part 33's record requires a persisted-version column plus a reviewed backfill before a real version change — neither exists yet.
- **Tab precedence is innermost-context-first with a cascade**, deviating from a strict "table first" reading. `runBlockTab` walks the selection's ancestors outward; the first table cell / task item / list item gets the first attempt, and if that attempt changes nothing the next enclosing context is tried. A checklist inside a table cell therefore indents while it can and moves between cells once it cannot. Strict table-first would leave lists inside cells permanently un-indentable.
- **Tab must be able to leave the editor.** With no applicable context `runBlockTab` returns `false` so the browser moves focus out (WCAG 2.1.2). Forward Tab inside a table grows the table rather than escaping, but Shift+Tab releases from the first cell, which satisfies the criterion.
- **`createTableExtension()` strips only `Tab`/`Shift-Tab` from the inherited Table keymap.** This was a real defect found in review: returning `false` from `runBlockTab` releases the key to the *next keymap*, not to the browser, and TipTap's own Table extension binds `Tab` → `goToNextCell() || addRowAfter()` — which silently bypassed the limit guard entirely. The extension's `Backspace`/`Delete`/`Mod-*` "delete the table when every cell is selected" bindings are deliberately preserved and are covered by a test.
- **Growth is refused before it happens, not diagnosed afterwards.** A contract-invalid document stops being reported through `onDocumentChange`, which once Part 39 lands would mean it stops being saved. Every growth action — Tab, add row/column, insert table, and split cell — checks `table-limits.ts` first and reports itself unavailable at the bound so the control is visibly disabled.
- **Only individual lowlight grammars are imported**, never the `all` or `common` bundle; `apps/web/src/types/highlight-js.d.ts` enforces this at the type level and a test asserts registry parity with the contract.
- The table UI is one dialog rather than a dozen toolbar buttons, keeping the toolbar from overflowing while every action stays a named focusable button.
- Fixed an upstream accessibility defect in TipTap 2.27.1's task-item node view, which computes the checkbox's accessible name from the node captured at creation and so keeps announcing "empty task item" after the user types.

## Files and Components

| Path | Purpose |
|---|---|
| `packages/shared-validators/src/document.schema.ts` | Table nodes, attrs, bounds, HTML/plain-text rendering, migration; bounded code-language registry |
| `packages/shared-validators/src/document.schema.test.ts` | Table contract, bounds, escaping, recovery, and language-registry coverage |
| `packages/shared-validators/src/index.ts`, `src/note.schema.ts` | Export the language registry and normalizer |
| `packages/shared-types/src/note.ts` | Contract doc comment references the language registry |
| `apps/web/src/components/editor/extensions/note-editor-extensions.ts` | Registers tables, CodeBlockLowlight, Placeholder, `NoteBlockTab`; restores TaskItem; strips the Table Tab keymap |
| `apps/web/src/components/editor/extensions/note-block-tab.ts` | The single Tab/Shift+Tab authority (priority 200) |
| `apps/web/src/components/editor/extensions/table-limits.ts` | Contract-aware growth guards, including `canSplitTableCell` |
| `apps/web/src/components/editor/extensions/table-column-width.ts` | Keyboard-accessible column resizing |
| `apps/web/src/components/editor/extensions/code-block-languages.ts` | Bounded lowlight registry and language options |
| `apps/web/src/components/editor/TableMenuDialog.tsx` | Table operations dialog (probes availability only while open) |
| `apps/web/src/components/editor/toolbar-commands.ts` | `TABLE_ACTIONS`, code-language control, guarded growth commands |
| `apps/web/src/styles/globals.css` | Placeholder, gap/drop cursor, table, cell-selection, resize handle, checklist, and `hljs-*` styles |
| `apps/web/src/types/highlight-js.d.ts` | Per-grammar typing that forbids the full bundle |
| `apps/web/src/components/editor/editor-tables.test.tsx`, `editor-block-behavior.test.tsx` | Table, block-behaviour, markdown, and paste coverage |

## Database and Data Changes

No schema change or migration. The shared document contract widened (tables) and narrowed (`codeBlock.language`) — see Important Decisions for the containment analysis and the recovery path. No backfill was required because no stored document contains a `codeBlock`.

## API, Configuration, and Operational Changes

- No route, transport, environment variable, port, queue, or deployment change.
- New exact-pinned dependencies: `@tiptap/extension-table`, `-table-row`, `-table-header`, `-table-cell`, `-code-block-lowlight`, `-placeholder` (all `2.27.1`), `lowlight@3.3.0` (MIT), `highlight.js@11.11.1` (BSD-3-Clause). Gap cursor and drop cursor come from StarterKit and needed no package. ADR 0008 was updated with the compatibility chain, licences, and the grammar-allow-list constraint.
- `apps/web/src/test/setup.ts` gained a minimal `ClipboardEvent` stub; jsdom lacks the constructor that `EditorView.pasteHTML` builds.

## Security and Tenant-Isolation Notes

- Table attributes are validated before persistence and before rendering. `colwidth` can never inject CSS: values must be finite numbers within `maxTableColumnWidth`, the array length is bounded, and the renderer emits only a derived, summed `style="width:Npx"` — the raw attribute never reaches output.
- The table HTML renderer emits only `<table>/<tbody>/<tr>/<th>/<td>` with `colspan`/`rowspan` as integers. Cell content is escaped by the existing text path.
- Structural bounds are enforced in validation, and growth is refused in the UI before an oversized table can be built, so a malicious or accidental table cannot exhaust the contract or wedge the save path.
- Pasted structured content is parsed through the editor schema and then validated against the contract; tests confirm hostile attributes (`onclick`, `bgcolor`, inline `background`), `iframe`, and `script` are dropped, and that unsafe link hrefs are refused on the paste path as well as the toolbar path.
- No authentication, authorization, tenant query, logging, secret, or storage behaviour changed.

## Verification Evidence

Gates were run serially at the end of the combined Parts 34–36 session.

| Check | Result | Notes |
|---|---|---|
| `pnpm install --frozen-lockfile` | Pass | Lockfile consistent with the new dependencies |
| `pnpm build:packages` | Pass | |
| `pnpm exec turbo run lint --concurrency=1 --force` | Pass | 4/4, `--max-warnings 0` |
| `pnpm exec eslint eslint.config.mjs --max-warnings 0` | Pass | Exit 0 |
| `pnpm format:check` | Pass | |
| `pnpm exec turbo run type-check --concurrency=1 --force` | Pass | 6/6 |
| `pnpm exec turbo run test --concurrency=1 --force` | Pass | web 58 files / 476 tests; api 539 + 54 skipped; shared-validators 175; shared-types 3 |
| `node --test scripts/*.test.mjs` | Pass | 4 tests |
| Production-env `pnpm exec turbo run build --concurrency=1 --force` | Pass | 4/4 |
| `pnpm audit:prod` | Pass | No new vulnerabilities from lowlight/highlight.js |
| `git diff --check` | Pass | |
| `pnpm --filter @notted/web exec vitest run --coverage` | **Fail (branches only)** | Branches 63.31% vs 70%; pre-existing debt (see Part 34 record) |
| Playwright / E2E | Not run | Pointer column-drag and real layout remain browser-verified work (Part 76) |
| Docker / compose | Not run | Not required; no container or port was touched |

Part-35-specific coverage: `editor-tables.test.tsx` (32 tests) and `editor-block-behavior.test.tsx` cover table manipulation, both limit bounds, the preserved delete-table keymap, split-cell guarding, nested checklist toggles, every documented markdown conversion plus negative "ordinary text" cases, undo/redo, and pasted structured content. `document.schema.test.ts` covers the contract additions.

## Known Limitations and Follow-up Work

- Pointer-driven column drag-resize is not testable in jsdom (ProseMirror resolves positions from pointer coordinates); the attribute path the handles write is tested directly through the same commands. Needs browser verification in Part 76.
- The API read path does not migrate stored documents, so an out-of-registry `codeBlock.language` written by a hypothetical non-web client would be rejected on write-back. Revisit when Part 65 exposes the public REST surface.
- Branch coverage remains below threshold (pre-existing; see the Part 34 record).
- Nested tables are permitted by the contract, bounded by `maxDepth` and the document-wide cell budget. This is deliberate but untested at depth.

## Handoff Notes

- **`NoteBlockTab` is the only Tab owner, at priority 200.** Anything that wants Tab must raise its own priority above 200 and return `false` when it has nothing to do — and must confirm no lower-priority extension re-claims the key. The "high priority plus return `false`" pattern releases the key to the *next keymap*, not to the browser; that assumption was silently wrong for the Table extension and cost a real bug. Re-check it whenever an extension is added or TipTap is upgraded.
- Any new persisted node must be added to the shared contract **before** the editor can emit it. Extend the allow-list, structure rules, renderer, plain-text extraction, migration, and tests together.
- The lowlight registry and `NOTE_DOCUMENT_CODE_LANGUAGES` are kept in exact parity by a compile-time type and a runtime test. Change them together.
- `TABLE_ACTIONS` is exported data; reuse its entries rather than duplicating table commands (Part 36's `/table` already does).
- `TableMenuDialog` only probes action availability while it is open. Five of those probes walk the whole document; do not move that work back onto every render.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-03 | Part 35 coordinated delivery | Implemented and verified tables, checklists, markdown shortcuts, and block behaviour |
