# Part 33 — Establish the TipTap document contract

## Status

- **State:** Complete
- **Completed on:** 2026-08-03
- **Implemented by:** Sequential backend/frontend specialists, two independent quality reviews, one fix pass, and lead integration
- **Plan reference:** `Plan.md`, Part 33
- **Related records:** Parts 20, 31, and 32; ADRs 0001, 0004, and 0008

## Objective

Establish the versioned, bounded, and safely renderable TipTap JSON contract required by the editor, autosave, collaboration, search, print, and export work in later parts without introducing the Part 34 editor UI.

## Implemented Work

- Replaced the transitional open-ended JSON envelope with a strict framework-neutral node, mark, attribute, content-structure, and size allow-list in `@notted/shared-validators`.
- Added schema version 1, typed parse/safe-parse helpers, a bounded historical-document migrator, and an explicit migration error when data cannot be recovered safely.
- Added block-aware plain-text extraction, conservative URL validation, and an allow-list HTML renderer that escapes text and emits only reviewed tags, attributes, links, and styles.
- Preserved unsupported historical text in source order while repairing malformed placement into schema-valid paragraphs and stripping unsupported marks or attributes.
- Added exact TipTap 2.27.1 headless dependencies and the schema extension factory for StarterKit, underline, TextStyle/color/font size, alignment, highlight, subscript, superscript, safe links, and task lists/items.
- Added a custom `doc` extension with `block*` content so the existing empty note projection remains valid in both TipTap and the shared contract.
- Added web bridges that migrate and validate JSON before editor use or safe HTML rendering.
- Added focused shared and web tests for fixture round-trips, actual ProseMirror serialization, canonical nullable attributes, structural rejection, unsafe links/HTML, bounded migration, and historical-node recovery.

## Important Decisions

- `NOTE_DOCUMENT_SCHEMA_VERSION` is currently a contract constant rather than a database column. The first incompatible schema change must add a reviewed persisted-version/backfill strategy before deployment.
- TipTap's Color extension is represented by the `textStyle.color` attribute; a standalone `color` mark is rejected on normal writes and converted only during historical migration.
- Canonical TipTap null defaults are accepted only where harmless and expected: alignment, ordered-list type, code language, TextStyle's unused fields, and default highlight color. The safe renderer omits no-op styles.
- Unsupported historical structures are never passed directly to TipTap. Recovery preserves text, may flatten unsupported structure into paragraphs, post-validates the result, and fails explicitly instead of truncating.
- Task list/item extensions are present now because existing seed fixtures use those nodes. Part 35 still owns checklist interaction, nesting keyboard behavior, and markdown shortcuts.
- StarterKit's ordinary code block remains enabled. Syntax-highlighted CodeBlockLowlight and tables remain Part 35 scope.
- Direct web test and type-check scripts build shared public packages sequentially first, avoiding stale generated contract declarations.

## Files and Components

| Path | Purpose |
|---|---|
| `packages/shared-validators/src/document.schema.ts` | Canonical schema/version, bounds, validation, URL/plain/HTML helpers, and migration policy |
| `packages/shared-validators/src/document.schema.test.ts` | Contract, security, structure, fixture, and migration coverage |
| `packages/shared-validators/src/note.schema.ts`, `src/index.ts` | Existing note schemas consume and publicly export the finalized document contract |
| `packages/shared-validators/src/note.schema.test.ts` | Note-boundary and block-aware extraction regression coverage |
| `packages/shared-types/src/note.ts` | Framework-neutral finalized `NoteDocument` contract documentation |
| `apps/web/src/components/editor/document-contract.ts` | Migration/validation and safe-render bridges for future editor consumers |
| `apps/web/src/components/editor/extensions/font-size.ts` | Exact allowed font-size attribute and commands |
| `apps/web/src/components/editor/extensions/note-editor-extensions.ts` | Fresh TipTap extension/schema factory with safe links and empty-doc compatibility |
| `apps/web/src/components/editor/**/*.test.ts` | Actual ProseMirror round-trip, rendering, migration, and URL coverage |
| `apps/web/package.json`, `pnpm-lock.yaml` | Exact TipTap dependencies and deterministic shared-contract prebuild scripts |

