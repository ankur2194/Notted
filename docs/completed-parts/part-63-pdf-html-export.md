# Part 63 — PDF and HTML export

## Status

- **State:** Complete
- **Completed on:** 2026-08-18
- **Implemented by:** `backend-platform-engineer`, with two independent `quality-reviewer` passes and a main-session fix pass
- **Plan reference:** `Plan.md`, Part 63
- **Related records:** [Part 38](part-38-page-breaks-focus-print.md), [Part 62](part-62-export-job-lifecycle.md), [Part 64](part-64-markdown-docx-zip-export.md)
- **Related decisions:** [ADR 0001](../decisions/0001-monorepo-boundaries.md), [ADR 0008](../decisions/0008-runtime-and-package-compatibility.md), **[ADR 0012](../decisions/0012-shared-package-charters.md)**

## Objective

Render a note to PDF and to a self-contained HTML file, server-side, paginating **exactly** as the editor's own print output. Part 38 wrote `print.css` explicitly as the stylesheet this part loads into Puppeteer, and `PagePrintStyle` recorded that this part must build its `@page` rule from the same `pageRuleCss`.

## The central problem: the app→app boundary

The renderer runs in `apps/api`, but `print.css` and `page-geometry.ts` lived in `apps/web`. ADR 0001 forbids application-to-application imports, and a future production API image will not contain `apps/web` sources at all. Duplicating either is precisely the drift the "matches editor print output" criterion exists to catch.

Three `git mv` operations resolved it, and **[ADR 0012](../decisions/0012-shared-package-charters.md) records the resulting widening of both package charters**:

- `apps/web/src/lib/notes/page-geometry.ts` → `packages/shared-types/src/page-geometry.ts` (verbatim; its only import was `PageSize`, already in that package, so the move *removed* an import). Its test moved alongside.
- `apps/web/src/styles/print.css` → `packages/shared-validators/print.css` at the package root, added to that package's `exports` and `files`. It now sits beside `renderDocumentHtml`, which emits every class it selects.

`apps/web` changes were import-specifier-only plus one line in `globals.css`, which uses a **bare package specifier** (`@import "@notted/shared-validators/print.css"`). That was the part's riskiest unknown; it was verified empirically against the real `@tailwindcss/postcss` 4.3.3 pipeline before anything else was built, and later confirmed through a real `pnpm build` — the emitted production chunk carries one `@page`, two `@media print` blocks and **zero unresolved `@import`**. No relative fallback was needed. `apps/api` reads the same bytes via `createRequire(__filename).resolve(...)` plus `readFileSync`, memoized.

`docs/completed-parts/part-38-page-breaks-focus-print.md` carries a dated amendment; its history was not rewritten.

## Implemented Work

- `export-html.ts` — pure `buildStandaloneHtml()` producing one self-contained file: minimal typographic base styles, then the whole of the shared `print.css`, then `pageRuleCss(size, margins)`. The base block is required because `print.css` lives entirely inside `@media print`.
- **CSS order is load-bearing and `pageRuleCss` must come LAST.** `print.css` ships its own `@page { size: 210mm 297mm; margin: 25mm 20mm; }`, and `@page` has no selector, so a later rule wins. The original brief for this part specified the opposite order; the implementation caught it. Emitting `pageRuleCss` earlier would have made **every US Letter export silently print A4** and ignored custom margins entirely. The regression test asserts real ordering (`indexOf(rule) > indexOf(printStylesheet())` and `lastIndexOf("@page") === indexOf(rule)`), not mere presence.
- **The same string is the PDF's input**, so HTML and PDF cannot drift, and neither can drift from the editor.
- `browser-pool.service.ts` — one lazily launched browser, one incognito context per job, idle-close timer, relaunch on `disconnected`, `OnModuleDestroy` shutdown. Concurrency is pinned at 2, so a second browser would double memory for nothing.
- `pdf-export.service.ts` — `page.pdf({ preferCSSPageSize: true, printBackground: true })`. Geometry comes from `pageRuleCss` and **never** from Puppeteer's own `format`/`margin`, or the pagination-parity criterion is defeated. Margins arrive from client `localStorage` and are clamped server-side three times independently. Page numbers and custom header/footer go through `headerTemplate`/`footerTemplate`, suppressed when the vertical margin is too small to show them.
- **SSRF containment, four independent layers** — cheap because `renderDocumentHtml` emits images with no `src` at all and inlines every asset as a `data:` URI: `setContent` only (never `goto`); JavaScript disabled; request interception aborting every non-`data:` request with the abort count asserted; and `--host-resolver-rules=MAP * ~NOTFOUND` plus offline mode.
- `--no-sandbox` is required because the container runs `USER node`. The compensating controls — no JS, no network, no plugins, a fixed tag set, escaped text, a per-job context, no mounted credentials — are recorded in the file, with the real seccomp sandbox flagged for Part 79.
- Degradation mirrors `ObjectStorageDisabledError`: `isEnabled()` is false when `EXPORT_CHROMIUM_PATH` is missing, and **only `pdf` jobs fail**. The launcher is injected through one token so unit tests never launch a browser; the single real-Chromium integration test is `skipIf`-gated on the binary existing.
- Docker: every existing consumer in `compose.yaml` now **names its build target explicitly**, done *before* a `workspace-chromium` stage was appended to `docker/Dockerfile.dev` — otherwise the appended stage would have silently become the default and every service would build Chromium. Only `api` uses it; `api-e2e` inherits it via `extends`. Measured: `notted-dev-workspace-chromium:local` **1.45 GB** against `notted-dev-workspace:local` **493 MB**, with `which chromium` exiting 1 in the lean image and `docker compose config` resolving 2 services onto the fat image and 6 onto the lean one.
- New `export.config.ts` for the Chromium path, timeouts and size caps, registered in the environment contract test and `.env.example`.

