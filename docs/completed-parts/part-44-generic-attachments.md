# Part 44 — Implement generic attachment flows

## Status

- **State:** Complete
- **Completed on:** 2026-08-08
- **Implemented by:** frontend-editor-engineer agent, resuming a prior agent's ~60 % backend/shared handoff, then two independent review rounds and a fix pass
- **Plan reference:** `Plan.md`, Part 44
- **Related records:** `part-43-image-manipulation-ui.md` (the `ImageToolbar` render site this part's dialogs follow, `reduced-motion.ts`, `useSelectedNode.ts`), `part-42-editor-image-insertion.md` (the upload queue, the decoration-based placeholders, and the attachment directory this part **shares rather than duplicates**), `part-41-image-ingestion-processing.md` (the variant pipeline the file path deliberately skips), `part-40-secure-object-storage.md` (the proxied content endpoint, `admitUpload`'s ancestor, and the `UNPROCESSABLE_ENTITY` error-code idiom reused for 415), `part-39-note-autosave.md` (the single save call site this part does not add to), `part-38-page-breaks-focus-print.md` (`data-notted-print-hide`, and `print.css` standing alone for Part 63), `part-33-tiptap-document-contract.md` (the contract widened here). ADRs 0001, 0002, 0005, 0006, 0008.

## Objective

Let a writer attach the file types `Notted.md` §6 names — PDF, DOCX, RTF, XLSX, ZIP/RAR/7Z/TAR/GZIP, and the TXT/MD/CSV/JSON/XML/JS/TS/HTML/CSS/PY text and code set — up to the configurable 50 MB per-file limit, and see each one as an editor card carrying an icon, filename, size, upload date, download, an honest failure state, and a confirmed deletion. Downloads preserve the server's sanitized filename. A PDF can be previewed **in the application without the document ever becoming active content**, which is the security requirement the part is really built around.

## Implemented Work

### Shared contract (`packages/shared-validators`)

- `document.schema.ts` gains a first-class `attachment` block node: `NOTE_DOCUMENT_NODE_TYPES` / `BLOCK_NODE_TYPES` membership, `NODE_ALLOWED_FIELDS` / `NODE_ALLOWED_ATTRS`, the `validateNodeAttrs` branch, a per-document counter bounded by `maxAttachments`, the leaf rule, `noteDocumentAttachmentAttrs` and its guards, `renderAttachmentHtml`, the plain-text projection, `recoverTextFromNode`, `normalizeAttachmentNode`, and four class constants. The node's attributes are exactly `{ attachmentId, name, mimeType, sizeBytes }`.
- `attachment.schema.ts` gains `ATTACHMENT_FILE_MIME_TYPES`, `ATTACHMENT_TEXT_MIME_TYPE`, `ATTACHMENT_FILE_EXTENSIONS`, `ATTACHMENT_TEXT_EXTENSIONS`, `ATTACHMENT_UPLOAD_ACCEPT`, `attachmentFileMimeTypeSchema`, and `MAX_ATTACHMENT_UPLOAD_BYTES` (50 MiB).
- `format-bytes.ts` is new and now the single byte formatter for the product: `formatBinaryBytes` and `exactByteLabel`, in binary units, locale-fixed to `en` because the document renderer runs server-side during export with no reader locale.

### API (`apps/api`)

- `attachment-admission.ts` is the **single classifier** for an upload: image signature → generic-file signature → text extension allow-list plus content scan → refuse. Both `uploadImage` and `uploadFile` re-run it, so the transport cannot force a pipeline.
- `file-signature.ts` sniffs PDF/ZIP/DOCX/XLSX/RAR4+5/7Z/TAR/GZIP/RTF, disambiguating OOXML through `[Content_Types].xml` plus the declared extension.
- `text-safety.ts` admits a text or code file by extension allow-list plus a whole-buffer NUL scan and a bounded 64 KiB UTF-8 validation, then the row stores it as `text/plain` — which is what makes an uploaded `.html` inert.
- `filename.ts` forces the stored extension to the canonical extension of the **sniffed** type, so `invoice.pdf.exe` cannot survive.
- `attachments.service.ts#uploadFile` implements the ADR 0005 four-step saga with generalized compensation; `resolveVariant` is media-type aware and `SERVABLE_FILE_MIME_TYPES` guards what may be streamed.
- `attachments.controller.ts` routes one `POST …/notes/:noteId/attachments` endpoint by admission verdict, and always sends a generic file with `Content-Disposition: attachment` **and** `X-Content-Type-Options: nosniff`.