## Database and Data Changes

None. No schema column or migration was added. Existing stored version-1 JSON remains valid; incompatible future changes require an explicit persisted version and reviewed backfill before rollout.

## API, Configuration, and Operational Changes

- No route, transport, environment variable, port, queue, or deployment change was added.
- `extractNoteContentPlain` now separates leaf blocks with newlines, matching the existing rich seed fixtures. Single-paragraph note extraction is unchanged.
- Added exact runtime dependencies at version `2.27.1`: `@tiptap/core`, `@tiptap/react`, `@tiptap/pm`, StarterKit, and the selected formatting/task extensions.
- Web `test`, `test:ci`, and `type-check` lifecycle scripts build shared types and validators sequentially before consuming their public declarations.

## Security and Tenant-Isolation Notes

- The document boundary rejects unknown nodes, marks, fields, attributes, invalid structure, conflicting marks, oversized content, and unsafe links before persistence.
- HTTP(S) links use a cross-runtime WHATWG parser, reject credentials and deceptive authorities, and return a canonical URL. Mail and telephone links use conservative bounded grammars.
- Rendered HTML escapes text and attributes and emits only fixed tags, exact safe link attributes, reviewed alignment/color/font-size styles, and no arbitrary persisted HTML.
- Historical migration is bounded by the same byte, depth, node, child, mark, string, and aggregate-text limits and post-validates every successful result.
- No authentication, authorization, tenant query, logging, secret, or storage behavior changed in this contract-only part.

## Verification Evidence

| Check | Result | Notes |
|---|---|---|
| `pnpm --filter @notted/shared-validators test` | Pass | 9 files, 125 tests |
| `pnpm --filter @notted/web test` | Pass | 48 files, 211 tests; shared public packages built first |
| Focused shared/web type-check and lint | Pass | Shared validators and web passed independently |
| Serial repository lint gate | Pass | Four workspace lint tasks plus root ESLint config check |
| Serial formatting gate | Pass | Four workspace checks plus root Prettier check |
| `pnpm exec turbo run type-check --concurrency=1` | Pass | 6 tasks |
| `pnpm exec turbo run test --concurrency=1` | Pass | Shared types 3, shared validators 125, API 539, web 211; API live-infrastructure cases skipped by their existing guards |
| `node --test scripts/*.test.mjs` | Pass | 4 tests |
| Production-env `pnpm exec turbo run build --concurrency=1` | Pass | Shared packages, Next.js production build, and API TypeScript build |
| `pnpm audit:prod` | Pass | No new production vulnerabilities |
| `git diff --check` and final scope review | Pass | No whitespace errors or accidental Part 34+ implementation |
| Docker/live integration/Playwright | N/A | Contract-only part; deliberately not run and no existing container was inspected or touched |

## Known Limitations and Follow-up Work

- Part 34 owns the interactive editor, toolbar, command states, shortcuts, and content restoration.
- Part 35 owns tables, CodeBlockLowlight, checklist interaction, advanced block behavior, and markdown shortcuts.
- The first incompatible document schema change must introduce durable per-document version metadata and a reviewed migration/backfill before accepting the new version.
- Historical unsupported structures may be flattened to paragraphs while preserving all recoverable text; migration fails explicitly when bounded safe recovery is impossible.

## Handoff Notes

- Future editor code must call `prepareNoteDocumentForEditor` rather than feeding untrusted or historical JSON directly to TipTap.
- Persist only JSON that passes `noteDocumentSchema`; derive `contentPlain` server-side and use `noteDocumentToSafeHtml`/`renderDocumentHtml` for trusted rendering paths.
- Extend the shared allow-list, TipTap extension factory, migration logic, security tests, and schema version together. Do not add an editor-only node or mark that the backend contract cannot validate.
- Preserve exact TipTap 2.27.1 package alignment unless ADR 0008 is revalidated.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-03 | Part 33 coordinated delivery | Implemented and verified the finalized TipTap document contract |
