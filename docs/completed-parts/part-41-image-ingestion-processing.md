# Part 41 — Implement image ingestion and processing

## Status

- **State:** Verified — gates run and passing; one licence sign-off outstanding
- **Completed on:** 2026-08-07 (blocked on the `libheif-js` LGPL-3.0 human decision below)
- **Implemented by:** backend-platform-engineer agent (Unit 2 of the Parts 40–42 session; implementation started in one session, audited and finished in a second); verified by the review pass and closed by the Parts 40–42 fix pass
- **Plan reference:** `Plan.md`, Part 41
- **Related records:** `part-40-secure-object-storage.md` (the seam, key policy, lifecycle, and download route this part fills in), `part-16-tags-attachments-comments-versions.md` (the `attachments` table and its `variants` jsonb), `part-33-tiptap-document-contract.md` (`sanitizeDocumentUrl`, which is why the blur data URI can never enter a document). ADRs 0001, 0005, 0006, 0008.

## Objective

Turn one uploaded image into the renditions the editor needs, safely. Accept JPEG, PNG, GIF, WebP, SVG, and HEIC; strip metadata; rasterize SVG; convert HEIC; make animated-GIF handling a deliberate decision rather than an accident; emit `thumbnail`, `medium`, and `full` plus a blur placeholder; and record dimensions, storage keys, and failures — all within bounded time, memory, and pixel budgets, because Part 40 chose to process synchronously inside the upload request.

Part 40 built everything around this work and left exactly one hole: the `IMAGE_PROCESSOR` token. Part 41 fills it. Part 42 consumes the resulting projection from the browser.

## Implemented Work

- **`ImageProcessingService`** (`apps/api/src/attachments/image-processing.service.ts`) — the Sharp-backed `ImageProcessor`. Bound in `attachments.module.ts` as `{ provide: IMAGE_PROCESSOR, useExisting: ImageProcessingService }`. **`AttachmentsService` was not restructured**: the only widening was `ImageProcessor.maximumInputBytes`, so the operator-configured ceiling reaches the multipart parser.
- **Ordering is the security property.** Every `process()` call runs: (1) format-specific admission (SVG prescan, or HEIC byte cap + decode), (2) `.metadata()` — header parse only, **no pixel work**, (3) the explicit pixel/frame budget check, (4) only then is a decoder allowed to touch pixels. One `sharp()` factory (`open()`) constructs every instance with `limitInputPixels`, `sequentialRead: true`, `failOn: "warning"`, and `unlimited: false`, so no rendition can be built with weaker limits than another.
- **Variants.** `original` = the uploaded bytes verbatim under the sniffed type, retained for retention and reprocessing and **not addressable** through the `?variant=` enum. `full` = a metadata-stripped re-encode bounded to a 2000 px longest edge, in the **source family** (animated GIF stays animated GIF, animated WebP stays animated WebP, alpha PNG stays PNG, rasterized SVG becomes PNG, everything else becomes JPEG q82). `medium` = 800 px wide WebP q80. `thumbnail` = 200 px wide WebP q70. `blur` = a 16 px WebP as a `data:` URI in the jsonb variant record, hard-bounded at 2048 bytes.
- **Dimensions come from the encoder, not from arithmetic.** `image-variants.ts` holds the dependency-free bound arithmetic (`fitInside`, `boundLongestEdge`, `animatedTargetWidth`, `needsResize`) and decides *whether* and *roughly how far* to resize, but the persisted `width`/`height` are Sharp's own `info.*` after encoding, because libvips does not use one rounding rule (a JPEG source may shrink-on-load inside libjpeg first). The stored dimensions therefore cannot disagree with the stored bytes.
- **Metadata stripping by omission.** `keepMetadata`/`keepExif`/`keepIccProfile` are never called, so EXIF, GPS, XMP, IPTC, and ICC are dropped from every derived rendition by Sharp's default. `.rotate()` with no argument runs **before** `.resize()` on still images, so EXIF orientation is baked into the pixels before the tag describing it is discarded — without that, stripping metadata would silently rotate every phone photo.
- **SVG prescan** (`svg-safety.ts`) — refuses `<script`, `<foreignObject`, inline event-handler attributes (`onload=` and friends), `<!ENTITY` and any DOCTYPE internal subset, and every `href`/`xlink:href` that is not a document fragment or an inline PNG/JPEG data URI (an allow-list, so `file:`, relative paths, and unforeseen schemes are all covered). Every pattern is linear — no nested quantifier, no alternation inside a repetition, no backreference — and the `href` scan is bounded to 512 matches, because a prescan that can be made to backtrack *is* the denial of service it was added to prevent.
- **HEIC decoder seam** (`heic-decoder.ts`) — the single import site for `heic-convert`, with its own byte cap checked *before* entry and a `Promise.race` wall-clock timeout. `setHeicConverter`/`resetHeicConverter` are the test seam; `isHeicDecoderAvailable()` is what makes `supports("image/heic")` false in a build without the decoder, so such an upload returns 415 **before any row exists**.
- **Configuration** (`apps/api/src/config/image-processing.config.ts`) — seven variables, every one defaulted, so `env:validate --production` passes with none set. Registered in **both** `config.module.ts` and `validate-api-environment.ts` (following `security.config.ts`; `retention.config.ts` is registered in only one and was deliberately not copied). `environment-contract.test.ts` asserts the defaults and `configs.every(Object.isFrozen)`.
- **Failure vocabulary** — three codes added to `ATTACHMENT_PROCESSING_ERRORS`: `too_many_frames`, `heic_too_large`, `processing_timeout`. Each names a distinct operator-visible budget, so a dashboard can tell "someone uploaded a 500-frame GIF" apart from "someone uploaded a decompression bomb" and knows which ceiling to tune. All codes remain short, stable, `[a-z_]`-only strings; no raw message, object key, or byte of content is ever persisted or logged.
- **Shared contract** — `AttachmentVariantProjection` (key-free), `AttachmentBlurPlaceholder`, and `AttachmentVariantSet` in `@notted/shared-types`; `MAX_BLUR_DATA_URI_BYTES` and the bounded blur schema in `@notted/shared-validators`. The 2048-byte bound is asserted in three places: the shared Zod schema, `image-variants.ts`, and the point of generation.
- **Test fixtures are generated, never committed** (`apps/api/test/image-fixtures.ts`) — every raster fixture is built by Sharp from a deterministic non-uniform raw RGB(A) buffer, so the suite carries no opaque blob a reviewer cannot read, nothing to keep in sync with Git LFS, and no licence question about a sample photograph. It also builds the ~90-byte decompression bomb (a real PNG with a correct CRC whose IHDR declares 65535×65535), a truncated JPEG, seven hostile SVGs, a pathological-backtracking SVG, and a hand-built ISO-BMFF `ftyp` box.

