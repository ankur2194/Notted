# Part 36 — Build slash commands and mentions

## Status

- **State:** Complete
- **Completed on:** 2026-08-03
- **Implemented by:** Frontend-editor implementation subagent, two independent quality reviews, one fix pass, and lead resolution
- **Plan reference:** `Plan.md`, Part 36
- **Related records:** Parts 28, 32, 33, 34, and 35; ADR 0008

## Objective

Add the two suggestion surfaces `Notted.md` specifies: a searchable `/` command menu with correct trigger and range handling, and `@` mentions of workspace members that store stable user IDs and degrade gracefully when a mentioned person is no longer a member.

## Implemented Work

- **Widened the shared document contract** with a `mention` inline atom: `{ type, attrs }` only, no content and no marks. `id` must be a UUID (validated with the shared `uuidSchema`, so the rule cannot drift); `label` is a bounded, non-empty, control-character-free display cache. Any other attribute is rejected, including TipTap's own `mentionSuggestionChar`.
- Added `maxMentions: 200` and `maxMentionLabel: 200` to `NOTE_DOCUMENT_LIMITS`. `maxNodes` alone would have permitted ~2000 mentions, which would make the Part 60 notification fan-out unbounded.
- Added contract rendering (`<span class="notted-mention" data-mention-id="…">@Label</span>`, everything escaped), inline plain-text extraction (`@Ada Lovelace`), and migration that degrades a malformed mention to escaped `@label` text and promotes a block-position mention into a paragraph rather than dropping the stable id.
- Added `SlashCommandMenu.tsx` and `extensions/slash-command.ts` over a data-driven `SLASH_COMMANDS` table covering heading 1–3, paragraph, bullet list, ordered list, task list, table, blockquote, code block, and divider, with search over labels and aliases and a no-results state.
- Added `extensions/Mention.ts` and `MentionList.tsx` with workspace-scoped member suggestions, loading/empty/error states, debounced search, and stale-response rejection.
- Factored the shared machinery: `SuggestionPopover.tsx` (portal, positioning, ARIA, click-away, live region), `useSuggestionPopup.ts`, `suggestion-popup.ts`, `suggestion-triggers.ts`, and `extensions/suggestion-bridge.ts`.
- Added `NoteEditorSurface.tsx`, the client wrapper that supplies workspace-scoped member data through TanStack Query, keeping `TiptapEditor` free of network I/O.
- Added `lib/notes/member-directory.ts` and `requestAllWorkspaceMembers`, which pages the authorized member listing to completion under one shared query key.

## Important Decisions