### Editor and frontend (`apps/web`)

- `extensions/CustomAttachment.ts` is the plain-DOM card node view: four render states (`ready` / `failed` / `missing` / `unknown`), a directory subscription, a download anchor, a preview button for PDFs, a delete button hidden from readers, and the paste/drop/drag plugin. It raises two bubbling `CustomEvent`s so React can own the dialogs without anything React-shaped entering the editor subtree.
- `attachment-icons.ts` / `attachment-transfer.ts` supply the six hand-authored SVG icons and the non-image transfer extraction.
- `image-upload-placeholder.ts` gains `completeAttachment(id, attrs)` — the file-shaped counterpart of `complete`, in the same single chained transaction.
- `lib/notes/image-uploads.ts` gains a `kind` discriminator (`"image" | "file"`) on `enqueue`, on `ImageUploadItem`, on `ImageUploadCall`, and on the failure copy, plus an injectable `check`. **The queue itself is shared, not duplicated.**
- `lib/notes/attachment-uploads.ts` is new: `checkAttachmentFile`, `attachmentFileExtension`, and the `checkUploadFile` dispatcher.
- `components/notes/useImageUploads.ts` gains the attachment picker ref, `handlePickedAttachmentFiles`, kind-aware completion, and `attachmentNodeName` — a guard that guarantees the emitted node parses.
- `AttachmentDialogs.tsx` / `AttachmentDeleteDialog.tsx` / `PdfPreviewDialog.tsx` and `lib/notes/pdf-preview.ts` add the confirmed deletion and the canvas-only PDF preview.
- `/attachment` slash command, an "Attach file" toolbar button in the `insert` group, card styling in `globals.css`, and print rules in `print.css`.

## Important Decisions

- **415 refusals reuse the existing `UNPROCESSABLE_ENTITY` error code** rather than inventing a new one, following the Part 40 idiom.
- **Uploads buffer in memory, with no temp file.** Rationale is in `uploadFile`'s docblock. Flagged for the reviewer as a deliberate, revisitable choice at the 50 MB ceiling.
- **The multipart parser bound is widened to `max(image, file)`**, and the narrower image ceiling is re-applied *after* sniffing inside `uploadImage`. A single parser bound cannot know which pipeline will run.
- **`mimeType` on the node is validated by a bounded MIME grammar, not a closed enum.** A closed set would desync from a growing server list, and a desync would make `safeParseNoteDocument` reject the document — which stops autosave silently and permanently. The grammar cannot go stale.
- **The node carries no URL-shaped attribute of any kind.** `NODE_ALLOWED_ATTRS.attachment` rejects one, and a contract test asserts it for `src`/`url`/`href`/`downloadUrl`/`contentUrl`/`objectKey` including `blob:` and `data:` values. Bytes resolve through the directory and `ATTACHMENT_API_PATHS`.
- **The card node view is plain DOM; the dialogs are React, reached by bubbling `CustomEvent`.** A React node view would break `ignoreMutation: () => true`, which is what stops ProseMirror reading the card subtree back as document content.
- **The upload queue is shared with a `kind` discriminator and an injectable `check`.** Bounded concurrency, one idempotency key per file across retries, the single automatic retry, cancellation, and orphan cleanup are identical requirements for a PNG and a PDF; a second copy would be a second set of bugs. Only the pre-flight bounds, the endpoint routing (server-side), and the completion node type differ.
- **The attachment transfer plugin registers *after* the image one**, because ProseMirror stops at the first `handleDrop` returning `true`. The image plugin consumes any payload containing an image and declines otherwise, so this one only ever sees image-free payloads. **A mixed drop therefore inserts the images only** — a documented limitation rather than one plugin calling `preventDefault` on the other's behalf.
- **Two hidden file inputs, not one with a swapped `accept`.** `accept` must be correct before `click()`, and mutating it between an image request and a file request is a race a writer would experience as the wrong dialog filter.
- **The delete confirmation calls the REST delete *first* and removes the node only on success.** The reverse order would let a failed delete leave a file in storage referenced by nothing — silently costing the workspace quota against a workspace that believes it deleted the file. The benign residue (row deleted, document write fails) repaints as unavailable on the next load.
- **Deletion removes every card referencing the id**, not the one at the event's `pos`: the position can be stale after edits made while the dialog was open, and once the bytes are gone every card referencing them is dead.
- **PDF preview renders to `<canvas>` only.** Never `<iframe>`/`<embed>`/`<object>` — a PDF is active content, ADR 0005 forbids serving it inline, and the API's `Content-Disposition: attachment` would make a frame download rather than render anyway. `isEvalSupported: false`, `disableAutoFetch`, `disableStream`, `useWorkerFetch: false`, no `cMapUrl`, no `standardFontDataUrl`, no annotation layer.
- **`pdfjs-dist` is pinned at `5.6.205` (Apache-2.0).** `5.7` and `6.x` declare `engines.node` ranges this repository's declared floor of `>=22.12.0 <23` does not satisfy; `5.6.205`'s `>=20.19.0` disjunct does. Full reasoning is in ADR 0008.
- **No new keyboard shortcut.** The shortcut surface is a fixed, tested set, and attaching a file is not frequent enough to claim another chord. `editor-shortcuts.test.tsx` and `keyboard-shortcuts-dialog.test.tsx` are untouched.
- **`NOTE_DOCUMENT_SCHEMA_VERSION` stays `1`.** Adding a node type is additive: every stored v1 document is still valid v1 and still means what it meant.