## Important Decisions

1. **`full` is a bounded re-encode, not the literal original — a recorded refinement of `Notted.md`.** `Notted.md` specifies thumbnail 200 / medium 800 / full "original". The 200 and 800 are honoured exactly. `full` is refined because a literal original ships EXIF/GPS to every viewer and lets a 60 MP photograph be `<img>`-ed directly. The true uploaded bytes are still kept as `original`, which is **not** reachable through the `?variant=` enum, so the refinement costs nothing at the wire and loses nothing on disk.
2. **Animated GIF/WebP: motion is preserved in `full` only. This is the deliberate trade-off `Plan.md` asks for.** `full` re-encodes every frame with the loop count. `medium` and `thumbnail` are **first-frame static WebP posters**. Resizing an animation to 200 px does not make it small — every frame is still encoded, and an animated 200 px WebP routinely exceeds the still `medium` beside it — and nobody scrubs a thumbnail. A static poster is also what makes `prefers-reduced-motion` implementable later without re-processing.
3. **SVG is rasterized, not sanitized-and-served.** ADR 0005 permits either. Rasterizing needs **no new dependency** (librsvg is already inside the libvips Sharp ships), avoids dragging `dompurify` + `jsdom` into the API for a DOM allow-list, and removes an entire bypass class (mXSS, namespace confusion, mutation on re-serialization) instead of subscribing to a permanent CVE treadmill. `mime_type` still records `image/svg+xml`, but **every servable variant is png/webp**, so the Part 40 download route can never emit `image/svg+xml` and no browser ever parses attacker XML. **Deliberate loss:** vector scalability — a rasterized logo will not stay crisp when scaled past its `full` rendition. Sanitize-and-serve can be revisited in Part 44 if that becomes a real complaint.
4. **The prescan is defence in depth, not the control.** Rasterization is the control. The prescan exists to refuse the classes that hurt the **server** rather than the browser: SSRF and local-file reads through external references (librsvg will fetch an `<image href="http://169.254.169.254/…">`), entity expansion, and `<foreignObject>`.
5. **HEIC needs a JavaScript decoder because Sharp genuinely cannot decode it here.** The installed `sharp@0.35.0` bundles prebuilt libvips 8.18.3, which reports `format.heif.input.fileSuffix === [".avif"]`; HEIC would require a globally installed libvips built with libheif/libde265/x265, which the container does not ship. `Notted.md` requires "HEIC (convert to JPEG)", so `heic-convert@2.1.0` decodes to JPEG first and the JPEG then travels the ordinary pipeline. **Licence flag needing explicit human sign-off:** the chain reaches `libheif-js@1.19.8`, which is **LGPL-3.0**. The API is server-side and not distributed, and the package is separately replaceable rather than statically linked, so the relinking obligation is satisfied structurally — but this is a judgement, not a fact, and it is the one item in this part a human should confirm. Recorded in ADR 0008.
6. **`sharp` is pinned to `0.35.0`, not `Notted.md`'s `0.33.x`, and `Notted.md` was NOT edited.** `sharp@0.35.0` was already in this tree as the reviewed `next@16.2.11 > sharp` advisory override. Pinning `apps/api` to `0.33.x` would put **two sharp majors — two copies of the prebuilt libvips native binary — in one pnpm store**, doubling the native ABI surface and the image-decoder CVE exposure and creating two things to patch per advisory. Part 41 therefore promotes the version already present rather than adding a second. `Notted.md` is the product brief and is never edited to match an implementation; ADR 0008 is the designated place for a compatibility deviation, exactly as it already records Drizzle `0.30.x` → `0.45.2`. **The override and the direct pin must move together.**
7. **The blur placeholder is a data URI in metadata, not an object and not a blurhash.** It rides along with the metadata the editor already fetches on note load, so painting a placeholder costs zero extra HTTP round trips, zero extra authorization checks, and no client-side decoder. It is hard-bounded at 2048 bytes, and **if the bound is exceeded the placeholder is dropped and the upload still succeeds** — a decorative blur must never be able to fail an upload, nor inject a megabyte string into every `AttachmentSummary` in a note's listing.
8. **The blur data URI structurally cannot enter the note document — Part 42 depends on this.** `sanitizeDocumentUrl` in `packages/shared-validators/src/document.schema.ts` rejects `data:` URLs, and the Part 42 image node contract is `{ attachmentId, alt, width, height }` with **no `src` attribute at all**. There is no attribute in the contract that could hold a blob or base64 URL. That is how `Plan.md`'s Part 42 clause "the saved document never relies on temporary blob/base64 URLs" is satisfied **structurally rather than by convention**, and it is why that clause needs no runtime check.
9. **`.metadata()` before pixel work is the decompression-bomb gate.** `metadata()` parses the header only, so the declared geometry is judged before a decoder is entered. Both bounds are applied: one frame must fit, **and** `width × height × pages` must fit — a 2000×2000 frame is fine, four hundred of them are not. `limitInputPixels` is set as libvips' own backstop behind the explicit check, and if libvips refuses first, its "pixel limit" phrasing is mapped to `too_many_pixels` with a degrade to `decode_failed` should that phrasing ever change.
10. **APNG is treated as a static PNG.** Sharp only opens PNG as animated with explicit handling that libvips' PNG loader does not offer through the same path as GIF/WebP; `ANIMATION_CAPABLE` therefore contains only `image/gif` and `image/webp`. An APNG is ingested and served as its first frame. This is a knowingly accepted limitation, not an oversight.
11. **Three separate wall-clock bounds, because libvips work cannot be cancelled.** The pipeline timeout, the HEIC decode timeout, and the byte/pixel/frame caps are not redundant: a timeout bounds the **request**, not the CPU — the orphaned encode runs to completion in the background and its result is discarded. That is only acceptable *because* the byte, pixel, and frame caps already bound how much work can ever be started. A killable worker process is **Part 50**.
12. **`PassthroughImageProcessor` was kept and is no longer a Nest provider.** The service and tenant-isolation unit suites inject it directly so that tests about authorization, tenancy, quota, and transaction ordering do not pull a native decoder into scope. Removing it would have made those suites depend on Sharp for no benefit.
13. **The Part 41 integration suite is a new file, not an addition to `attachments.integration.test.ts`.** That file's two suites are Part 40's, gated on PostgreSQL *or* MinIO and parameterised over an in-memory store. Part 41's byte-plane assertions need a live PostgreSQL **and** a live MinIO simultaneously — a strictly narrower gate that would have forced the wrong skip semantics onto the existing suites. `test/image-fixtures.ts` already named the new path.

