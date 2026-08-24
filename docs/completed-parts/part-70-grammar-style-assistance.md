# Part 70 — Implement grammar and style assistance

## Status

- **State:** In progress — implementation complete, quality gates deferred to the session reviewer
- **Completed on:** Not completed
- **Implemented by:** Claude Code session (lead part engineer + four specialist agents)
- **Plan reference:** `Plan.md`, Part 70
- **Related records:** [Part 69](part-69-meeting-extraction-auto-tagging.md) (`complete()`, `parseJsonWithRepair`, `timeoutMs`/`signal`), [Part 68](part-68-summarize-continue-tone.md) (prompt table, AI panel, never-mutate-before-accept, plain-text-as-JSON-nodes), [Part 67](part-67-ai-configuration-governance.md) (provider seam, governance gate, usage metering), [Part 60](part-60-inline-comments.md) (**the anchor and decoration machinery this part reuses verbatim**), [Part 58](part-58-yjs-collaborative-editing.md) (who owns `notes.content`)

## Objective

Underline grammar, spelling, and style problems in a note without touching the note. The governing requirements from `Plan.md` are that **stale suggestions cannot edit new text**, that **collaborative changes are handled**, and that **disabling the feature stops outbound requests** — plus bounded segments with stable position identifiers, per-user enablement, accept/dismiss, batching, debouncing, and a privacy disclosure.

This is the first AI feature in the product that sends note text **without the author pressing anything for each request**, which is what makes the enablement gate and the disclosure load-bearing rather than decorative.

## Implemented Work

