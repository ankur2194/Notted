# Part 42 — Editor image insertion

## Status

- **State:** Complete — every gate passes, and the multi-file defect is fixed and verified in Chromium
- **Completed on:** 2026-08-07
- **Implemented by:** frontend-editor-engineer agent (implement-only unit); two independent review passes; a fix pass; final diagnosis and fixes by the orchestrating agent
- **Plan reference:** `Plan.md`, Part 42
- **Related records:** `part-40-secure-object-storage.md` (upload/list/content/delete routes, the proxied download decision, and the mandatory `Cross-Origin-Resource-Policy: same-site` override), `part-41-image-ingestion-processing.md` (the variant set and the bounded blur data URI this part renders), `part-33-tiptap-document-contract.md` (the contract widened here), `part-38-page-breaks-focus-mode.md` (the precedent for an additive node type at schema version 1), `part-39-note-autosave.md` (the single-version-cell invariant this part must not disturb), `part-36-mentions-slash-commands.md` (the `MentionDirectory` and `Mention.ts` shapes mirrored here). ADRs 0001, 0005.

## Objective

Let a writer put an image into a note by pasting, dragging, or picking files — with an immediate local preview, per-file progress, error, retry, and cancel — while the *saved* document never contains anything temporary. Multiple concurrent uploads must land where they were inserted, and the persisted note must reference attachments only.

Part 40 built the storage plane and Part 41 the processing plane. This part is the browser half, and it is the first part where a note's content refers to a resource that lives outside the document.

## Implemented Work

### Contract (additive, `packages/shared-validators/src/document.schema.ts`)

- `image` appended to `NOTE_DOCUMENT_NODE_TYPES` and to `BLOCK_NODE_TYPES` — **block, not inline**, because Part 43's alignment, text wrap, full-bleed width, and caption all need a block box, and adding it as inline would force a second, incompatible widening later.
- `NODE_ALLOWED_FIELDS.image = { type, attrs }` — an atom with **no marks**, exactly like `mention`, so an image cannot smuggle a link, a colour, or any other mark through the renderer.
- `NODE_ALLOWED_ATTRS.image = { attachmentId, alt, width, height }`. **There is no `src`, `url`, `previewUrl`, or `dataUri`, and there never will be** (see Decision 3).
- `NOTE_DOCUMENT_LIMITS` gains `maxImages: 100`, `maxImageAlt: 500`, `maxImageDimension: 10_000`, and an `images` counter alongside the existing node/text/table-cell/mention counters. The image count is a fan-out bound: it caps how many authorized content requests opening one note can generate.
- `validateNodeAttrs` image branch: UUID `attachmentId`; bounded, control-character-free `alt` where `""` is explicitly valid and means *decorative*; `width`/`height` each `null`, absent, or a positive integer within `maxImageDimension`.
- Leaf clause in `validateContentStructure`, so an image with children or text is rejected.
- `renderNodeHtml` emits `<img class="notted-image" data-attachment-id="…" alt="…" loading="lazy" decoding="async">` with **no `src`**, plus the new `NOTE_DOCUMENT_IMAGE_CLASS` beside `NOTE_DOCUMENT_MENTION_CLASS`. This module has no workspace id and no authorization context, so URL substitution belongs to Part 63's export pipeline, keyed off `data-attachment-id`.
- `normalizeUnsupportedNodes` recovers an image in canonical form (which is how a historical node carrying a stray `src` loses it instead of failing the note), keeps it when the attachment id is a UUID, and otherwise degrades it to its alt text rather than dropping it. `extractNoteContentPlain` and the last-resort text recovery both read the alt.
- Exported: `NOTE_DOCUMENT_IMAGE_CLASS`, `noteDocumentImageAttrs`, `NoteDocumentImageAttrs`.

### Editor

- **`extensions/CustomImage.ts`** — hand-written block atom, `parseHTML` restricted to `img[data-attachment-id]`, `renderHTML` with no `src`, a blur-up node view, `setNoteImage`, `nottedRequestImageUpload`, and — in `addProseMirrorPlugins()` — the placeholder plugin and the paste/drop/drag handlers.
- **`extensions/image-upload-placeholder.ts`** — the decoration plugin, the imperative widget DOM, and `ImageInsertionController` (`begin`/`update`/`complete`/`abandon`/`has`/`ids`), the only surface through which the upload host touches ProseMirror.
- **`image-transfer.ts`** — pure extraction over a structural `DataTransferLike`, the "is this HTML meaningful?" routing rule, and the object-URL registry.
- **`attachment-directory.ts`** — `AttachmentDirectory`, shaped exactly like `MentionDirectory`, plus `documentHasImage` for lazy fetching.
- **`TiptapEditor.tsx`** — three new optional props (`uploadImages`, `onRequestImageFiles`, `attachmentDirectory`) stored in refs and resolved at call time, never captured by the `useMemo(…, [])` extension list. `editorProps` remains `attributes`-only.

### Upload