## Files and Components

| Path | Purpose |
|---|---|
| `apps/api/src/attachments/image-processing.service.ts` | The Sharp-backed `ImageProcessor`: admission → `.metadata()` → budget → pixels; builds `original`/`full`/`medium`/`thumbnail` + `blur`. |
| `apps/api/src/attachments/image-processing.service.test.ts` | The format matrix, animation behaviour, EXIF/GPS stripping, blur bound, SVG rasterization, HEIC routing via a stubbed decoder, and hostile input. |
| `apps/api/src/attachments/image-variants.ts` | Dependency-free variant vocabulary, quality constants, fit arithmetic, blur data-URI construction and its 2048-byte bound. |
| `apps/api/src/attachments/image-variants.test.ts` | Fit/never-enlarge/extreme-ratio arithmetic and the blur budget, with no decoder involved. |
| `apps/api/src/attachments/svg-safety.ts` | Linear-time SVG prescan: script/foreignObject/entity/DOCTYPE-subset gates and an href allow-list. |
| `apps/api/src/attachments/svg-safety.test.ts` | Each hostile class, the allow-list edge cases, the byte cap, regex statelessness, and a pathological-input wall-clock budget. |
| `apps/api/src/attachments/heic-decoder.ts` | The single `heic-convert` import site, with byte cap, `Promise.race` timeout, message suppression, and the availability probe. |
| `apps/api/src/attachments/heic-decoder.test.ts` | Routing, decoder-unavailable 415 path, pre-entry byte cap, hung-decoder timeout, message-leak suppression. |
| `apps/api/src/attachments/image-processing.ts` | Part 40's seam, updated in comments only: `IMAGE_PROCESSOR`, `ImageProcessor`, `ImageProcessingError`, retained `PassthroughImageProcessor`. |
| `apps/api/src/attachments/attachments.constants.ts` | Three new short, stable `processing_error` codes. |
| `apps/api/src/attachments/attachments.module.ts` | Binds `IMAGE_PROCESSOR` to `ImageProcessingService`. |
| `apps/api/src/config/image-processing.config.ts` | Seven fully defaulted resource budgets, frozen, with the generic upload ceiling able only to lower the image ceiling. |
| `apps/api/src/config/config.module.ts`, `validate-api-environment.ts` | Register the image config in **both** places. |
| `apps/api/src/config/environment-contract.test.ts` | Default values, bound rejections, ceiling interaction, and the frozen-config invariant. |
| `apps/api/src/database/schema/attachments.ts` | `AttachmentVariantObject` / `AttachmentPreviewObject` / `AttachmentVariantRecord` and `variants.$type<AttachmentVariantRecord>()`. Compile-time only. |
| `apps/api/test/image-fixtures.ts` | Test-time fixture generator for every raster format, the hostile SVG set, the decompression bomb, the truncated JPEG, and the HEIC `ftyp` box. |
| `apps/api/test/attachments-image-processing.integration.test.ts` | **New in the finishing session.** Live-PostgreSQL + live-MinIO byte-plane suite: every variant exists at its recorded key with its recorded byte length, deletion removes them all, an injected failure on the third put leaves the row `failed` with the earlier objects reclaimed, and an env-gated real-HEIC round trip. |
| `packages/shared-types/src/attachment.ts`, `packages/shared-validators/src/attachment.schema.ts` | Key-free variant projection, bounded blur placeholder, and the shared MIME/size ceilings. |
| `apps/api/package.json` | Exact pins `sharp@0.35.0`, `heic-convert@2.1.0`, `@types/heic-convert@2.1.1`. |
| `docs/decisions/0008-runtime-and-package-compatibility.md` | New `sharp` and `heic-convert` matrix rows, the `Notted.md` `0.33.x` reconciliation, the LGPL flag, the Part 41 dependency review, and the "deliberately not added" list. |

