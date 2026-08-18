# Part 64 — Markdown, TXT, DOCX and ZIP export, and the export UI

## Status

- **State:** Complete
- **Completed on:** 2026-08-18
- **Implemented by:** `backend-platform-engineer` and `frontend-editor-engineer`, with two independent `quality-reviewer` passes and a main-session fix pass
- **Plan reference:** `Plan.md`, Part 64
- **Related records:** [Part 61](part-61-email-subsystem.md), [Part 62](part-62-export-job-lifecycle.md), [Part 63](part-63-pdf-html-export.md)

## Objective

Complete the format set and give the feature a user interface. The typed `NoteDocument` contract, `renderDocumentHtml` and `extractNoteContentPlain` are the conversion base.

## Implemented Work

- Converters under `apps/api/src/export/converters/`: `markdown.ts`, `docx.ts`, `zip.ts`, each with its own suite. Plus `note-export-source.service.ts`, which performs **one authorized read** producing the note, document, attachments, comments and versions through existing services — never raw object keys as authority.
- **Markdown is a hand-written walker over the typed `NoteDocument`, with no library.** Turndown would mean HTML → parse → Markdown, which needs a DOM in the API and discards the typed structure that makes task lists, page breaks, code-block language and mention identity survive.
- TXT reuses `extractNoteContentPlain` verbatim, so search extraction and text export can never disagree.
- DOCX uses `docx@9.7.1` (mandated by `Notted.md`). ZIP uses `fflate@0.8.3` — MIT, zero dependencies, and a synchronous buffer-in/buffer-out shape matching `putObject`'s `Buffer` signature. `jszip` was rejected as a direct dependency because it is dual MIT-or-GPL; `archiver` drags ten transitive packages for streaming that cannot be used here.
- Every node and mark has an explicit mapping with documented fallbacks. A page break becomes an HTML comment in Markdown (`---` would parse as a setext heading) but a **real page break** in DOCX; underline and highlight fall back to inline HTML in Markdown and survive natively in DOCX; colour is dropped; table spans collapse into the first cell in Markdown and are preserved as `gridSpan`/`vMerge` in DOCX. Mention identity survives both — `notted:user/<uuid>` in Markdown, an OOXML bookmark in DOCX.
- ZIP is bounded: 256 entries, a total cap taken from `EXPORT_MAX_ARTIFACT_BYTES`, 10 MiB per attachment, 50 versions, 500 comments, `signal.aborted` checked between entries, and an oversized attachment **skipped rather than fatal** — recorded in a `manifest.json` that also makes "include/exclude options produce exactly the requested artifacts" checkable in one assertion. Filenames reuse `sanitizeUploadFilename` with in-archive de-duplication and a fail-closed zip-slip guard. The abort budget reuses `EXPORT_RENDER_TIMEOUT_MS` rather than minting a second timeout knob.
- The format switch stayed in `ExportGenerationService.render` — one service, one switch, one arm per format. Adding a format remains one `case` arm plus one `SUPPORTED_EXPORT_FORMATS` entry, a property this part exercised three times.
- **Export UI:** `ExportNoteDialog.tsx` modelled on `ShareModal.tsx` and added to the existing header action column in `NoteDetailView.tsx`, so both note routes get it with no route changes. `export-requests.ts` over `requestJson`, and a `useExportJob` polling hook.
- Polling is the tree's **first `refetchInterval`**, and carries a comment saying so: it stops on every terminal status, backs off 1s → 2s → 5s, explicitly overrides the provider's `refetchOnWindowFocus: false`, is disabled while the dialog is closed, and hard-stops at the queue timeout rather than polling forever.
- A **root `exportQueryKeys`**, deliberately not nested under `noteQueryKeys`: an export outlives its note, and nesting would make every note invalidation kill a running poll.
- Download is a real `<a download href>`, matching the existing attachment pattern.

## Deviations

- **`pdf_renderer_unavailable` does not exist.** The plan named that error code; Chromium being missing actually surfaces as `errorCode: "generation_failed"`. The dialog maps the five real codes and appends PDF-specific guidance only when `job.format === "pdf"`.
- **`export-filenames.ts` was not created.** `exportDownloadFilename` already existed in `export-object-key.ts`, with tests.
- **The worker needed a six-line change** despite the plan saying none: `ExportSourceDocument` gained `subject: {workspaceId, noteId, requestedById, correlationId}` so the zip path can re-authorize. The property that matters — no per-format branching in the worker — holds.
- Part 62's two format-rejection tests became a single invalid-format-string test, since every format in the union is now supported; the test casts a value outside the union, which is the real caller it models.
- The e2e capability journey was rewritten: no role lacks `canExport`, so "a viewer never sees the trigger" asserted an unreachable state.

## Fixed after review