- **Segment-shaped contract, not note-shaped** (`packages/shared-types/src/ai.ts`, `packages/shared-validators/src/ai.schema.ts`): a request carries up to 20 segments of ≤2 000 characters, each with an **opaque client key**; every offset in the answer is relative to that segment's own string. The server is never sent a document position and therefore cannot return one. `end` is exclusive; `replacement` may be empty, because deleting a stray word is a correction.
- **`text` is deliberately not trimmed** — the one text field in that file that is a *coordinate system* rather than a value. Trimming would shift every returned offset by one and move each correction one character left. `id` **does** trim, so it stays symmetric with the model-echo schema.
- **Grammar service** (`apps/api/src/ai/grammar.service.ts`): stateless, no database dependency at all. One `complete()`, `parseJsonWithRepair` with a second `complete()` as the repair callback, then a re-check of every offset against the text actually sent. Three silent drops: unknown `segmentId`, `!(0 <= start < end <= text.length)`, and identity replacement. Feature id `grammar.v1`.
- **Silent, not an error, and not logged.** A suggestion is note content, so ADR 0007 keeps it out of logs; and the browser re-validates every suggestion against the live document before it can touch anything, so a dropped one costs nothing while failing the request would discard an otherwise useful answer over one bad offset.
- **Prompt** (`ai-prompts.ts`, `grammar.v1`): segments numbered and delimited as untrusted data, JSON-only output, the offset rule stated three ways, and an explicit *smallest span* rule so the model proposes a correction rather than rewriting the paragraph. The segment **id is stripped and JSON-quoted** before it reaches the prompt — it is the one caller-controlled string that lands in instruction space rather than inside a delimiter, so a forged `</segment>` in a 64-character id would otherwise open a line of its own.
- **Decoration layer** (`grammar-decorations.ts`): cloned from Part 60's `comment-decorations.ts`. `Decoration.inline` with a category class and `data-grammar-id`, rebuilt from the suggestion list on every draw, redrawn by a **meta-only transaction** carrying no steps. Never a mark.
- **Two gates at draw time, in order:** `resolveCommentAnchorInState` (imported verbatim from Part 60, not forked) must resolve, **and** `state.doc.textBetween(from, to)` must still equal the text the suggestion was computed from. A stale suggestion is therefore *invisible*, which is the only safe failure mode — putting that guard only in the accept path would mean showing the author a correction for text they did not write.
- **Check hook** (`useGrammarCheck.ts`): 1.5 s debounce on `editor.on("update")` (which fires for remote Yjs transactions too — a collaborator's paragraph is prose in this note), top-level block segmentation, FNV-1a hash per block, **only changed blocks sent**, batched at 20. The hash *is* the segment id, so the only thing that can find a block again is a value derived from its content.
- **Answers are re-proven against the live document twice** — once when the response lands (the block may have been edited in flight, here or by a collaborator) and again at Accept, because a suggestion sits on screen for as long as the author leaves it there. Between the two, positions are held as Part 60 **anchors** rather than numbers, so an unrelated edit above does not drift a suggestion onto different text.
- **Accept** inserts `[{ type: "text", text: replacement }]` as a JSON node — never a string, the same rule as Part 68's accept paths — or `deleteRange` when the replacement is empty, since ProseMirror has no empty text node. **Dismiss** is keyed by `hash(originalText + replacement)`, so it names the *correction* and survives a later re-check of the same block.
- **Disable is structural.** `setEnabled(false)` clears suggestions, clears the checked-hash set, `clearTimeout`s the debounce, aborts the in-flight request, and redraws; and the scheduler refuses at the top **before arming a timer**, so "off" is the absence of a request path rather than a condition checked on the way back from one.
- **Per-user preference and disclosure** (`GrammarToggle.tsx`): `localStorage` key `notted.grammar-enabled.<userId>`, default **off**, every read and write in try/catch. The *key existing at all* is the acknowledgement, and `setEnabled(true)` is reachable **only** from the disclosure dialog's confirm button until it does. Turning it off starts nothing and shows nothing.
- **Popover** (`GrammarPopover.tsx`): one delegated `click` listener on `editor.view.dom` hit-testing `data-grammar-id` (decorations are rebuilt constantly, so a per-span listener would be discarded seconds later), positioned from the decorated span's own `getBoundingClientRect()` through the **existing** `suggestionPopupGeometry` flip/clamp rules. `role="dialog"`, focus in on open and back on close, Escape and click-away, and an empty replacement renders "Remove this text" rather than a blank box.

## Important Decisions

- **The suggestion list reaches the panel through a one-slot module store** (`lib/ai/grammar-control.ts`), on the `continue-request.ts` precedent. The checker must live in `NoteEditorSurface` (the only place holding the editor) so a note keeps being checked whether or not the AI panel is open; the toggle lives in `AiPanel`. Neither is an ancestor of the other, because the editor reaches `PageContainer` as opaque `children` from a Server Component.
- **Colour tokens deviate from the brief.** `--color-warning` is already the comment-highlight colour, so a grammar underline sharing it would read as a comment. Grammar/style/spelling use `--color-info`/`--color-muted-foreground`/`--color-destructive`, which differ in lightness as well as hue; contrast on paper white is 4.53/5.17/7.58:1, all clear of the 3:1 SC 1.4.11 asks of a non-text indicator. Colour is never the only signal — the popover names the category in words.
- **Dotted `text-decoration`, not `border-bottom`.** A suggestion can cover the same words as a comment highlight, whose style *is* a `border-bottom`; a text decoration composes with it instead of overwriting it, and it is the squiggle writers already recognise.
- **No dark-theme block**, because this stylesheet has none anywhere — the existing presence-palette comment states the paper is white in every theme. Following the file beat introducing a fourth theming mechanism for one feature.
- **`Alt+ArrowDown` is not in `EDITOR_SHORTCUTS`.** A decoration is not focusable, so the feature needed a keyboard route or it would have been a WCAG 2.2 AA operability gap; Enter and Space are how a writer types and were left alone. Registering the chord would mean reopening the frozen registry *and* the `EditorShortcuts`-stays-last ordering invariant, so the chord is named in the toggle's own hint text instead — the place a reader turning the feature on is already looking.
- **Two identical paragraphs hash alike and are sent once**, and the single answer is applied to both: same text, same fault. Suggestion ids are therefore `${segmentId}:${from}:${to}`, not the segment id alone.
- **A failed batch is not marked checked**, so it retries the next time the author touches one of those blocks rather than being silently abandoned.
- **Enabling arms an immediate (debounced) check.** The note already has content, and waiting for a keystroke would make the toggle look broken.
- **Naming deviation (continued from Parts 67–69):** `Notted.md` names no frontend AI components; `src/components/ai/` and `src/lib/ai/` remain a deliberate, recorded deviation on the Part 58 precedent.

## Files and Components

| Path | Purpose |
|---|---|
| `packages/shared-types/src/ai.ts` | Grammar types, caps, categories, and the `AI_API_PATHS.grammarCheck` entry |
| `packages/shared-validators/src/ai.schema.ts` | Request/result schemas and the lenient `aiGrammarModelSchema` |
| `apps/api/src/ai/grammar.service.ts` | One completion, one repair, then the three offset drops |
| `apps/api/src/ai/ai-prompts.ts` | `grammar.v1`; segment delimiting and id sanitisation |
| `apps/api/src/ai/ai.controller.ts` | `POST …/ai/grammar-check` |
| `apps/api/src/openapi/openapi.routes.ts`, `docs/openapi.json` | Route documentation, regenerated (+144 lines) |
| `apps/web/src/components/editor/extensions/grammar-decorations.ts` | Underlines; the anchor + text-equality draw gates |
| `apps/web/src/components/editor/extensions/note-editor-extensions.ts` | Registers the plugin after comments, before `Collaboration` |
| `apps/web/src/components/editor/TiptapEditor.tsx` | `resolveGrammarSuggestions` ref-getter seam |
| `apps/web/src/lib/ai/requests.ts` | `requestGrammarCheck` (30 s timeout, caller `signal`) |
| `apps/web/src/lib/ai/grammar-control.ts` | One-slot store between the checker and the toggle |
| `apps/web/src/components/ai/useGrammarCheck.ts` | Debounce, hashing, anchoring, accept/dismiss, the disable gate |
| `apps/web/src/components/ai/GrammarPopover.tsx` | Delegated hit-test, geometry, accept/dismiss |
| `apps/web/src/components/ai/GrammarToggle.tsx` | Per-user switch and the privacy disclosure |
| `apps/web/src/components/ai/AiPanel.tsx` | Renders `<GrammarToggle />`; passes it nothing |
| `apps/web/src/components/notes/NoteEditorSurface.tsx` | Mounts the hook and the popover |
| `apps/web/src/styles/globals.css` | Three category underlines, plus a `@media print` drop |

## Database and Data Changes

**None.** No migration, no new table, no new column. Segments, suggestions, and dismissals are never persisted anywhere — there is no column they could occupy (ADR 0007). The enablement preference lives in the browser's `localStorage`, not in a row. Accepting a suggestion produces an ordinary editor transaction, which reaches storage through the existing Part 39 autosave or the Part 58 Yjs projection exactly as typing does.

## API, Configuration, and Operational Changes

- **New route:** `POST /api/v1/workspaces/:workspaceId/ai/grammar-check`. `ai.use`, `sensitive` rate-limit tier, trusted-origin checked, ordinary JSON (ADR 0013 bare payload).
- **No new error code, no new environment variable, no new feature flag, no new queue, no new dependency.** The endpoint is synchronous and reuses the Part 67 governance gate, so `FEATURE_AI_ENABLED` and the per-workspace quota and rate limits already cover it.
- **A repair pass is a second `complete()`** — a second `ai_usage` row and a second rate-limit slot. Grammar checking is the highest-frequency AI feature in the product, so its repair rate is the one worth watching for cost.
- `docs/openapi.json` is generated — regenerate with `pnpm --filter @notted/shared-validators build && pnpm --filter @notted/api openapi:generate`, never hand-edit.

## Security and Tenant-Isolation Notes

- **The route authorizes before doing anything.** `ai.use` (owner/admin/editor, never viewer) gates it. There is no `noteId`: a check is a batch of segments, possibly from a document not yet saved, so the workspace-level authorization is the tenancy proof — and it is sufficient because the service reads no tenant row at all.
- **No cross-tenant surface exists.** The service touches no database, holds no state between requests, and can only echo back ids the caller itself sent.
- **Prompt injection.** Segment text is delimited and framed as untrusted data, a smuggled closing tag is stripped, the segment id is stripped *and* JSON-quoted before entering instruction space, and there is still no `tools` field anywhere in the provider contract.
- **Model output cannot become markup.** Accept builds a ProseMirror text node; a replacement containing `<b>` or `&` is inserted as literal characters. This is Part 68's injection-sink lesson applied to a path the model reaches far more often.
- **Model output cannot corrupt the wrong text.** Offsets are re-checked server-side against the text sent, then re-proven client-side against the live document at draw time *and* again at Accept. A suggestion whose range no longer reads back as its original text is deleted rather than applied, and the document is left untouched.
- **Disabling stops outbound requests structurally** — the Plan's own verification criterion. The gate is an early return before the debounce timer is armed, plus an abort of anything in flight, so there is no code path from a keystroke to a request while the feature is off.
- **The disclosure precedes the first request, not the first suggestion.** `setEnabled(true)` is unreachable except through the dialog's confirm button until the preference key exists.
- **No content in logs, rows, or errors.** Dropped suggestions are dropped silently for exactly this reason.

## Verification Evidence

**Quality gates were deliberately not run in this session and are deferred to the session reviewer.** This session was scoped implement-only; all tests were authored but never executed. Nothing below is claimed to pass.

| Check | Result | Notes |
|---|---|---|
| `pnpm lint` | **Not run** | Deferred to the session reviewer. |
| `pnpm format:check` | **Not run** | `pnpm exec prettier --write` was run over every touched file instead. |
| `pnpm type-check` | **Not run** | Deferred. Unverified spots are called out below. |
| `pnpm test` | **Not run** | Every new test is authored-but-unexecuted and will run for the first time under the reviewer's gate. |
| `pnpm build` | **Not run** | Deferred. |
| `pnpm test:ci` | **Not run** | Deferred. |
| `pnpm --filter @notted/shared-types build` | **Pass** | Ran after authoring the contracts. |
| `pnpm --filter @notted/shared-validators build` | **Pass** | Ran twice — after the contracts, and again after the `id` trim fix. |
| `pnpm --filter @notted/api openapi:generate` | **Pass** | Booted the Nest app and discovered the new route, which incidentally proves `GrammarService` resolves through DI. `docs/openapi.json` +144 lines, 0 deletions, unchanged by the trim fix. |
| Playwright e2e | **Skipped** | Deliberately out of scope for this session; see follow-ups. |

Integration work done by the lead after the four specialists returned: verified all four seams line up on both sides (`GrammarSuggestionTarget`, `GrammarControl`, `UseGrammarCheckResult`, `GRAMMAR_SUGGESTION_ID_ATTRIBUTE`); confirmed `suggestionPopupGeometry`/`SuggestionRect`/`SUGGESTION_POPUP_WIDTH` are real exports with the assumed shapes; confirmed `browserStorage()` exists and returns `Storage | null`; confirmed the hook's plain-text insert matches Part 68's `inlineOrParagraphNodes` single-block shape (`[{type:"text", text}]`) and that *not* trimming it is correct for a replacement like `" the "`; confirmed the ref declarations in `TiptapEditor` precede the `useMemo`, so plugin presence is genuinely fixed at creation; and confirmed `EditorShortcuts` is still the last extension entry. Two defects were fixed by the lead: the `id` trim asymmetry, and the keyboard-chord discoverability gap.

## Known Limitations and Follow-up Work

- **Blocks inside wrappers are checked and then usually discarded.** Segment `start` is `offset + 1`, the first text position of a *textblock*; for a top-level list, blockquote, or table, `node.textContent` crosses node boundaries that positions do count, so the derived range fails its own text proof and the suggestions drop. Prose in lists and quotes therefore costs tokens and yields nothing. `ponytail:` marked with the `doc.descendants` + `node.isTextblock` upgrade path, which fixes both the positions and the waste. **This is the most valuable follow-up in this list.**
- **A block longer than 2 000 characters is never checked.** Skipped whole rather than split; upgrade path is sentence splitting with per-piece offset bookkeeping.
- **The preference is `localStorage`-only, per browser.** A user who enables grammar check on their laptop starts with it off on their phone. `ponytail:` marked; a server-side per-user preference is the upgrade path.
- **`Alt+ArrowDown` is undiscoverable outside the toggle's hint** — it is not in the shortcuts dialog. Promote it to `EDITOR_SHORTCUTS` if a second grammar chord ever appears.
- **The count announcement is throttled at 5 s** and a skipped announcement leaves the previous text standing. Intentional, but it is a copy decision worth revisiting with a screen-reader user.
- **A hash collision would mean "unchanged" about a changed block.** FNV-1a plus length, not a security primitive; nothing downstream trusts it alone, since every suggestion is re-proven against live text twice.
- **Unverified test mechanics**, flagged by the implementing agents and never executed: hardcoded ProseMirror positions and a first-in-repo `undoDepth` import in `grammar-decorations.test.ts`; and `use-grammar-check.test.tsx` renders the real editor on real timers before switching to fake ones and drives it with a hand-dispatched `replaceWith` transaction (chosen over `setContent`, whose `emitUpdate` default differs between TipTap 2 and 3). These are the likeliest spots to need a nudge under the reviewer's gate.
- **No e2e specs.** A browser journey covering enable → underline → accept → disable is unwritten.
- **`graphify update .` was not run** — deferred to the end of the session.

## Handoff Notes

- **Decorations, never marks.** A mark the document contract does not know halts autosave through `safeParseNoteDocument` in `TiptapEditor.handleUpdate`, broadcasts through Yjs, and lands in every export. `getJSON()` must stay byte-identical with and without suggestions showing.
- **`EditorShortcuts` must stay LAST** in the TipTap extension array. This part added a comment above it saying so; nothing may be appended past it.
- **The Part 60 anchor module is now shared by two features.** `comment-anchors.ts` is imported verbatim by grammar decorations and the check hook; it must not be forked, and its `createCommentAnchor(editor, from, to)` signature takes three arguments rather than a range object.
- **`state.doc.textBetween(from, to)` with no separator arguments** is the exact call the decoration gate, the response handler, and the Accept guard all compare against. A separator in any one of them would make the same range read back differently in the three places and silently break the staleness proof.
- **Never hand model output to TipTap as a string.** Still true, and reached far more often here than in Parts 68–69.
- **Grammar is the highest-frequency AI feature.** Anything tuning prompts or quotas should model it separately from the on-demand features: it fires on a debounce, not on a button.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-24 | Claude Code session (lead part engineer) | Initial record — implementation complete, gates deferred to the session reviewer |