## Files and Components

| Path | Purpose |
|---|---|
| `packages/shared-validators/src/document.schema.ts` | The `attachment` node: limits, allow-lists, guards, counters, HTML render, plain-text projection, recovery |
| `packages/shared-validators/src/attachment.schema.ts` | File and text MIME/extension allow-lists, `ATTACHMENT_UPLOAD_ACCEPT`, `MAX_ATTACHMENT_UPLOAD_BYTES` |
| `packages/shared-validators/src/format-bytes.ts` | `formatBinaryBytes` / `exactByteLabel` — the single byte formatter (Part 45 reuses both) |
| `packages/shared-validators/src/index.ts` | Barrel |
| `apps/api/src/attachments/attachment-admission.ts` | `admitUpload()` — the single upload classifier both service methods re-run |
| `apps/api/src/attachments/file-signature.ts` | Magic-byte detection for the nine binary formats |
| `apps/api/src/attachments/text-safety.ts` | Text/code extension allow-list plus NUL and UTF-8 scan |
| `apps/api/src/attachments/filename.ts` | `sanitizeUploadFilename` — forces the extension to the sniffed type |
| `apps/api/src/attachments/attachments.service.ts` | `uploadFile()` saga, size guards, media-type-aware `resolveVariant` |
| `apps/api/src/attachments/attachments.controller.ts` | Upload routing, `Content-Disposition`, `X-Content-Type-Options: nosniff` |
| `apps/web/src/components/editor/extensions/CustomAttachment.ts` | The plain-DOM card node view, its commands, and its transfer plugin |
| `apps/web/src/components/editor/attachment-icons.ts` | Six hand-authored SVG icons and their labels (lucide is React-only) |
| `apps/web/src/components/editor/attachment-transfer.ts` | Non-image extraction from a clipboard or drag payload |
| `apps/web/src/components/editor/attachment-directory.ts` | `AttachmentEntry` widened with `mediaType`/`mimeType`/`sizeBytes`/`createdAt`/`contentUrl`; `documentHasAttachment` |
| `apps/web/src/components/editor/AttachmentDialogs.tsx` | React host for both dialogs; owns the confirmed-delete order and `removeAttachmentNodes` |
| `apps/web/src/components/editor/AttachmentDeleteDialog.tsx` | Destructive confirmation with a visible, harmless failure state |
| `apps/web/src/components/editor/PdfPreviewDialog.tsx` | Canvas-only PDF preview with page navigation and a live region |
| `apps/web/src/lib/notes/pdf-preview.ts` | `openPdfPreview` — fetch, parse, render; the only module that touches `pdfjs-dist` |
| `apps/web/src/lib/notes/attachment-uploads.ts` | `checkAttachmentFile`, `attachmentFileExtension`, `checkUploadFile` |
| `apps/web/src/lib/notes/image-uploads.ts` | `UploadKind` discriminator, injectable `check`, kind-aware failure copy |
| `apps/web/src/lib/notes/attachment-requests.ts` | `attachmentEntry` populates the new projection fields |
| `apps/web/src/components/editor/extensions/image-upload-placeholder.ts` | `completeAttachment` on `ImageInsertionController` |
| `apps/web/src/components/notes/useImageUploads.ts` | Attachment picker, kind-aware completion, `attachmentNodeName` parse guard |
| `apps/web/src/components/notes/ImageUploadFileInput.tsx` | Optional `accept` / `testId` so a second instance can exist |
| `apps/web/src/components/notes/NoteEditorSurface.tsx` | Second file input; directory fetch gated on image **or** attachment |
| `apps/web/src/components/editor/TiptapEditor.tsx` | New `uploadAttachments` / `onRequestAttachmentFiles` / `workspaceId` seams; renders `AttachmentDialogs` |
| `apps/web/src/components/editor/extensions/note-editor-extensions.ts` | Registers `createNoteAttachment` **after** `createNoteImage` |
| `apps/web/src/components/editor/slash-commands.ts` | `/attachment`, immediately after `/image` |
| `apps/web/src/components/editor/toolbar-commands.ts` | "Attach file" button in the `insert` group |
| `apps/web/src/styles/globals.css` | Attachment card styling |
| `apps/web/src/styles/print.css` | Card prints as content; action buttons drop as chrome (plain CSS, no Tailwind) |
| `apps/web/src/test/editor-harness.tsx` | `attachmentFileRequests` spy |
| `docs/decisions/0008-runtime-and-package-compatibility.md` | `pdfjs-dist` matrix row and the Part 44 dependency review |
| `THIRD-PARTY-NOTICES.md` | `pdfjs-dist` row; scope extended to parts 40–44 |