## Corrections made during implementation

- **ADR 0008 wrongly claimed `puppeteer-core` is ESM-only** and loaded through a dynamic `import()`. Probed at runtime: its export map does publish a `require` condition, Node 22.23.1 resolves it, and `__esModule` is `true`. The code was right; the prose was corrected.
- `logger.warn(metadata, …)` hits a `LoggerService` overload that silently discards every field and logs the literal string `"Structured log event"`. Switched to `logger.warning(metadata, message)`.
- The body `max-width` used content width while also applying horizontal padding, subtracting the margins twice. Now full sheet width with `border-box`.
- `suppressHeader` and `suppressFooter` were byte-identical expressions — a dead branch, collapsed to one boolean.

## Fixed after review

- **Two of the four SSRF layers had no assertion at all.** The page-level layers are covered, but `--host-resolver-rules=MAP * ~NOTFOUND` and `--no-sandbox` appeared only in `LAUNCH_ARGS` and in comments, and the composite proof is `skipIf`-gated on a Chromium binary that most developer machines lack. Deleting the resolver blackhole would have broken no test. `browser-pool.service.test.ts` now asserts the launch arguments directly.

## Version facts

Debian bookworm `chromium` **151.0.7922.137-1~deb12u1**; `puppeteer-core@25.7.0` declares Chrome **152.0.7977.42**. One major apart and compatible, because puppeteer drives whatever `executablePath` points at over CDP and asserts no version match. Headless launch was verified as the non-root `node` user inside the built image.

## Open risks and follow-ups

- **The real-Chromium path is now proven.** `apps/api/test/export-pdf.integration.test.ts` runs **5 passed, 0 skipped** against Chromium 151.0.7922.137 inside the running `api` container (`docker compose -p notted-dev exec api pnpm exec vitest run test/export-pdf.integration.test.ts`). The suite is gated only on the binary existing and touches no database, so it needs neither the `e2e` profile nor Playwright — the `workspace-chromium` image the development `api` already runs is enough. Confirmed by that run: the A4 and US Letter page boxes (Letter asserted to differ from A4, which is the regression guard on `pageRuleCss` losing the cascade to `print.css`'s default `@page`), an explicit page break producing exactly two pages, `printStylesheet()` byte-identical to `packages/shared-validators/print.css`, and the composite SSRF proof — a document carrying `<img>`, `<a>`, `<link rel=stylesheet>` and a CSS `@import` all aimed at a live local listener recorded **zero TCP connections** while the export still produced a valid PDF.
- **`docker/Dockerfile.dev` installs `chromium` unpinned**, so the version above is a point-in-time observation rather than a reproducible constraint. Consistent with the pre-existing unpinned install in the same file, and dev-image only; pin when the production API image lands.
- **No production `apps/api/Dockerfile` exists yet**, so production packaging of `packages/shared-validators/print.css` is unverified.
- A vertical margin under 10 mm silently drops **page numbers** as well as any requested header or footer. Deliberate and documented, but the user gets no feedback that their footer was discarded.