- **`lib/notes/upload-request.ts`** — `XMLHttpRequest`, `withCredentials`, one reused `Idempotency-Key`, and the same `NoteRequestResult` envelope and status→`kind` mapping as `lib/notes/requests.ts`.
- **`lib/notes/image-uploads.ts`** — the pure queue: pre-flight against the shared constants, concurrency capped at 3, one automatic retry for a retryable envelope only, manual retry/cancel/dismiss, and an `orphaned` event for a transfer that succeeds after cancellation.
- **`lib/notes/attachment-requests.ts`** — listing, delete, the absolute proxied content URLs, and the `AttachmentMedia` → `AttachmentEntry` projection.
- **`components/notes/useImageUploads.ts`** — the React adapter, and the only place the two halves meet.
- **`components/notes/ImageUploadFileInput.tsx`** — the hidden multi-select picker, owned by `NoteEditorSurface`.

### Surfaces

One `SLASH_COMMANDS` entry (`/image`) and one `insert`-group **button** item (`Insert image`). No `EditorToolbar.tsx` change, no new `ToolbarControlKind`, and **no keyboard shortcut** — `Plan.md` lists paste, drop, and picker only, and leaving `EDITOR_SHORTCUTS` alone keeps its exact-set assertion untouched.

## Important Decisions

1. **Temp state lives in decorations, never in a `pending` node. This is the load-bearing decision of the part, and it is about autosave correctness rather than style.**

   A pending *node* is part of `editor.getJSON()`. That means `onUpdate` fires, `onDocumentChange` fires, and Part 39's autosave PATCHes a document referencing an attachment that does not exist yet. The API must then either accept dangling references — a tenant hazard, and the opposite of the convention `projects.service.ts:567-577` sets — or reject the write. A rejection arrives as `kind: "invalid"`, which the autosave machine correctly treats as **non-retryable**: it parks in `error` *after* a broken document has already been persisted, and tells the writer saving has stopped for a reason they cannot act on.

   Decorations add **zero nodes**: `getJSON()` is byte-identical, `onDocumentChange` is never called, autosave stays exactly where it was, and `safeParseNoteDocument` has nothing to reject. The `blob:` URL exists only inside a `Decoration.widget`'s DOM. `DecorationSet.map(tr.mapping, tr.doc)` is then the mechanism that keeps N placeholders anchored while the writer types around them — which *is* `Plan.md`'s "multiple concurrent uploads preserve insertion positions", so it is implemented and tested as such. Completion is one transaction; cancellation and failure produce **no document change at all**.

2. **`NOTE_DOCUMENT_SCHEMA_VERSION` stays at `1`, and the trigger for the first bump is recorded in the source.** The change is additive and forward-only: a new node type widens what is accepted, so every document already stored as v1 is still valid v1, `migrateNoteDocument` has nothing to do, and no reader branches on the number — there is no persisted version column, so bumping it would change a constant nothing reads while implying a migration that does not exist. Part 38's `pageBreak` set this precedent. **The first *incompatible* change — removing a node/mark/attribute, narrowing an accepted value, or changing the meaning of a stored attribute — must, in the same part: bump the constant, add the persisted `content_schema_version` column, and ship a reviewed backfill plus a read-path migration keyed off it.** Adding a node type is not that change; renaming or re-typing one is.

3. **The image node has no `src`, and that absence *is* the guarantee.** `Plan.md` asks that "the saved document never relies on temporary blob or base64 URLs". Rather than checking for one at runtime, the contract provides nowhere to put one: `NODE_ALLOWED_ATTRS.image` contains four keys, and the loop in `validateNodeAttrs` rejects any node carrying a fifth. A dedicated `it.each` in `document.schema.test.ts` asserts exactly that for `src`, `url`, `previewUrl`, `dataUri`, `href`, `srcset`, and `blurDataUri`, with both a `blob:` and a `data:image` payload. No bug, refactor, or hostile client can persist a temporary source, because there is no field for it.

4. **`@tiptap/extension-image` is deliberately NOT installed.** Its entire data model is a `src` attribute — the one thing the contract forbids. Overriding its attributes would leave a dependency whose next minor version could quietly reintroduce the field, and would add a package for a node that is 40 lines of schema. `CustomImage.ts` is hand-written instead.

5. **`XMLHttpRequest`, not `fetch`.** `fetch` cannot report *upload* progress in any browser this product targets: request-side streaming is not available for multipart bodies, and no `fetch` API exposes bytes-sent. `xhr.upload.onprogress` is the only portable source. XHR is contained entirely in `upload-request.ts`, which returns the same envelope everything else uses, so no caller learns which transport ran. `tiptap-editor.test.tsx`'s "never contacts the server" assertion was **hardened** to cover `XMLHttpRequest` as well — otherwise the workaround for `fetch`'s limits would have been a hole in the rule that `fetch` check exists to enforce.

