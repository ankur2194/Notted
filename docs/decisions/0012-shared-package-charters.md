# ADR 0012: Shared package charters cover runtime helpers and rendering assets

- **Status:** Accepted
- **Date:** 2026-08-18
- **Related plan parts:** 38, 63, 64
- **Amends:** ADR 0001's description of the two shared packages; reconciles `Notted.md:256` and `Notted.md:268`

## Context

`Notted.md` describes `packages/shared-types/` as "Shared TypeScript types" and `packages/shared-validators/` as "Shared Zod schemas", each containing only `src/*.ts`. Part 63 made both descriptions inaccurate.

Part 63's server-side PDF and HTML export renders a note in `apps/api`, and the acceptance criterion is that the output paginates exactly as the editor's own print output. That is only true if the server uses the *same* page geometry and the *same* print stylesheet as the browser. Both lived in `apps/web`:

- `apps/web/src/lib/notes/page-geometry.ts` — `pageRuleCss`, `clampMargins`, `pageBoxPx` and the sheet dimension table.
- `apps/web/src/styles/print.css` — the stylesheet Part 38 wrote explicitly for Part 63 to load into Puppeteer.

ADR 0001 prohibits application-to-application source imports, and a future production API image will not contain `apps/web` sources at all, so `apps/api` importing either was never available. Duplicating them was the alternative, and duplication is precisely the failure the criterion is written to catch: two copies of an `@page` rule drift, and the drift is invisible until a customer's exported PDF paginates differently from what they saw on screen.

## Decision

Both files move into shared packages, and the two package charters are widened to describe what they now hold.

- `packages/shared-types/` holds shared contracts **and the pure functions that derive values from them**. `page-geometry.ts` moved here verbatim; its only import was `PageSize`, which already lived in this package, so the move removed an import rather than adding one. Its test moved alongside it.
- `packages/shared-validators/` holds shared validation **and the rendering assets that belong with it**. `print.css` moved to the package root as a real `.css` file, added to that package's `exports` and `files`. It sits beside `renderDocumentHtml`, which emits every class the stylesheet selects — the two are one contract, and separating them is what would be strange.

Neither package gains a runtime dependency. `apps/web` reaches the stylesheet through a bare specifier in `globals.css` (`@import "@notted/shared-validators/print.css"`); `apps/api` reads the same bytes through `createRequire(...).resolve("@notted/shared-validators/print.css")` plus `readFileSync`, memoized.

`Notted.md` is not edited. This ADR is the reconciliation, in the same way ADR 0011 reconciles ADR 0007 without rewriting it.

## Alternatives considered

- **Duplicate the geometry and the stylesheet into `apps/api`.** Rejected: two sources of truth for `@page` is the exact drift the "matches editor print output" criterion exists to detect, and nothing would fail when they diverged.
- **A third package (`packages/shared-print/`).** Rejected: one CSS file and one 17 KB module do not justify a new workspace, a new build target, a new tsconfig and a new entry in every dependency list. YAGNI; if print concerns grow, this ADR is what gets superseded.
- **Keep the files in `apps/web` and have `apps/api` read them by relative path.** Rejected: it is an application-to-application dependency wearing a filesystem disguise, and it breaks outright in a production API image that contains no `apps/web`.
- **Inline the stylesheet into `renderDocumentHtml` as a string.** Rejected: `apps/web` needs it as a real stylesheet for the editor's own print path, so this would still leave two representations.

## Consequences

- The precedent already existed and is now explicit: `renderDocumentHtml` — not a Zod schema — has lived in `shared-validators` since before this work.
- `packages/shared-validators` now publishes a non-JavaScript asset. Any consumer resolving its `exports` map must handle a `.css` entry; both current consumers do.
- Coverage figures shift without any behaviour changing: a fully covered ~17 KB module left `apps/web` for `packages/shared-types`. Compare per-workspace numbers across this boundary with care.
- The dependency direction is unchanged and still enforced: apps depend on packages, never the reverse, and never app-to-app.
- `docs/completed-parts/part-38-page-breaks-focus-print.md` carries a dated amendment pointing at the new locations. Its history is not rewritten.

## Migration and rollback

The move was three `git mv` operations plus import-specifier updates in `PageContainer.tsx`, `PagePrintStyle.tsx`, `page-preferences.ts`, its test, and one line in `globals.css`. No runtime data, persisted format or public contract changed, so rollback is the reverse rename — but rolling back re-creates the app-to-app boundary problem and would require Part 63's renderer to be redesigned.