- **`EXPORT_MAX_ARTIFACT_BYTES` was documented as a hard cap but enforced on two formats of six.** Only `pdf` and `zip` checked it; `html`, `markdown`, `txt` and `docx` were bounded only transitively by the note document limits, so a large note with many inlined `data:` URIs could exceed the configured cap and still be uploaded and served. The cap is now applied once in `ExportGenerationService.render` for every format. The two inner checks stay and earn their place: the PDF one avoids copying an oversized buffer, and the zip bound stops *fetching* attachment bytes rather than discarding them afterwards.
- **`docx` had no node-type exhaustiveness guard** while `markdown` did, so a node type added to the contract would have exported from DOCX as nothing at all with no suite noticing. The same pinned-list tripwire now exists in both files — deliberately duplicated rather than shared, so a new type must be consciously mapped in both converters and fails in both places.

## Dependency note

**`jszip@3.10.1` is in the tree after all, transitively, under `docx@9.7.1`.** Its licence is `(MIT OR GPL-3.0-or-later)`; MIT is elected and it is triaged in `THIRD-PARTY-NOTICES.md` and recorded in ADR 0008. The copyleft audit therefore returns five hits rather than four. This is worth stating plainly because `jszip` was rejected as a *direct* dependency on exactly this ground — a transitive dual-licence under a mandated package is a different position, but a reviewer should not have to rediscover it. There is no automated licence gate in this repository, so nothing was bypassed.

`docx` also declares `@types/node@^25` as a runtime dependency while the repository targets Node 22 types; `apps/api` resolves `@types/node@22.20.1` and `type-check --force` is clean, so no action was taken.

## Open risks and follow-ups

- **Playwright has now been executed.** `apps/web/e2e/export-formats.spec.ts` is **3 passed, 0 skipped**, and the whole chromium suite is **56 passed, 0 failed, 9 skipped** in 7.4 minutes against the disposable `e2e` stack. The earlier attempt that froze the WSL2 host was run with both stacks up; following the Local resource budget in `docs/standards/testing.md` (development stack down, Chromium image pre-built in its own foreground step, one worker) the same suite completes with roughly 2.8 GiB of headroom.
- The **pagination-parity** evidence exists for the first time: the server-rendered export and the editor's own `page.pdf()` agree on page count and on every page's `MediaBox`. It had never actually run, because its guard read `EXPORT_CHROMIUM_PATH` from the *Playwright container's* environment while the variable is only ever set in the API container — so the test skipped on every possible run. Part 63 ships Chromium in the API image unconditionally, so the guard was removed rather than repaired.
- Two real defects were found by that first execution and fixed:
  - **Markdown over-escaping.** `escapeMarkdown` escaped `# > + - . ) ( ) { } !` everywhere, so prose exported as `Exported body paragraph\.` and `export\-fixture\.txt` — valid Markdown that renders correctly but is unreadable as source, which defeats the point of a Markdown export. The class is now restricted to characters that are metacharacters in any position, and a new `escapeLineStart` neutralises a block marker only in the one place it changes meaning: the first column of a paragraph (and of the title, which sits after the heading's own `# `). Covered by three added unit tests, including one asserting the first column is escaped and a later occurrence is not.
  - **Mailbox collision.** Part 61's welcome email now lands in the same mailbox as the auth action emails, so `latestActionLink` without a subject filter could return the wrong link. The four unfiltered call sites in `auth.spec.ts` and `advanced-auth.spec.ts` now name their subject, and the helper documents why.
- The 9 skips are deliberate and pre-existing: 8 in `dashboard-shell.spec.ts`, which is opt-in on a `PLAYWRIGHT_SHELL_EMAIL`/`PLAYWRIGHT_SHELL_PASSWORD` fixture user with two workspaces and unread notifications, and 1 OAuth provider-enabled mode that needs a differently-configured server.
- One selector in that spec, `getByRole("button", { name: /^(Export|Start|Generate|Create)/u })`, is a loose regex that would fail Playwright strict mode if a second matching button ever appears in the dialog. It resolves to exactly one button today; the risk is a future addition, not a current failure.
- The suite is **load-sensitive on a memory-capped host**, and that is a property of the host, not of the product. Across four full runs three different tests each failed exactly once and then passed in isolation in seconds — a Part 43 caption test, a Part 52 palette test and a Part 58 collaboration restore. Two were hardened at the cause rather than by retry: the Ctrl+K chord is now pressed on a poll, because a keystroke sent before `TopBar`'s effect installs its document listener is lost outright and no longer timeout can recover it; and `UPLOAD_MS` in `note-images.spec.ts` was raised from 30s to 60s because it must cover the server-side Yjs projection as well as the upload. The collaboration restore was left alone: it has no comparable cause to fix, and it passes in 1.4s unloaded.
- **DOCX and Markdown output has never been opened in a real consumer application** — Word, Google Docs, a Markdown renderer. Assertions are against the packed `word/document.xml` and the emitted Markdown text, which proves the bytes are what was meant, not that a reader likes them.
- When the poll turns terminal the cancel button unmounts; if it held focus, focus falls to `document.body`. Whether Radix's `FocusScope` recovers this was not verified, because it needs a browser.