6. **`Origin` is not set by the client, and that is the point.** `Origin` is a forbidden header name, so `setRequestHeader("Origin", …)` is ignored by the browser. The header the server's `assertTrustedMutationOrigin` reads is set by the browser itself and cannot be forged by a page — which is exactly what makes the check meaningful. `withCredentials = true` is what carries the session cookie to the API origin. (The Playwright helpers still send `Origin` explicitly, because `APIRequestContext` is not a browsing context.)

7. **Zoom and `clientX`: do not divide.** `PageContainer` renders the sheet inside a `transform: scale()`, which invites a "correction" of the pointer coordinates. It is wrong. ProseMirror's `posAtCoords` compares `clientX`/`clientY` against `getBoundingClientRect()`, and a transformed element's rect is **already** reported in scaled viewport space; both sides carry the same scale. Dividing one of them puts the image somewhere the writer never dropped it. The finding is recorded as a comment at the call site and asserted at 125 % in `e2e/note-images.spec.ts`.

8. **`CustomImage.ts` keeps `Notted.md`'s capital-C/I spelling**, against `CLAUDE.md`'s kebab-case rule for `.ts` files. `Notted.md` is primary for directory structure, so the spec's spelling wins — the identical ruling already recorded in `extensions/Mention.ts`, whose header comment this file copies.

9. **The paste rule: image files win only when the clipboard's HTML means nothing.** A Word or Google Docs paste carries an inline image *and* real HTML; consuming it as an upload would silently throw the document away. `hasMeaningfulHtml` inspects the payload as text (never as a live DOM — it decides routing, so it must not be able to execute or fetch anything), bounded to the first 64 KiB, and treats any text content or any non-wrapper tag as meaningful.

10. **Drop returns `false` when `moved === true`.** Without it, dragging an existing image two paragraphs down would re-upload it. The drag highlight uses a **counter, not a boolean**, because dragging across a child element fires `dragleave` for the parent and a boolean flickers on every internal boundary crossing.

11. **Object URLs are revoked in exactly three places** — the decoration's `destroy()`, the host's unmount teardown, and immediately after a successful swap — and are tracked in a `Map` so the second and third are no-ops rather than a double revoke.

12. **A freshly uploaded image starts with alt text derived from the filename, not `alt=""`.** A filename is a weak alternative, but it is author-supplied text about *this* image; `alt=""` would silently declare a meaningful image decorative, and inventing a description would be a lie. Part 43 adds the editor that lets an author replace or clear it, at which point an explicit `""` genuinely means decorative.

13. **The node view loads the `full` rendition.** `full` is bounded to 2000 px by Part 41, which keeps a zoomed sheet and a printed page sharp, and the paper is only ~800 px wide. `medium` and `thumbnail` stay addressable in `AttachmentEntry.sources` for Part 43's sizing work.

14. **Within one batch dropped at one point, images appear in *completion* order, not file order.** Each placeholder is inserted at its own mapped position the moment its transfer finishes. Holding completed uploads back to force file order would mean a slow or failed first file blocks the rest — including one parked in a retryable error state waiting for a person. Landing at the right *position* is the criterion; ordering inside a simultaneous batch is not, and stalling on an error would be a worse failure than a reordering.

15. **`lib/notes/attachment-requests.ts` re-states the request helper rather than importing `requests.ts`'s `requestJson`,** which is private to that module. The shared part — the `NoteRequestResult` vocabulary eight surfaces already switch on — is imported.

16. **An attachment that lands after cancellation is deleted.** The server has no way to know the writer changed their mind mid-transfer, so a successful result for a cancelled task would leave a row nothing references. The manager emits `orphaned` and the adapter deletes it, best-effort and silently: the cancellation already succeeded from the writer's point of view.

## Files and Components