## Database and Data Changes

**No migration.** `attachments.variants` gained `.$type<AttachmentVariantRecord>()`, which is a **compile-time Drizzle annotation only**: it emits no DDL, does not change the column (`jsonb` with `default '{}'::jsonb`), and does not enter the drizzle-kit snapshot. The reviewer's confirmation is that `pnpm db:generate` produces **zero new files** under `apps/api/src/database/migrations/` and leaves `meta/_journal.json` and the latest snapshot unchanged. `0004_outgoing_catseye.sql`, which created the table, is untouched — deployed migrations are immutable.

No backfill and no retention change. Rows written before this part keep `variants = {}`, `width = null`, `height = null`; the wire projection already treats those as "not yet extracted" and the `ATTACHMENT_VARIANT_FALLBACKS` table already degrades to `original` for them.

## API, Configuration, and Operational Changes

**No route, path, method, or response-shape change.** Part 40's REST surface is unchanged; the same endpoints now return populated `variants` and non-null `width`/`height`, and SVG/HEIC uploads that previously returned 415 now succeed.

Seven new environment variables, **all optional and all safely defaulted**:

| Variable | Default | Bounds | Purpose |
|---|---|---|---|
| `MAX_IMAGE_UPLOAD_BYTES` | 15 MiB (or `MAX_UPLOAD_SIZE_BYTES` if lower) | 64 KiB – the generic ceiling | Per-image byte ceiling handed to the multipart parser, so an oversize upload is refused with a clean 413 before bytes are buffered. |
| `MAX_IMAGE_PIXELS` | 50,000,000 | 1,000,000 – 250,000,000 | `width × height × pages` budget. The decompression-bomb gate. |
| `MAX_IMAGE_ANIMATION_FRAMES` | 400 | 1 – 10,000 | Frame ceiling for animated GIF/WebP. |
| `IMAGE_PROCESSING_TIMEOUT_MS` | 20,000 | 1,000 – 120,000 | Wall-clock budget for one upload's whole variant pipeline. |
| `MAX_SVG_SOURCE_BYTES` | 2 MiB | 4 KiB – 16 MiB | Checked on the raw buffer *before* the prescan scans anything. |
| `MAX_HEIC_UPLOAD_BYTES` | 8 MiB | 64 KiB – 64 MiB | Deliberately below the image ceiling: the decoder is JS/WASM and cannot be interrupted. |
| `HEIC_DECODE_TIMEOUT_MS` | 10,000 | 1,000 – 60,000 | Wall-clock budget for the HEIC decode step alone. |