- **`/image` and `/page-break` are deliberately omitted.** Neither node exists in the contract yet — images are Part 42 and page breaks are Part 38. Shipping disabled entries would be dead UI. `SLASH_COMMANDS` is a flat frozen array with no positional coupling, so each of those parts appends exactly one entry and changes nothing else. The command-id completeness test will fail until the new entry has a proven behavioural expectation, which is intentional.
- **`NOTE_DOCUMENT_SCHEMA_VERSION` was not bumped.** The mention node is a purely additive widening: every document valid under the previous contract remains valid and unchanged in meaning. (Contrast Part 35's `codeBlock.language` narrowing, which is documented in that record.)
- **A "valid line position" for `/`** means all of: the enclosing node is a textblock; `parent.type.spec.code !== true` (so code blocks are excluded); and `$from.parentOffset === 0` (the `/` is the block's first character). This kills mid-word (`and/or`), URL paths (`https://example.test/path`), and `/` after inline marks — the plugin's `startOfLine` option alone would wrongly match the last case, because its regex anchors to the start of the *text node*, not the textblock. Table cells are allowed: a cell holds ordinary paragraphs and headings/lists/code blocks are legitimate inside one. Accepted consequence: a paragraph legitimately beginning `/usr/bin` opens the menu, shows "no commands match", and Escape leaves the text intact.
- **The editor surface keeps `role="textbox"`** while carrying `aria-controls`, `aria-autocomplete`, `aria-haspopup="listbox"`, and `aria-activedescendant`. Switching to `role="combobox"` was rejected: a multi-line rich-text surface is not a coherent combobox, and mutating a live element's role under assistive technology causes announcement bugs. `aria-expanded` was removed because it is not a permitted attribute on `textbox`; the always-mounted polite live region conveys open-ness and the result count instead. Focus never leaves the editor.
- **Positioning uses no third-party library.** No `tippy.js`, no Popper. `SuggestionPopover` reads `clientRect()` from the suggestion plugin, and a pure `suggestionPopupGeometry` function places the popup below the caret, flips above when space is short, and clamps into the viewport.
- **Tab coordination:** the slash extension sits at priority 250 and mention at 220, both above `NoteBlockTab`'s 200, and both return `false` whenever their menu is closed or empty. No competing Tab binding was added, and Tab still escapes the editor everywhere else.
- **The mention search never puts the query in a request path.** The member listing has no server-side name filter, so the authorized pages are fetched once, cached under one key shared with `ShareModal`, and matched on the client (bounded to 8 shown results). The workspace id comes only from `NoteDetail.workspaceId` and is never derived from the query.
- **The member directory is fetched lazily.** `NoteEditorSurface` only enables the query when the note already stores a mention — the sole case that needs resolution on load. Otherwise it costs nothing until the reader types `@`, at which point `mentionSearch` populates the same cache entry and the disabled query observes it. Without this gate, every note open in a large workspace would spend up to `WORKSPACE_MEMBER_MAX_PAGES` sequential requests on data it never uses.
- **`extensions/Mention.ts` keeps the capital `M`** against `CLAUDE.md`'s kebab-case rule for `.ts` files, because `Notted.md`'s canonical directory structure spells it that way and `AGENTS.md` makes `Notted.md` primary for structure. A file-header comment records the conflict.
- **TipTap 2.27.1's stock mention Backspace handler is buggy** — it runs `nodesBetween` twice and the second `tr.insertText` resolves against the unmapped document, deleting the character after the mention as well. It is replaced with a single-pass `tr.delete` of the whole atom, verified correct at document start, with a non-empty selection, with adjacent mentions, and at a paragraph boundary.
- **The HTML projection is deliberately one-way.** `renderDocumentHtml` emits no `data-type="mention"`, so pasting the server projection back into the editor degrades mentions to plain `@Label` text. JSON is the canonical persisted format and the HTML is an export/preview surface; making it symmetric would mean widening an export surface's attributes and then trusting them as editor input for a capability nothing asks for. This is documented on both functions.

## Files and Components

| Path | Purpose |
|---|---|
| `packages/shared-validators/src/document.schema.ts` | `mention` node, UUID/label validation, bounds, escaped rendering, plain text, migration |
| `packages/shared-validators/src/document.schema.test.ts` | Mention contract, rejection, escaping, bounds, and migration coverage |
| `apps/web/src/components/editor/slash-commands.ts` | `SLASH_COMMANDS` data, filtering, query normalization |
| `apps/web/src/components/editor/SlashCommandMenu.tsx` | The `/` menu |
| `apps/web/src/components/editor/extensions/slash-command.ts` | Suggestion plugin wiring (priority 250) |
| `apps/web/src/components/editor/extensions/Mention.ts` | Mention node, node view, corrected Backspace (priority 220) |
| `apps/web/src/components/editor/MentionList.tsx` | The `@` menu |
| `apps/web/src/components/editor/mention-members.ts` | Candidate projection, filtering, debounce, directory, `documentHasMention` |
| `apps/web/src/components/editor/SuggestionPopover.tsx` | Shared portal listbox: positioning, ARIA, click-away, live region |
| `apps/web/src/components/editor/useSuggestionPopup.ts`, `suggestion-popup.ts`, `suggestion-triggers.ts` | Popup state, pure geometry/announcement helpers, pure trigger rules |
| `apps/web/src/components/editor/extensions/suggestion-bridge.ts` | Items/render bridge that never rejects into the plugin |
| `apps/web/src/components/notes/NoteEditorSurface.tsx` | Client boundary supplying workspace-scoped member data |
| `apps/web/src/lib/notes/member-directory.ts`, `lib/notes/requests.ts` | Shared query function and bounded member pagination |
| `apps/web/src/components/editor/editor-slash-commands.test.tsx`, `editor-mentions.test.tsx`, `suggestion-modules.test.ts`, `components/notes/note-editor-surface.test.tsx` | Behaviour, ARIA, and tenant-scope coverage |

## Database and Data Changes

No schema change or migration. The shared document contract widened additively with the `mention` node; every previously valid document remains valid.

## API, Configuration, and Operational Changes

- No route, transport, environment variable, port, queue, or deployment change. The member listing endpoint from Part 28 is reused unchanged.
- New exact-pinned dependencies: `@tiptap/extension-mention@2.27.1` and `@tiptap/suggestion@2.27.1`. No positioning library was added. ADR 0008 records both.
- `requestAllWorkspaceMembers` issues up to `WORKSPACE_MEMBER_MAX_PAGES = 10` sequential authorized requests on a cold cache, and fails the whole listing if any page fails so a partial (and therefore misleading) directory can never be shown.

## Security and Tenant-Isolation Notes

- **Tenant isolation is enforced on the backend and not re-implemented on the client.** `MembershipsService.listMembers` authorizes `member.list` before touching the database and scopes rows with `whereWorkspace(workspaceMembers, tenantContext)`, reading the active workspace from tenant context rather than caller input. `apps/api/src/memberships/memberships.service.test.ts` has an existing cross-tenant denial test asserting an existence-concealing 404 and that `select` is never called; both reviewers verified it.
- What the client proves is that it can never point the backend elsewhere: the workspace id flows only from `NoteDetail.workspaceId`, and a test asserts that a mention query literally containing another workspace's UUID still results in every request being made with the note's own workspace id, with zero options rendered and the foreign id absent from the DOM.
- The mention `label` is untrusted display data and is escaped on every render path — the contract renderer, the node view (which uses `createTextNode`, never `innerHTML`), and the React popup.
- The `mention` node cannot carry marks, so it can never smuggle a link, colour, or highlight into the renderer, and `maxMentions`/`maxMentionLabel` bound it.
- No mention notifications, notification records, or outbound messages are created. Part 60 owns that, and forging a recipient outside the workspace is prevented at that layer plus by the UUID-and-directory constraint here.
- The removed-user fallback discloses nothing beyond the already-stored label; the user id is never surfaced as text.

## Verification Evidence

Gates were run serially at the end of the combined Parts 34–36 session.

| Check | Result | Notes |
|---|---|---|
| `pnpm install --frozen-lockfile` | Pass | Lockfile consistent |
| `pnpm build:packages` | Pass | |
| `pnpm exec turbo run lint --concurrency=1 --force` | Pass | 4/4, `--max-warnings 0` |
| `pnpm exec eslint eslint.config.mjs --max-warnings 0` | Pass | Exit 0 |
| `pnpm format:check` | Pass | |
| `pnpm exec turbo run type-check --concurrency=1 --force` | Pass | 6/6 |
| `pnpm exec turbo run test --concurrency=1 --force` | Pass | web 58 files / 476 tests; api 539 + 54 skipped; shared-validators 175; shared-types 3 |
| `node --test scripts/*.test.mjs` | Pass | 4 tests |
| Production-env `pnpm exec turbo run build --concurrency=1 --force` | Pass | 4/4 |
| `pnpm audit:prod` | Pass | |
| `git diff --check` | Pass | |
| `pnpm --filter @notted/web exec vitest run --coverage` | **Fail (branches only)** | Branches 63.31% vs 70%; resolved 2026-08-04 (see Part 34 record) |
| Playwright / E2E | Not run | Popup placement/flipping is layout-dependent; browser verification belongs to Part 76 |
| Docker / compose | Not run | Not required; no container or port was touched |

Part-36-specific coverage: trigger positions including all negative cases, filtering and no-results, a per-command generated test with an exact id-set completeness assertion, range handling (empty query, typed-then-backspaced, text after the caret preserved), keyboard navigation and Escape/click-away, the full ARIA attribute lifecycle and live-region announcements, mention insertion and atom behaviour, current/former/unknown rendering, loading/empty/error states, out-of-order response rejection, the lazy-directory gate, and the workspace-scope assertions above.

## Known Limitations and Follow-up Work

- Real popup placement and flipping are unverified in jsdom (all rects are zero); the geometry logic is covered as a pure function and the visual result belongs in Playwright (Part 76).
- `WORKSPACE_MEMBER_MAX_PAGES = 10` caps the directory at 1000 members. Beyond that the menu honestly reports "No match among the workspace members loaded so far" rather than implying absence, but the correct long-term fix is a server-side member filter on `member.list` — deliberately out of scope here.
- Branch coverage remains below threshold (pre-existing; see the Part 34 record).
- Mention notifications are Part 60. Nothing here enqueues, deduplicates, or persists them.

## Handoff Notes

- **Parts 38 and 42** each append exactly one entry to `SLASH_COMMANDS` (`/page-break`, `/image`) and add the corresponding node to the shared contract **first**. The command-id completeness test in `editor-slash-commands.test.tsx` asserts exact set equality and will fail until a real behavioural expectation is added — do not weaken it.
- **Any new persisted node** must go through the contract before the editor can emit it: allow-list, structure rules, renderer, plain-text extraction, migration, and tests together. The `mention` addition is the worked example.
- `createNoteEditorExtensions(options)` now takes optional suggestion wiring; the zero-argument call still builds the complete schema for round-trip tests.
- **Do not let `TiptapEditor` perform network I/O.** A test asserts `fetch` is never called from it. Inject data through props, as `NoteEditorSurface` does.
- `NoteEditorSurface` and `ShareModal` share `noteQueryKeys.members`. Keep them on the same query function so they can never hold differently-truncated views of the same key.
- The suggestion plugins own Tab above `NoteBlockTab` (Part 35's single Tab authority). Anything else wanting Tab must coordinate with `runBlockTab` rather than adding a competing binding, and must verify no lower-priority extension re-claims the key.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-03 | Part 36 coordinated delivery | Implemented and verified slash commands and workspace-scoped mentions |