## Database and Data Changes

**None.** No migration was generated and none is needed. `attachments.media_type` already admits `'file'` and the `variants` column already declares `preview`, both from Part 40/41. No backfill, no retention change, and nothing to roll back at the data layer.

## API, Configuration, and Operational Changes

- **New runtime dependency: `pdfjs-dist@5.6.205` in `apps/web`** (Apache-2.0), already installed and in `pnpm-lock.yaml`. It is loaded **only** through a dynamic `import()` in `apps/web/src/lib/notes/pdf-preview.ts`, so it is absent from the note bundle until a reader opens a preview. Its worker is emitted as a local asset by `new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url)`; it is never fetched from a CDN, which the page CSP would refuse. Version choice is constrained by this repository's Node floor — see the ADR 0008 row.
- **Upload-endpoint routing change.** `POST /api/v1/workspaces/:workspaceId/notes/:noteId/attachments` is unchanged in path, method, and response envelope, but its behaviour is now **content-directed**: `admitUpload` sniffs the buffer and dispatches to `uploadImage` or `uploadFile`. The client never chooses; `call.kind` exists only for the browser-side queue's pre-flight and completion. This is backward compatible for every existing image caller — an image produces exactly the response it produced before. A file that matches no signature and no text allow-list is refused with the existing `UNPROCESSABLE_ENTITY` code.
- **Multipart parser bound widened** to `max(MAX_IMAGE_UPLOAD_BYTES, MAX_ATTACHMENT_UPLOAD_BYTES)`. The narrower image ceiling is re-applied after sniffing, so an oversized image still fails with 413 — but it now fails after the parser rather than during it. Operators who lowered `MAX_UPLOAD_SIZE_BYTES` are unaffected: that value may only lower the effective bound, never raise it past the shared constant.
- **Content responses** for a generic file always carry `Content-Disposition: attachment` (with the server's sanitized filename) and `X-Content-Type-Options: nosniff`. No new environment variable, port, queue, feature flag, or deployment step. Defaults are safe for development and production as shipped.

## Security and Tenant-Isolation Notes

- **The document stores no URL.** The only handle on the bytes is `attachmentId`, resolved through an endpoint that re-checks workspace membership on every request, so a note that is copied, exported, or shared cannot carry a link that outlives the reader's permission. A forged id from another workspace renders as unavailable and discloses nothing. Asserted by contract tests, an editor clipboard test, and the Playwright spec.
- **Admission is server-side and content-directed.** The client's declared MIME type is never trusted: binaries are admitted by magic bytes, text and code by a closed extension allow-list plus a NUL and UTF-8 scan, and the stored type for the latter is normalized to `text/plain` so no path can be talked into rendering an uploaded `.html`. The stored extension is forced to the canonical extension of the sniffed type.
- **Untrusted active content is never served inline.** Generic files always download; the PDF preview parses bytes into drawing operations in the reader's own browser and puts only pixels on an application-owned canvas, with pdf.js's `eval` path, auto-fetch, streaming, and worker fetch all disabled and the annotation layer never built.
- **Deletion is authorized twice over**: the control is hidden from a reader who cannot edit, and the server would refuse it regardless. The confirmation destroys nothing until the server confirms.
- **Pre-flight is a courtesy, never a control.** `checkAttachmentFile` exists so a writer learns about a 60 MB file immediately; the server re-derives type, re-measures length, and re-checks the workspace quota on every upload.
- **No secrets, content, credentials, or URLs are logged** by any code added in this part.
- **Negative tests:** cross-tenant access, permission loss after upload, quota exhaustion, and per-category lifecycle are covered by `apps/api/test/attachments.integration.test.ts`; the client-side refusal path and the read-only card are covered by the web suites.

## Verification Evidence

Run by the fix pass after the first review round. Every row below was executed and watched.

| Check | Result | Notes |
|---|---|---|
| `pnpm build:packages` | Pass | Run first, as required. |
| `pnpm format:check` | Pass | After `pnpm format`. |
| `pnpm lint` | Pass | After `pnpm lint:fix` cleared 5 `import-x/order` errors. |
| `pnpm type-check` | Pass | Includes the removed dead `NOTE_DOCUMENT_ATTACHMENT_SIZE_CLASS` import and the narrowed `ImageInsertionController.complete` parameter. |
| `pnpm test` | Pass | 6/6 tasks. |
| `pnpm --filter @notted/shared-validators test` | Pass | 292/292. |
| `pnpm --filter @notted/api test` (**inside the `api` container**) | Pass | 998 passed, 4 skipped. On the host `DATABASE_URL`/`MINIO_ENDPOINT` are absent and 73 DB/MinIO-gated tests skip — the container run is the decisive one. |
| `apps/api` coverage (70 % thresholds, in container) | Pass | 83.45 % statements / 76.83 % branches / 86.27 % functions / 85.16 % lines; exit 0. |
| `pnpm --filter @notted/web` coverage (70 % thresholds) | Pass | 81.98 / 74.48 / 84.39 / 84.54; exit 0. |
| `pnpm build` | **Fail (environment, not code)** | `NEXT_PUBLIC_APP_URL must use a secure protocol in production`, from the dev `apps/web/.env.local`. Re-run with production-shaped env: `next build` completes, so the `pdfjs-dist` worker `new URL(…, import.meta.url)` resolution under the pinned Turbopack is confirmed good. |
| `apps/api/test/attachments.integration.test.ts` (live PostgreSQL + MinIO) | Pass | Including *"uploads, downloads, and deletes every documented file category with isolation intact"* — verified running, not skipping. |
| `apps/web` attachment suites (`custom-image`, `attachment-card`, `attachment-directory`, `attachment-requests`, `attachment-uploads`, `image-upload-placeholder`) | Pass | 178/178 in a targeted run. |
| `apps/web/e2e/note-attachments.spec.ts` (Chromium, disposable stack with MinIO) | Pass | Both journeys green on first execution: upload → card → download → confirmed delete storing no URL, and refusal of an unsupported file without contacting the server. Run as part of 8/8 under `pnpm e2e:test --grep "image\|attachment"`. |
| Firefox / WebKit | Not run | Only the Chromium project is the maintained baseline. Still owed. |
| Manual: print preview of a note containing a card | Not run | Still owed. |

## Known Limitations and Follow-up Work

- **A mixed drop inserts the images only.** The image transfer plugin consumes any payload containing an image; the attachment plugin registers after it and never sees that payload. Making both consume one drop would mean one calling `preventDefault` on the other's behalf. Documented in `CustomAttachment.ts`.
- **The upload placeholder still announces "Image upload: report.pdf"** for a generic file. `paintPlaceholder`'s `aria-label` is hard-coded in `image-upload-placeholder.ts`, and this unit was scoped not to alter that file beyond adding `completeAttachment`. A small, safe follow-up: thread the noun through `ImagePlaceholderState`.
- **Uploads buffer entirely in memory**, with no temp-file spooling, at a 50 MB per-file ceiling and bounded concurrency. Acceptable at this ceiling and flagged for the reviewer.
- **The PDF preview has no zoom, text selection, or search**, and a canvas is opaque to assistive technology. The dialog says so plainly and keeps Download reachable throughout, because opening the file in a real PDF reader is the accessible path.
- **Preview is refused above `MAX_PDF_PREVIEW_BYTES` (25 MiB)**, well below the 50 MB upload ceiling. Parsing a 50 MB PDF in the main browser process to look at page one is a poor trade; the reader is told to download instead.
- **No thumbnail or `preview` variant is generated for a generic file.** The `variants` column declares `preview` and nothing writes it yet. If a later part wants server-rendered first-page thumbnails, that is where they go. **When one does, two lists must move together:** `OBJECT_BEARING_VARIANTS` in `attachment-object-keys.ts` already includes `preview`, but `ATTACHMENT_OBJECT_KEY_PATTERN` in `attachment-storage-key.ts` accepts only `original|full|medium|thumbnail`. A `preview` object written today would parse as `unparsable_key` to Part 45's orphan sweep — which fails safe (it is never deleted) but strands the bytes permanently.
- **Part 45 owns the sweeps.** An attachment row whose card was deleted by a *document* edit rather than by the confirmation dialog is an orphan this part does not reclaim — see Handoff Notes.

## Handoff Notes

**For the Part 45 agent.**

- **Reuse, do not re-create:** `formatBinaryBytes` and `exactByteLabel` from `@notted/shared-validators` are the product's byte formatters and `WorkspaceStorageLimit.tsx` already consumes them. `MAX_ATTACHMENT_UPLOAD_BYTES` is the per-file ceiling an operator may lower but never raise.
- **The orphan class this part creates, which Part 45 must sweep:** an `attachments` row of `media_type = 'file'` that no note document references. It arises whenever a card is removed by an ordinary document edit — select the card and press Delete, undo/redo, or a paste that replaces a region — because only the *confirmation dialog* deletes the stored file. The dialog is the deliberate, confirmed path; the editor cannot intercept every way a node can leave a document, and silently destroying a file on an undoable edit would be far worse than leaving a row for the sweep. `useImageUploads` already deletes the narrower cancel-after-upload orphan through the `orphaned` event, so that case does not need sweeping.
- **Quota is enforced server-side in the upload saga.** The client never computes remaining quota; a quota refusal arrives as an ordinary failure envelope and is surfaced through `uploadFailureMessage`.

**For anyone changing this area.**

- **`safeParseNoteDocument` rejecting editor output stops autosave silently and permanently.** `attachmentNodeName` in `useImageUploads.ts` exists solely to guarantee the emitted node parses; do not simplify it away.
- **`createNoteAttachment` must stay registered after `createNoteImage`** in `note-editor-extensions.ts`. Reversing them lets the attachment plugin swallow an image drop.
- **Do not remove `rescueDeletedPlaceholders()` or its whole-document exception**, do not add a `destroy` hook to the upload decoration, and keep `addToHistory: false` on `begin()`/`abandon()`.
- **`print.css` must stay plain CSS** with no Tailwind and no app-shell dependency; Part 63 loads it standalone.
- **`pdfjs-dist` is referenced from exactly one module.** `pdf-preview.ts` declares the four calls it uses locally instead of importing the package's `.d.ts`, so an upgrade fails at that one boundary. Dropping the preview is a one-file change.
- **Service startup for the browser spec:** the disposable stack (PostgreSQL, Redis, **MinIO**, Mailpit) must be up and `PLAYWRIGHT_DISPOSABLE_TEST_RUN=true` set, or `note-attachments.spec.ts` skips.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-08 | frontend-editor-engineer agent | Initial record; part implemented, no quality gate run |