The generic `MAX_UPLOAD_SIZE_BYTES` can only **lower** the image ceiling, never raise it, and the floor is clamped alongside it so an operator who lowered the transport ceiling below 64 KiB is not told the range is empty. Defaults are appropriate for both development and production; an operator only ever tightens them.

Operationally, `sharp` adds a prebuilt native binary to the API image (no compiler needed at install) and `heic-convert` is pure JS/WASM. Both increase per-request CPU and RSS during an upload, which is the reason every budget above exists and the reason Part 50 moves this to a worker.

## Security and Tenant-Isolation Notes

- **No authorization or tenant-scope code was touched.** This part is a pure implementation of a seam that `AttachmentsService` calls *inside* `authorizationEntry.run`, after `file.upload` has been authorized against the target note. No file under `src/authorization/` or `src/tenant/` was modified. Cross-tenant behaviour is therefore unchanged and remains covered by the Part 40 suites.
- **Part 40's failure ordering is preserved exactly.** On failure the `failed` status and the failure audit **commit first**, and only then are already-written objects best-effort removed. That ordering is a correctness property with its own test and was not reordered.
- **`supports()` is still consulted before any row is created**, so an unsupported format returns 415 without leaving a `failed` row. HEIC is reported unsupported when the decoder did not load, so a build without it refuses up front rather than accepting the upload and failing during processing.
- **Untrusted bytes reach two decoders (libvips and libheif).** Every entry is bounded first: a byte cap, then a header-only `.metadata()`, then an explicit pixel and frame budget, then a wall-clock race. `failOn: "warning"` is Sharp's strictest setting and refuses truncated or structurally damaged input rather than emitting a half-grey image.
- **SSRF and XXE are refused before librsvg sees the bytes** — external `<image href>`, `<use href>`, `file:` and relative `xlink:href`, `<!ENTITY`, and DOCTYPE internal subsets. The reference policy is an allow-list, not a scheme blocklist, so it has no gap for a scheme nobody thought of.
- **No servable variant can be `image/svg+xml`.** A `ready` SVG row always carries a png `full` plus webp `medium`/`thumbnail`, because `process()` either produces all three or throws — and a row that threw is `failed`, which `readContent` rejects with 404 before consulting the variant table at all. Combined with the download route's inline-safe raster allow-list, that is two independent reasons the browser never parses attacker XML.
- **Nothing sensitive is persisted or logged.** `processing_error` holds only short `[a-z_]` codes; decoder messages (which can quote file structure and paths) are discarded at the seam, with a test asserting a path in a decoder message does not survive. No object key, signed URL, filename, or byte of content enters a log line.
- **The wire projection still strips `variants[*].key`**, and the blur placeholder carries no key. The integration suite asserts the serialized upload result contains neither `"key"` nor the test key prefix.

### What Part 42 receives

`GET /api/v1/workspaces/:workspaceId/notes/:noteId/attachments` returns, per attachment: `width`/`height`/`bytes`/`mimeType` for each of `original`, `full`, `medium`, `thumbnail`, plus `blur: { dataUri, width, height }`, plus `contentPath`. **No object key, bucket name, storage endpoint, or signed URL is present anywhere in the shape** — `toMedia()` in `attachments.service.ts` is the single place the key is dropped. That is exactly what Part 42 needs to reserve layout space and paint a blur-up placeholder, and it is confirmed by assertion in the new integration suite.