| Path | Purpose |
|---|---|
| `packages/shared-validators/src/document.schema.ts` | The `image` node: types, limits, allow-lists, validation, HTML projection, plain-text projection, normalization. Version comment now records the bump trigger. |
| `packages/shared-validators/src/document.schema.test.ts` | New "Part 42 image contract" suite, including the no-URL-attribute proof. |
| `packages/shared-validators/src/index.ts` | Exports `NOTE_DOCUMENT_IMAGE_CLASS`, `noteDocumentImageAttrs`, `NoteDocumentImageAttrs`. |
| `apps/web/src/components/editor/extensions/CustomImage.ts` | The block image atom, node view, commands, paste/drop plugin. |
| `apps/web/src/components/editor/extensions/image-upload-placeholder.ts` | Decoration plugin, widget DOM, `ImageInsertionController`. |
| `apps/web/src/components/editor/image-transfer.ts` | Pure payload extraction, HTML routing rule, object-URL registry. |
| `apps/web/src/components/editor/attachment-directory.ts` | Loaded attachment metadata as the node view sees it; `documentHasImage`. |
| `apps/web/src/components/editor/TiptapEditor.tsx` | Three optional props, held in refs. No I/O, no `editorProps` change. |
| `apps/web/src/components/editor/slash-commands.ts` | `/image`. |
| `apps/web/src/components/editor/toolbar-commands.ts` | `Insert image` button item. |
| `apps/web/src/components/editor/extensions/note-editor-extensions.ts` | Registers the image extension and its three options. |
| `apps/web/src/components/editor/extensions/index.ts` | Barrel exports for both new extension modules. |
| `apps/web/src/lib/notes/upload-request.ts` | XHR multipart upload with progress and abort. |
| `apps/web/src/lib/notes/image-uploads.ts` | Pure queue: pre-flight, concurrency, idempotency, retry policy, alt default, failure copy. |
| `apps/web/src/lib/notes/attachment-requests.ts` | Listing, delete, proxied content URLs, `AttachmentEntry` projection. |
| `apps/web/src/lib/notes/query-keys.ts` | `noteQueryKeys.attachments(workspaceId, noteId)`. |
| `apps/web/src/components/notes/useImageUploads.ts` | React adapter binding the queue to the controller and the query cache. |
| `apps/web/src/components/notes/ImageUploadFileInput.tsx` | Hidden multi-select picker with a `value` reset. |
| `apps/web/src/components/notes/NoteEditorSurface.tsx` | Owns the directory, the lazy attachment query, the hook, and the picker. |
| `apps/web/src/styles/globals.css` | Image frame, blur-up, fallback, placeholder, drop highlight, reduced motion. |
| `apps/web/src/styles/print.css` | Placeholders never print; images bounded and fully opaque on paper. |
| `apps/web/src/test/editor-harness.tsx` | Threads an `onRequestImageFiles` spy through as `imageFileRequests`. |
| `apps/web/e2e/note-images.spec.ts` | Real-browser upload, reload, CORP, 125 % drop, cancel, and the no-temporary-URL clause. |

New sibling suites: `image-transfer.test.ts`, `attachment-directory.test.ts`, `extensions/image-upload-placeholder.test.ts`, `extensions/custom-image.test.ts`, `lib/notes/upload-request.test.ts`, `lib/notes/image-uploads.test.ts`, `lib/notes/attachment-requests.test.ts`, `components/notes/use-image-uploads.test.tsx`, `components/notes/image-upload-file-input.test.tsx`.

## Database and Data Changes

None. No migration, no seed change, and no new persisted column. The document contract widened additively at version 1 (Decision 2), and the `attachments` table was created in Part 16 and used unchanged.

**Deferred deliberately:** no image was added to `seed-fixtures.ts`'s `RICH_TIPTAP_DOCUMENT`. Doing so would require a real `attachments` row (and its object bytes) alongside the seed, and would ripple into the seed and note integration tests, which currently assert that document's exact shape. The ProseMirror round trip is proven instead by the image node added to `richDocumentFixture` in `note-editor-extensions.test.ts`, and end-to-end persistence by `e2e/note-images.spec.ts`.

## API, Configuration, and Operational Changes

No new route, environment variable, port, or flag. The frontend consumes Part 40's four existing endpoints through `ATTACHMENT_API_PATHS`.

**No new save call site exists anywhere in this part.** The temp→permanent swap is an ordinary editor transaction that takes exactly the route a typed character takes: `replaceWith` → `onUpdate` → `safeParseNoteDocument` → `onDocumentChange` → `useNoteAutosave` → one debounced PATCH carrying `expectedVersion`. Three uploads finishing inside the 800 ms debounce therefore produce three transactions and exactly one PATCH, and Part 39's single-version-cell invariant (the API bumps `version` by exactly one per update, so there is one version cell and at most one request in flight) is untouched.

Operationally, the one thing that can break this part without breaking anything else is Part 40's `Cross-Origin-Resource-Policy: same-site` header. Bare `helmet()` defaults to `same-origin`, which makes a browser hard-block an `<img>` on `:3000` pointing at `:3001`. jsdom does not enforce CORP, so only the Playwright `naturalWidth > 0` assertion can catch a regression.

## Security and Tenant-Isolation Notes

- **Backend policy stays authoritative.** Nothing here re-implements authorization. Every byte is fetched from the proxied content endpoint, which re-checks workspace membership per request; there are no presigned URLs anywhere in the frontend and MinIO is unreachable from a browser (ADR 0005).
- **A forged `data-attachment-id` discloses nothing.** `parseHTML` adopts only `img[data-attachment-id]`, and an adopted id is only a reference: reading the bytes is authorized server-side, so an id copied from another workspace renders as unavailable rather than leaking anything. The contract additionally requires it to be a UUID.
- **A pasted remote `<img src="https://evil/">` is dropped**, so no tracker or third-party reference can enter a note through the clipboard. Asserted in `note-editor-extensions.test.ts`.
- **Client pre-flight imports the server's own constants** (`ATTACHMENT_IMAGE_MIME_TYPES`, `MAX_IMAGE_UPLOAD_BYTES`), so the two bounds cannot drift. It is a courtesy for instant feedback, never a control: the server re-sniffs magic bytes and re-measures length regardless.
- **The blur data URI is validated twice before it reaches CSS** — by the shared schema on the wire, and by a local `data:image/…;base64,…` pattern before it is interpolated into a `url()`. A value that is not a bounded image data URI paints nothing. Tested with a CSS-injection payload.
- **Alt text is bounded and control-character-free in the contract**, escaped by `renderDocumentHtml`, and set through `textContent`/`.alt` in the DOM, so untrusted author text is never interpolated into markup.
- **Idempotency**: one key per file, reused across every retry, so a retry after a timeout cannot create a second attachment for bytes already stored.
- **No secret, cookie, object key, or signed URL is logged or rendered.** `AttachmentEntry` carries no key, and the server-side projection strips it.