## Verification Evidence

Every gate below was **executed**, one at a time. Results are recorded as observed.

| Check | Result | Notes |
|---|---|---|
| `pnpm lint` | Pass | Three `import-x/order` errors in `image-processing.service.test.ts` were real and are fixed (autofixed to the config's own canonical ordering). |
| `pnpm format:check` | Pass | |
| `pnpm type-check` | Pass | Two real defects were found and fixed: `sharp`'s `GifOptions` has **no `reoptimise` key** (see below), and a `.catch()` widened an awaited union so `.code` existed on neither arm. |
| `pnpm test` | Pass | api 728 passed / 61 skipped on the host. |
| API coverage with live infrastructure | Pass | `src/attachments` **94.16 stmts / 87.17 branch / 94.65 funcs / 96.26 lines**; global 78.79/73.11/80.44/80.42, all above the 70 % thresholds. |
| `pnpm build` | Pass | |
| `pnpm db:generate` (must produce zero new files) | Pass | Zero files written — confirms the `.$type<AttachmentVariantRecord>()` claim is compile-time only. `pnpm db:check` also passes. |
| PostgreSQL + MinIO gated suite (`attachments-image-processing.integration.test.ts`) | Pass | 3 tests, 1 skipped (HEIC). Run with `docker compose exec api pnpm --filter @notted/api test`. |
| Real HEIC round trip | Not run, and not runnable in CI | Unchanged: requires `NOTTED_TEST_HEIC_FIXTURE` pointing at a real `.heic`. Sharp cannot generate one (no HEVC encoder) and a sample is patent-encumbered. The test skips with that exact message. **Manual verification only.** |
| `pnpm audit --prod --audit-level=high` | Pass | 3 moderate, all pre-existing. |
| `libheif-js` LGPL-3.0 sign-off | **Still not obtained** | Needs a human decision, not a command. See Important Decision 5. Verified as the first copyleft dependency in the tree; deliberately not decided, removed, or silenced by any agent. |

### Two real defects the gates caught, and what they mean

1. **`sharp`'s `GifOptions` has no `reoptimise` key.** `applyEncoder` called
   `pipeline.gif({ reoptimise: true })`. Checked against the installed typings
   (`sharp@0.35.0/lib/index.d.ts:1456-1475`), the interface offers `reuse`,
   `progressive`, `colours`/`colors`, `effort`, `dither`, `interFrameMaxError`,
   `interPaletteMaxError`, and `keepDuplicateFrames` — and nothing else. The
   intent ("rebuild the global palette after a resize") is expressed by
   **`reuse: false`**, since the default `reuse: true` keeps the source palette,
   which is the wrong one once the frames have been resampled. This single
   defect failed `type-check`, failed `pnpm build`, and had left the API dev
   container in a restart loop, which is why nothing was listening on 3000/3001.

2. **The "removes GPS" assertion was vacuous.** `test/image-fixtures.ts` built
   its EXIF fixture with a `GPS` key, but sharp's `Exif` interface exposes only
   `IFD0`–`IFD3` — **libvips' GPS IFD is `IFD3`**. Measured on the installed
   sharp by walking the written TIFF IFDs: the `GPS` key produces 238 EXIF bytes
   with **no** GPS IFD pointer and no GPS tags, while the `IFD3` key produces 316
   bytes carrying pointer tag `0x8825` plus GPS tags `0x1`/`0x2`/`0x3`. The
   fixture therefore carried no GPS at all, so the test named *"removes EXIF,
   GPS, and ICC from every derived rendition"* proved nothing about GPS. Renamed
   to `IFD3`, which makes the security claim real. It was deliberately **not**
   deleted or cast away — either would have compiled while leaving a permanently
   vacuous claim.

### Two further prescan gaps closed in the final pass

- **`ROOT_ELEMENT` had not received the namespace-prefix treatment** the script
  and `foreignObject` gates got, so a legitimate `<svg:svg xmlns:svg="…">` was
  refused as `not_svg`. Fail-closed rather than a hole, but inconsistent with
  what the file claims. Now prefixed like the others, with a test asserting the
  prefixed root is accepted.
- **Inline event handlers (`<svg onload="…">`) were not refused at all.** Inert
  on this path — librsvg rasterizes and never executes script, and no variant is
  served as `image/svg+xml` — so this is not a vulnerability. It is refused
  anyway, under a new `event_handler` reason, so the scan's answer does not
  depend on *both* of those facts staying true, and so this file cannot later be
  quietly repurposed as a "safe to serve as SVG" gate, which it is not. The
  probe is bounded (`/\son[a-z]{1,20}\s*=/iu`) like every other pattern here.

### SVG prescan now covers namespace-prefixed elements

`scanSvgSource`'s element gates matched only the unprefixed spellings, so
`<svg:script>` and `<s:foreignObject>` slipped past a scan that claimed to cover
them. Not a vulnerability — the control is rasterization and librsvg never
executes script — but the file's stated coverage was wider than its behaviour.
Both gates now accept an optional bounded prefix
(`(?:[a-z0-9_-]{1,32}:)?`, quantifier bounded so the scan still cannot be made to
backtrack), and `HOSTILE_SVGS` gained a `prefixedScript` and a
`prefixedForeignObject` fixture. Because
`image-processing.service.test.ts` drives `it.each(Object.entries(HOSTILE_SVGS))`,
both new fixtures automatically extend the processor's rejection matrix too.

Facts that **were** verified in the finishing session, by reading installed manifests out of the pnpm store: `sharp@0.35.0` is Apache-2.0, `"type": "commonjs"`, `main: "./dist/index.cjs"`; `heic-convert@2.1.0` is ISC with `main: "index.js"`, no `type` field and no exports map (so it is CommonJS-loadable, unlike `file-type`); the transitive chain resolves to `heic-decode@2.1.0` (ISC) → `libheif-js@1.19.8` (**LGPL-3.0**), `jpeg-js@0.4.4` (BSD-3-Clause), `pngjs@6.0.0` (MIT).

Facts that **were** verified in the finishing session, by reading installed manifests out of the pnpm store: `sharp@0.35.0` is Apache-2.0, `"type": "commonjs"`, `main: "./dist/index.cjs"`; `heic-convert@2.1.0` is ISC with `main: "index.js"`, no `type` field and no exports map (so it is CommonJS-loadable, unlike `file-type`); the transitive chain resolves to `heic-decode@2.1.0` (ISC) → `libheif-js@1.19.8` (**LGPL-3.0**), `jpeg-js@0.4.4` (BSD-3-Clause), `pngjs@6.0.0` (MIT).

### Unit-test coverage of `Plan.md`'s Verify clause

"Fixture images for every supported format produce expected variants and decompression-bomb/invalid files are rejected within resource limits." Each clause maps to a written (**unexecuted**) assertion:

| Requirement | Where |
|---|---|
| Exact variant set for every raster format | `image-processing.service.test.ts` — "emits exactly original + full + medium + thumbnail for every raster format", over all seven generated fixtures |
| Source-family preservation (alpha PNG, WebP, GIF, JPEG) | same file — "keeps the source family for `full`" |
| Dimension bounds 2000 / 800 / 200 and ratio preservation; never enlarges | same file — two dedicated cases |
| Animated GIF: `full` has `pages > 1`, `medium`/`thumbnail` have `pages === 1` | same file — "keeps every frame in `full` and renders a STATIC first frame"; repeated for animated WebP |
| Frame budget and per-animation pixel budget | same file — two cases against lowered config |
| EXIF **including GPS** absent from every derived rendition | same file — asserts the fixture *has* EXIF first, then that `exif`/`icc`/`xmp` are gone and the literal `Exif` marker is absent |
| Blur is `data:image/webp;base64,` and **under 2048 bytes** | same file — asserted for every raster fixture; bound also unit-tested in `image-variants.test.ts` |
| SVG produces **no** `image/svg+xml` variant | same file — every servable variant asserted png/webp and explicitly `not.toBe("image/svg+xml")` |
| Decompression bomb rejected from the header within a wall-clock budget | same file — ~90-byte bomb, `too_many_pixels`, asserted under a 2 s budget |
| Truncated JPEG rejected by `failOn: "warning"` | same file — `decode_failed` under the same budget |
| Every hostile SVG class (`<script`, `<foreignObject`, external `<use href>`, non-`data:` `xlink:href`, remote `<image href>`, `<!ENTITY`) | `svg-safety.test.ts` per-class, plus an end-to-end `unsafe_svg` case per class in `image-processing.service.test.ts` |
| HEIC | three ways, none needing a sample: stubbed-decoder routing (`image-processing.service.test.ts`, `heic-decoder.test.ts`), hand-built `ftyp` signature (`image-signature.test.ts`), and the env-gated integration round trip |

## Known Limitations and Follow-up Work

- **All suites now execute and pass.** The exact-dimension assertions (libvips rounding) and the MinIO `stat.contentType` assertions the previous record flagged as most likely wrong turned out to be correct as written.
- **`libheif-js` is LGPL-3.0 and needs a human sign-off.** If it is refused, deleting `heic-decoder.ts` and the two package pins removes HEIC support cleanly: `supports()` already returns 415 up front and no other file references the decoder.
- **A real HEIC decode has never been executed.** Only the routing, cap, timeout, and unavailable paths are covered. Set `NOTTED_TEST_HEIC_FIXTURE` to verify manually.
- **APNG is served as a static first frame** (Important Decision 10).
- **SVG loses vector scalability** (Important Decision 3). Revisit in Part 44 if it becomes a real complaint.
- **Processing is synchronous inside the request** and every timeout bounds the request rather than the CPU — an orphaned libvips encode runs to completion in the background. **Part 50** moves this to a worker with a killable process; the state transitions and compensation already exist so that is a transport change.
- **`ATTACHMENT_VARIANT_FALLBACKS.full` still degrades to `original`.** For a Part 41-processed row this is unreachable (a `ready` row always has `full`, and a non-`ready` row 404s before the table is consulted), but it is the one path by which a future change could make the download route offer an `original`. A reviewer may reasonably want `original` removed from the `full` fallback chain now that derived renditions always exist; it was left alone because it is Part 40 code and changing it is not needed for correctness today.
- **No `prefers-reduced-motion` handling.** `full` animates unconditionally. The static posters exist, so Part 43 can implement it with no re-processing.
- Orphan reconciliation remains **Part 45**; generic files and the `preview` variant remain **Part 44**.

## Handoff Notes

- **Part 42 (next):** the wire contract is final. Read `variants[name].width/height` to reserve layout space and `variants.blur.dataUri` to paint the placeholder; build every request from `ATTACHMENT_API_PATHS`. The image node is `{ attachmentId, alt, width, height }` with **no `src`** — do not add one, and do not put a `blob:`/`data:` URL anywhere in the document, because `sanitizeDocumentUrl` will reject it and that rejection is what makes `Plan.md`'s Part 42 Verify clause structurally true. Pre-flight against `MAX_IMAGE_UPLOAD_BYTES` and `ATTACHMENT_IMAGE_MIME_TYPES` from `@notted/shared-validators`. Part 40's `Cross-Origin-Resource-Policy: same-site` header still needs a real-Chromium `<img>` confirmation — jsdom cannot prove it.
- **Changing a resource budget** means editing `image-processing.config.ts` only; the service reads all seven through the injected config, and `environment-contract.test.ts` will fail if a default or bound drifts.
- **Adding a format** means: a signature in `image-signature.ts`, an extension in `attachment-storage-key.ts`, a member of `SUPPORTED_TYPES`, a `fullFormat()` branch, and a fixture in `test/image-fixtures.ts`. Do not add a format whose derived variants are not jpeg/png/gif/webp — the download route refuses to stream anything else.
- **Do not remove `PassthroughImageProcessor`.** The service and tenant-isolation unit suites inject it precisely so they do not need a native decoder.
- **Do not reorder the failure path.** `failed` + audit commit *before* object removal. That is a correctness property with its own test.
- **The `sharp` direct pin and the `next > sharp` override must change together** (ADR 0008), or the tree gets two libvips binaries.
- The new integration suite writes only under `test/{uuid}/` via `PrefixedObjectStore` and removes that prefix in `afterEach`; the database side rolls back through a thrown sentinel. Run it with `docker compose exec api pnpm test` — the api container has `MINIO_ENDPOINT: minio` and `DATABASE_URL` set.
- Do not edit `apps/api/src/database/migrations/0004_outgoing_catseye.sql` or any deployed migration. Do not edit `Notted.md`.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-06 | backend-platform-engineer agent | Initial record. Implementation (pipeline, SVG prescan, HEIC seam, config, unit suites) written in a first session that was cut off before documentation; audited and finished in a second session, which added the PostgreSQL + MinIO integration suite and the ADR 0008 rows. All verification remains deferred to the review pass. |
| 2026-08-07 | Parts 40–42 fix pass | All gates executed and recorded with observed results. Fixed the `sharp` `reoptimise` → `reuse: false` defect (the root cause of the failing build and the API restart loop), corrected the EXIF fixture's `GPS` key to `IFD3` so the GPS-stripping assertion is no longer vacuous, and widened the SVG element gates to namespace-prefixed spellings with fixtures for each. `libheif-js` LGPL-3.0 remains open for human sign-off. |