## Accessibility Notes

- The upload placeholder is `role="group"` with an `aria-label` naming the file, a hand-rolled `role="progressbar"` (`aria-valuemin`/`max`/`now`/`valuetext`, and **no `aria-valuenow`** while the length is indeterminate), and a `role="status" aria-live="polite"` line carrying every state change in words. `@radix-ui/react-progress` was not added for one non-interactive bar in a non-React widget.
- Cancel, Retry, and Dismiss are real `<button type="button">` elements inside a `contenteditable="false"` widget, reachable and operable from the keyboard.
- Images: `alt` is preserved verbatim, including `""` for decorative. The failure fallback is `role="img"` with the author's alt as its accessible name, and is `aria-hidden` when the image is decorative — announcing "unavailable" for an image the author marked decorative would be noise, not information.
- A selected image gets a visible focus ring via `.ProseMirror-selectednode`.
- The fade-in and the progress-bar transition are both removed under `prefers-reduced-motion: reduce`.
- The hidden file input is `tabIndex={-1}` and `aria-hidden`, because the toolbar button and the `/image` command are the labelled controls; a second unlabelled tab stop would be noise, not access.

## Verification Evidence

Every gate below was **executed**, one at a time. Results are recorded as observed.

| Check | Result | Notes |
|---|---|---|
| `pnpm build:packages` | Pass | **Required before anything in `apps/web` compiles.** The root script is `pnpm build:packages`; `pnpm contracts:build` exists only inside `apps/web`. |
| `pnpm lint` | Pass | Two real errors fixed: an unused `_blob` parameter (the config's `no-unused-vars` reports a sole unused argument regardless of the underscore) and `import-x/order`. |
| `pnpm format:check` | Pass | |
| `pnpm type-check` | Pass | One real error fixed in `CustomImage.ts`: an unused `view` parameter in the `dragover` handler, which blocked `next build` as well as `tsc`. Resolved as `_view` — **contrary to the review note, the underscore escape does work here**, and this was verified by running both gates rather than reasoned: TypeScript's `noUnusedParameters` ignores `_`-prefixed parameters by design, and ESLint's default `args: "after-used"` never reports a parameter that precedes a used one. |
| `pnpm test` | Pass | web **1016 passed** after the regression tests added with the multi-file fix. |
| `pnpm --filter @notted/web test:ci` (70 % coverage) | Pass | Global **82.73 stmts / 75.51 branch / 85.20 funcs / 84.93 lines** (final). Part 42 directories: `components/editor` 93.19/86.82/97.88/97.83, `lib/notes` 95.15/92.37/95.91/96.76, `components/notes` 81.40/68.90/78.29/83.29. Per new file: `ImageUploadFileInput.tsx` 100/87.5/100/100, `useImageUploads.ts` 93.18/84.78/80/96.25, `image-uploads.ts` 95.89/82.6/95.65/98.51, `attachment-requests.ts` 96.66/96.77/100/100, `upload-request.ts` 92.68/87.32/100/94.59. The `components/notes` branch figure of 68.90 % is dragged down by pre-existing Parts 30–39 files (`NoteTree` 65.45, `NoteBrowser` 59.37, `NoteCard` 60.71), not by anything added here. |
| `pnpm build` | Pass | Needs the production-shaped env override recorded in the Part 40 record. |
| `apps/web/e2e/note-images.spec.ts` — "drops an image where the pointer is, at 125 % zoom" | **Pass** | Runs at last, in Chromium. |
| `apps/web/e2e/note-images.spec.ts` — "cancelling an upload leaves the document exactly as it was" | **Pass** | |
| `apps/web/e2e/note-images.spec.ts` — "uploads, renders, persists, and never stores a temporary URL" | **Pass** | Three files, three image nodes. Failed until the root cause below was found and fixed; the spec now passes 3/3 in Chromium, repeatedly. |
| Chromium `naturalWidth > 0` (the CORP assertion) | **Pass** | Reached and passed inside the 125 % drop test — a real `<img>` loads a proxied rendition across `localhost:3000` → `localhost:3001`. The phase's highest-risk item is closed. |
| Firefox / WebKit | Not run | Only `--project=chromium` was run. |

### Running Playwright here (the invocation actually works)

Chromium cannot launch on this host, so Playwright runs containerized, joined to
the API container's network namespace. **The service hostnames matter**: inside
that namespace `127.0.0.1` is the API container, so Mailpit and PostgreSQL must
be addressed by their compose DNS names, not by loopback.

```
docker run --rm --network "container:$(docker compose ps -q api)" \
  -v "$PWD:$PWD" -w "$PWD/apps/web" --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e PLAYWRIGHT_DISPOSABLE_TEST_RUN=true -e PLAYWRIGHT_REUSE_EXISTING_SERVER=true \
  -e DATABASE_URL="postgres://notted:notted_dev_password@postgres:5432/notted_dev" \
  -e PLAYWRIGHT_MAILPIT_URL="http://mailpit:8025" \
  mcr.microsoft.com/playwright:v1.62.0-noble npx playwright test --project=chromium
```

The `web` service must be running (`docker compose up -d web`); a host
`pnpm build` rewrites the shared `.next` directory and stops it. `note-images.spec.ts` on its own: **3 passed**, confirmed over repeated runs.

The remaining full-suite failures are in Parts 27/30/32 and the auth specs, and
they are **not** caused by Parts 40-42. That was established by execution, not by
inspection: running `note-management`, `project-management`, and
`workspace-management` together with the image spec **absent from the run** fails
identically, including a `strict mode violation: getByRole('heading', { name:
'Notes' }) resolved to 2 elements` — a stale selector against a dev database that
has accumulated state across many runs, with nothing to do with attachments.

### Three spec defects fixed — this spec had never been executed

1. **The upload was never triggered.** The spec called
   `setInputFiles` directly on the hidden `input[type=file]`. That correctly does
   nothing: `useImageUploads.handlePickedFiles` ignores a selection no request is
   waiting for, because the caret position and the insertion controller are
   recorded when the pick is *requested*. Replaced with a `pickImages` helper
   that clicks the toolbar's "Insert image" button and answers the resulting
   `filechooser` — the real user path.
2. **`getByLabel("Zoom")` was a strict-mode violation** (4 matches: "Zoom
   controls", "Zoom out", "Zoom in", "Zoom"). Now `{ exact: true }` and selected
   by value, matching the proven helper in `page-layout.spec.ts`.
3. **`storedDocument` read the wrong response shape.** `GET /notes/:noteId`
   returns a `NoteDetail` with `content` at the top level; the spec expected a
   `{ note: { content } }` envelope that this endpoint does not send.

### RESOLVED — a multi-file batch lost all but one image (root cause and fix)

Selecting three files at once uploaded all three (three `201`s) but produced one
image node. The first four hypotheses were all wrong, and each was disproved by
an executed test rather than by reasoning: the backend was correct, the
placeholder plugin was correct *for the arrangement it was tested with*, the
hook was correct at `begin` time, and hook-plus-real-editor was correct in
jsdom. The suspected cause — a React re-render resetting editor content — was
also wrong.

**The real mechanism is in ProseMirror, and it is four steps:**

1. Every file in a batch is anchored at one position (`useImageUploads`), because
   one caret yields one `insertAt`.
2. The first `complete()` calls TipTap's `insertContentAt(pos, imageNode)`.
   `CustomImage` declares `group: "block"`, so `isOnlyBlockContent` is true and
   `@tiptap/core` *widens* the step — "replace an empty paragraph by an inserted
   image" — from `replaceWith(P, P, …)` to `replaceWith(P-1, P+1, …)`.
3. That widened step **spans the position its siblings are anchored at**, so
   `tr.mapping.mapResult(P).deleted` is true for them and `Decoration.map`
   returns `null`. Placeholders 2 and 3 are silently dropped.
4. Their `complete()` calls then find no position, return `false`, and the
   uploads are discarded with nothing surfaced to the writer.

**The failing set was wider than the browser showed.** A caret at the *end* of
any paragraph — the commonest caret position there is — fails identically, and a
whole-document replacement lost *every* upload. Only a caret strictly inside
text survived, which is exactly the arrangement every pre-existing test used.
That is why the entire suite passed while the feature was broken.

**Fix:** `rescueDeletedPlaceholders` in `image-upload-placeholder.ts`. A widget
decoration is an *anchor*, not content, so nothing about it is genuinely "inside"
the replaced range in the sense the mapping means. Any placeholder the mapping
reports as deleted is re-anchored with `tr.mapping.map(pos, 1)`, which never
reports deletion. The rescued decoration reuses the same `spec.dom` node and the
same spec object, so the widget is not torn down and `update` keeps mutating live
state. A placeholder can now leave the set only through an explicit `remove`.

**One deliberate exception:** `replacesWholeDocument()` suppresses the rescue when
a transaction replaces the entire document in a single step. That is what
`TiptapEditor`'s content-sync effect dispatches, *including when the surface
swaps to a different note* — re-anchoring through it would let an upload begun in
one note insert its image into another. Losing placeholders there is the
pre-existing and correct behaviour, and the manager still calls `forget()`, so no
preview leaks.

**Two rejected alternatives**, both tested rather than argued:
- *Raw `tr.insert(pos, node)` instead of `insertContentAt`* — still fails.
  Inserting a block inside a textblock splits it, and the step still spans the
  position.
- *Insert at the nearest block boundary* — lands all three, but reverses batch
  order whenever the caret is mid-paragraph or at the end, and it changes
  insertion semantics for every existing case.

**Verified in Chromium**, where the defect was originally seen: `note-images.spec.ts`
passes 3/3, repeatedly. New regression coverage is parameterised over the three
caret arrangements that were broken (empty paragraph, end of paragraph, start of
paragraph); the previously-passing mid-word case is retained.

### RESOLVED — one typed character revoked every in-flight preview

Independent of the above and present since the first draft. The decoration spec
carried a `destroy` hook wired to the object-URL registry. But `DecorationSet.map`
mints a new `Decoration` each transaction, and `prosemirror-view`'s `placeWidget`
only reuses a `WidgetViewDesc` when the decorations are *identical* or the widget
DOM is unattached — neither holds for a live placeholder. So the widget was torn
down and rebuilt on **every** document change, and one keystroke revoked the
`blob:` URL of every upload still in flight, blanking all their thumbnails.

**Fix:** the decoration registers no teardown at all. Revocation belongs entirely
to the upload manager, which owns the lifecycle rather than the rendering:
`forget()` on both terminal outcomes (`removed` and `uploaded`) and `releaseAll()`
on unmount. The registry keys its URLs, so a repeat is a no-op rather than a
double free. **The "exactly three revoke sites" claim in the original design was
wrong and is now two** — the third was the defect. A regression test asserts no
`destroy` is registered and that previews survive an edit.

### The four exact-set tests, and why each changed

Each of these is a guardrail that failed on first write because it was doing its job. None was relaxed.

| Test | Change | Why |
|---|---|---|
| `extensions/note-editor-extensions.test.ts:158` (`Object.keys(schema.nodes)` ⊇ `NOTE_DOCUMENT_NODE_TYPES`) | **Fixed by registering the extension**, not by editing the assertion. `richDocumentFixture` additionally gained an image node, and a new case asserts the serialized `<img>` has no `src` and that a pasted remote `<img>` is dropped. | The assertion's whole purpose is that the editor schema can represent everything the contract allows. Widening the contract without registering a node is the bug it exists to catch. |
| `suggestion-modules.test.ts:59` (`SLASH_COMMANDS` ids) | Appended `"image"`, and **rewrote the comment** that said `/image` was deliberately absent. The replacement states the rule the list actually encodes: an entry is added only *after* the contract can represent the node it produces, and notes that `/image` is the one entry that inserts nothing by itself. | The old comment was correct when written and would have become a lie. The ordering rule it records is the reason the list is asserted exactly. |
| `editor-slash-commands.test.tsx` (`COMMAND_EXPECTATIONS`) | Added a **behavioural** `image` expectation — exactly one file-picker request, at the position the trigger occupied, and *no* node added — which required changing the expectation signature from `(editor)` to a `{ editor, imageFileRequests }` context and threading a default `onRequestImageFiles` spy through `test/editor-harness.tsx`. | `/image` deliberately inserts nothing, so without the spy a test could not tell "asked the host to open the picker" apart from "did nothing at all". A completeness test satisfied by an empty expectation would be worthless. |
| `tiptap-editor.test.tsx:150` ("never contacts the server") | **Hardened**: also asserts `XMLHttpRequest` is never constructed. | Part 34's rule is "the editor performs no network I/O", not "no `fetch`". Part 42 introduced a second transport precisely because `fetch` cannot report upload progress; without this, a future refactor moving an upload into the editor would pass a green suite. |

### How `Plan.md`'s Verify clause is covered

| Requirement | Where |
|---|---|
| Multiple concurrent uploads preserve insertion positions | `image-upload-placeholder.test.ts` — placeholders mapped through edits made around them; out-of-order completion still yields document order; `use-image-uploads.test.tsx` — one placeholder per file at the requested position; `e2e/note-images.spec.ts` — three files, and a drop at 125 % zoom landing between the right paragraphs |
| The saved document never relies on temporary blob/base64 URLs | `document.schema.test.ts` — every URL-shaped attribute rejected, with `blob:` and `data:image` payloads; `custom-image.test.ts` — no `src` in `getJSON()`; `image-upload-placeholder.test.ts` — `getJSON()` byte-identical while a placeholder exists; `e2e/note-images.spec.ts` — the persisted document **and every captured PATCH body** contain neither |
| Clipboard paste | `custom-image.test.ts` (routing rules over a structural payload); `e2e` (real payload) |
| Desktop drag/drop | `custom-image.test.ts` (`moved`, position, non-image); `e2e` (real `DragEvent` at 125 %) |
| Multi-select file picker | `image-upload-file-input.test.tsx`; `use-image-uploads.test.tsx`; `e2e` `setInputFiles` with three files |
| Local preview, progress, error, retry, cancel | `image-upload-placeholder.test.ts` (widget states and ARIA); `image-uploads.test.ts` (queue policy); `use-image-uploads.test.tsx` (wiring); `e2e` (cancel leaves the document byte-identical) |
| Atomic replacement of temporary sources | `image-upload-placeholder.test.ts` — one transaction, one `update` event, placeholder gone |

## Known Limitations and Follow-up Work

- **CARRIED FORWARD TO PART 43 — an author-facing alt-text editor is required.** Today `useImageUploads` derives alt from the filename via `defaultImageAlt`. The review judged this **acceptable for Part 42 but not a resting place**: the alternative, defaulting to `alt=""`, would mark every uploaded image *decorative*, which is an affirmative WCAG 1.1.1 failure, so a weak-but-present alternative beats a false decorative marker. It is still a weak alternative, and the real remedy is an editor.

  **The contract is already ready for it.** `CustomImage.ts` preserves an
  author-set `alt=""` verbatim rather than falling back to a filename, so an
  author who marks an image decorative keeps that meaning through a save/load
  round trip. Part 43 therefore needs UI and validation only — no contract
  change. This is the largest accessibility gap in the part and Part 43 must not
  close without it.
- **`e2e/note-images.spec.ts` needs MinIO**, which no existing spec required, so the disposable-run documentation may need updating.
- **The shared `registerAndSignIn` helper is flaky against an accumulated dev database.** In a full-suite run one of the three image tests intermittently fails at sign-in with `login?redirect=…` before reaching any image assertion — the same failure shape as the pre-existing Parts 27/30/32 failures, which reproduce with the image spec absent from the run entirely. The image assertions themselves passed every execution. Not a Part 42 defect, but it makes the suite look non-deterministic.
- **No sizing, alignment, wrap, caption, or full-width** — all Part 43.
- **No delete-from-editor affordance.** Removing an image node leaves the attachment row; orphan reconciliation is **Part 45**.
- **Ordering within one simultaneous batch is completion order** (Decision 14).
- **No image in `seed-fixtures.ts`** (see Database and Data Changes).
- **`prefers-reduced-motion` does not yet stop an animated GIF from animating.** Part 41 produces static posters for `medium`/`thumbnail`, so this is implementable without re-processing once Part 43 chooses renditions.
- **Paste of a remote image URL does not fetch and attach it.** Only files are handled; a pasted `<img src>` is dropped by design.
- **The upload placeholder is not restored across a reload.** An in-flight upload is abandoned when the page unloads; the attachment may still be created server-side and becomes an orphan for Part 45.

## Handoff Notes

- **Part 43 (next):** extend `NODE_ALLOWED_ATTRS.image` and `validateNodeAttrs` for align/caption/wrap/fullWidth, then the node view. `AttachmentEntry.sources` already exposes all three servable renditions, and `--notted-page-content-width` is the token to clamp against (`globals.css` says so). Do **not** add a `src`. **The alt-text editor is a required deliverable of Part 43, carried forward from here** — see Known Limitations for why the filename default was accepted and why the contract already supports the fix.
- **Do not remove `rescueDeletedPlaceholders` or its whole-document exception** (`image-upload-placeholder.ts`). Both are load-bearing and both cost an image or a tenant boundary if dropped; the reasoning is under Verification Evidence, and the regression tests are parameterised over the caret arrangements that were broken.
- **Do not give the decoration a `destroy` hook.** It fires on every document change, not on teardown. Revocation belongs to the upload manager's terminal events.
- **Two `<img>` attributes are now set with `setAttribute`, not the IDL properties.** `loading="lazy"` and `decoding="async"` drive identical browser behaviour either way, but only the attribute form is observable through `getAttribute`, serialises into `outerHTML`, and survives a node clone — which is what makes the behaviour assertable at all. jsdom 25 does not reflect those IDL properties to attributes, so the previous form left both assertions silently meaningless.
- **Never create a second save call site.** The swap is a normal transaction; anything else breaks Part 39's single-version-cell invariant.
- **If you touch the drop handler, do not divide by the zoom scale** (Decision 7).
- **`@tiptap/extension-image` must stay uninstalled** (Decision 4).
- The upload queue is pure and injectable (`upload`, `createId`, `concurrency`); test policy changes there, not through the hook.
- `docs/decisions/` gained no ADR: nothing here changes a durable architectural boundary that ADRs 0001 and 0005 do not already cover.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-06 | frontend-editor-engineer agent | Initial record. Contract widening, decoration-based placeholders, XHR upload queue, node view, slash/toolbar entries, nine new unit suites, one Playwright spec, and four exact-set test updates. All verification deferred to the review pass. |
| 2026-08-07 | Parts 40–42 fix pass | All static gates and unit suites executed and passing (web 1010). Fixed the lint/type-check errors, corrected two test doubles and two stale expectations, switched `loading`/`decoding` to attributes so their assertions mean something, and got Playwright running for the first time — CORP and the 125 % drop position are now verified in Chromium. Fixed three defects in the never-executed Playwright spec. Recorded the alt-text carry-forward to Part 43 (I2) and **one open real-browser defect**: a multi-file batch lands only one image. |
