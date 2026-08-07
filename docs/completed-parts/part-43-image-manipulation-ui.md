# Part 43 — Add image manipulation UI

## Status

- **State:** Complete
- **Completed on:** 2026-08-08
- **Implemented by:** frontend-editor-engineer agent (implementation), then two independent review rounds, a fix pass, and a lead pass that fixed the roving-toolbar defect and the two mis-authored e2e journeys
- **Plan reference:** `Plan.md`, Part 43
- **Related records:** `part-42-editor-image-insertion.md` (the node, the decoration-based placeholders, the alt-text carry-forward this part closes, and the "never divide by the zoom scale" finding), `part-41-image-ingestion-processing.md` (the `full`/`medium`/`thumbnail` renditions and the static first-frame posters this part uses for reduced motion), `part-40-secure-object-storage.md` (the proxied content endpoint), `part-37-page-container.md` (`--notted-page-content-width`, the token the clamp reads), `part-38-page-breaks-focus-print.md` (`data-notted-print-hide` / `data-notted-focus-hide`, and `print.css` standing alone for Part 63), `part-39-note-autosave.md` (the single save call site this part does not add to), `part-33-tiptap-document-contract.md` (the contract widened here). ADRs 0001, 0005.

## Objective

Give an author the manipulations `Notted.md` §3 specifies for an embedded image — resize by dragging a corner (ratio locked, Shift for freeform), a caption, alternative text, alignment, full width, and text wrap — with every one of them reachable from the keyboard, clamped to the printable page, persisted, and rendered identically on screen, on paper, and in export.

Part 42 could put an image into a note and read its bytes back. It could not change anything about it, and it left one accessibility gap open by design: alt text came from the uploaded filename and there was no editor for it. Part 43 closes that gap and turns a fixed picture into a laid-out figure.

## Implemented Work

### Contract (additive, `packages/shared-validators/src/document.schema.ts`)

Four attributes added to the `image` node, all optional on input with documented defaults, all present on output:

| Attribute | Type | Default | Meaning |
|---|---|---|---|
| `align` | `"left" \| "center" \| "right"` | `"center"` | Horizontal placement in the content column |
| `wrap` | `"block" \| "inline"` | `"block"` | `inline` floats the figure so text flows beside it |
| `fullWidth` | `boolean` | `false` | Span the whole printable column, ignoring `width` |
| `caption` | `string` | `""` | Visible `<figcaption>` text; `""` means no caption |

The single coordinated change touches every place the Part 42 record listed:

- `NOTE_DOCUMENT_LIMITS.maxImageCaption = 1_000`, bounded on its own because a caption is rendered visibly everywhere alt is not.
- `NoteDocumentImageAttrs` gains the four fields; `NOTE_DOCUMENT_IMAGE_ALIGNMENTS`, `NOTE_DOCUMENT_IMAGE_WRAP_MODES`, and the two defaults are exported enumerations.
- `noteDocumentImageAttrs()` accepts absent values as defaults and rejects present-but-invalid ones, so a Part 42 document reads unchanged and `align: "diagonal"` still degrades through recovery.
- `NODE_ALLOWED_ATTRS.image` grows from four keys to eight; the loop that rejects a fifth key is untouched, so the "no URL-shaped attribute" proof still holds and is re-asserted against the widened set.
- The `image` branch of `validateNodeAttrs` validates each addition and **deliberately accepts** `fullWidth: true` together with `wrap: "inline"`.
- `resolveNoteImageWrap()` is the single, exported place that conflict is resolved (`fullWidth` wins).
- `normalizeImageNode()` re-emits all eight attributes canonically, resolving the conflict and substituting defaults for unusable values.
- `renderImageHtml()` now emits `<figure class="notted-image-figure" data-align data-wrap data-full-width>` wrapping the unchanged `<img class="notted-image">`, plus an escaped `<figcaption class="notted-image-caption">` when there is a caption. Still no `src`, still only constants and escaped author text.
- `extractNoteContentPlain()` and `recoverTextFromNode()` contribute alt first and caption second, each omitted when empty.
- `NOTE_DOCUMENT_IMAGE_FIGURE_CLASS`, `NOTE_DOCUMENT_IMAGE_CAPTION_CLASS`, `resolveNoteImageWrap`, the two enumerations, the two defaults, and the two new types are exported through the barrel.

`NOTE_DOCUMENT_SCHEMA_VERSION` stays at `1` (Decision 2 below).

### Node view (`apps/web/src/components/editor/extensions/CustomImage.ts`)

Still plain DOM, still `ignoreMutation: () => true`, still subscribed to `AttachmentDirectory`. The DOM is now:

```
figure.notted-image-figure[contenteditable=false][draggable=true]
        [data-attachment-id][data-image-state][data-image-loaded][aria-busy]
        [data-align][data-wrap][data-full-width][data-image-editable]
        [data-image-sized][data-has-caption][data-image-resizing]
  ├ div.notted-image-frame                ← aspectRatio + blur background
  │   ├ img.notted-image                  ← loading/decoding as ATTRIBUTES
  │   ├ div.notted-image-fallback
  │   └ div.notted-image-handles[data-notted-print-hide][aria-hidden]
  │       └ span.notted-image-handle[data-image-handle=nw|ne|sw|se] × 4
  ├ figcaption.notted-image-caption[draggable=false]
  │   ├ input.notted-image-caption__input[data-notted-print-hide]
  │   └ span.notted-image-caption__text    ← what prints
  └ div.notted-image-status[role=status][aria-live=polite][data-notted-print-hide]
```

- **Resize handles** — four corners, pointer-events driven, visible only while the figure is `.ProseMirror-selectednode` and the note is editable. Live preview by direct style mutation; **one** `updateAttributes` on pointer-up, so a whole gesture is a single undo step and a single autosave candidate. Ratio locked by default, freeform while Shift is held, and Shift is sampled from every pointer move **and** from `keydown`/`keyup` so pressing it without moving re-previews immediately. Escape (capture phase) or `pointercancel` restores the pre-drag inline styles and commits nothing.
- **Clamping** — `measurePageContentWidth()` reads `--notted-page-content-width` off the nearest `.notted-page-paper` by giving a throwaway probe that width and reading `offsetWidth` back; the page arithmetic is never recomputed. `resolveImageResizeBounds()` combines it with `NOTE_DOCUMENT_LIMITS.maxImageDimension` and a 48 px minimum, and falls back to the contract bound when there is no paper or no layout.
- **Keyboard resize** — `Mod-Shift-ArrowRight` / `Mod-Shift-ArrowLeft` in `EDITOR_SHORTCUTS` under a new `images` group, registered by the extension's own `addKeyboardShortcuts()` reading `editorShortcutBinding()` (the `note-block-tab.ts` pattern). Both no-op unless a `NodeSelection` is on an image, so the browser keeps the key everywhere else. Same clamp, same single history step, and the new size is announced through the visually hidden `role="status"` line.
- **Caption** — a real `<input>` inside the `contenteditable=false` figure, labelled `Image caption`, placeholder `Add a caption`, `maxLength` from the contract. Commits on Enter, on blur, and on a 500 ms debounce; never per keystroke. Key and clipboard events are stopped at the field and the node view declares `stopEvent` for it, so ProseMirror never treats a caption keystroke as a document edit. The committed value is mirrored into a `<span>` because a text field's value does not print.
- **Reduced motion** — `reduced-motion.ts` holds one shared `MediaQueryList`; the node view paints `entry.sources.medium` (Part 41's static first-frame poster) instead of `full` when the reader prefers reduced motion, and repaints on preference change.
- Blur-up, `loading="lazy"`, and `decoding="async"` are unchanged, and `rescueDeletedPlaceholders`, the whole-document exception, and the absence of a decoration `destroy` hook were not touched.

### Chrome (React, portalled past the paper's transform)

- **`ImageToolbar.tsx`** — `role="toolbar"` with eight real `<button>`s (align left/center/right, break text, wrap text, full width, alt text, remove), each with an accessible name and `aria-pressed` where it is a state. Roving tab index via the existing `useRovingToolbar`. Rendered into `document.body` with `createPortal`, positioned `fixed` from the node's viewport rect. Escape dismisses it and returns focus to the editor; changing or clearing the selection unmounts it. Read-only notes never render it.
- **`useSelectedNode.ts`** — generic "is a `NodeSelection` on this node type, and where is it" hook with rect tracking on scroll and resize. Written generically for Part 44's attachment card.
- **`ImageAltTextDialog.tsx`** — modelled on `LinkDialog.tsx` with `useDialogFocusRestore`, bounded to `maxImageAlt`, with a live remaining-characters hint, a "Mark as decorative" action, and copy stating that empty alt is a valid choice. The candidate is validated by calling `noteDocumentImageAttrs` on the prospective attributes, so the dialog cannot drift from the contract.
- `TiptapEditor.tsx` renders `<ImageToolbar>` with the portal target it already resolves for the focus-mode toolbar. It gained no I/O and no `editorProps` change.

### Styling

- `apps/web/src/styles/globals.css` — the "belongs to Part 43 and deliberately absent" comment is replaced with the real rules: the sizing model (the **figure** carries the width; the frame is always `100%` of it), alignment by `margin-inline`, `inline` wrap by `float`, full width, handles, caption field, and the visually hidden status line.
- `apps/web/src/styles/print.css` — plain CSS, no Tailwind, no app-shell dependency. Alignment, wrap, full width, and the caption are re-stated so they hold when Part 63 loads the file standalone against `renderDocumentHtml` output. Handles and the status line are hidden; the caption prints from the `<span>`, and an empty caption slot is suppressed with `data-has-caption="false"`.

## Important Decisions

1. **`fullWidth` wins over `wrap: "inline"`, resolved at render time and written back only during recovery.** A full-width figure occupies the entire content column, so there is no room beside it for text to flow: an inline float can only be meaningless. The pair is nevertheless **stored verbatim and accepted by validation**. Rejecting it would let the editor produce a document `safeParseNoteDocument` refuses, and Part 39 records exactly what that costs — `onDocumentChange` stops firing and autosave goes silent for the whole session. Silently rewriting one of the two during validation would instead make a round trip lossy. `resolveNoteImageWrap()` is therefore the one place the rule lives, and it is called by `renderImageHtml`, by the node view (which writes the resolved value into `data-wrap`), and by `normalizeImageNode` (which is repairing a node anyway, so it stores the resolved form). The toolbar additionally writes both values in one transaction, so an author's own actions never produce the pair.

2. **`NOTE_DOCUMENT_SCHEMA_VERSION` stays at `1`, and `width`/`height` were not re-typed.** Adding an attribute with a documented default is additive: every document stored as v1 is still valid v1, an absent value reads as the default, and there is nothing to migrate. The one thing worth stating plainly is `width`/`height`: Part 42 described them as the *intrinsic* size, and Part 43 stores a *resized* size in the same two fields. That is not a re-typing and not a narrowing — the accepted values are unchanged, `null` is still allowed, and the Part 42 renderer already used them to size the box. No stored value changes meaning in a way that makes an old document render wrongly. The trigger for the first real bump (remove, narrow, or re-type) is unchanged and still recorded in the source.

3. **The editor's `renderHTML` stays a bare `<img>` with `data-*`; only the contract emits a `<figure>`.** They are two different projections. The extension's `renderHTML`/`parseHTML` pair is ProseMirror's clipboard serializer and has to read its own output back, and `parseHTML` is restricted to `img[data-attachment-id]` — the restriction that stops a pasted remote `<img>` entering a note. Emitting a figure there would mean copy-and-paste inside the editor silently lost alignment and captions, or that the parse rule had to widen. `renderImageHtml` is the projection for print, export, and any non-editor reader, and it is the one that produces semantic figure markup. A round-trip test pins the editor side.

4. **The resize converts the pointer delta by a *measured* scale factor, and this is not a contradiction of Part 42's Decision 7.** Part 42 found that `posAtCoords` compares `clientX` against `getBoundingClientRect()`, and that both are *already* in scaled viewport space, so dividing one of them is wrong. A resize is the other arrangement: the delta is in viewport space but the value being written is an inline `width`, which is a **layout** length the transform is applied to afterwards. The two sides are in different spaces, so the delta is converted exactly once, by `pointerScaleOf()` — the element's own rect divided by its own `offsetWidth`. It is measured rather than read from the zoom store so it is exactly `1` at 100 %, correct under any nesting of transforms, and unable to drift from what `PageContainer` is really doing. The drop handler's comment was extended to point at this distinction rather than being weakened.

5. **The width lives on the figure, not on the frame.** The frame is always `width: 100%` of the figure, so one inline value drives the image, the caption, and the alignment together — and alignment can then be plain `margin-inline`, which is meaningless without a definite width. Clearing the value hands sizing back to the stylesheet, which makes "full width" and "never resized" the same case. `data-image-sized` lets the stylesheet tell an author-chosen width apart from an unsized figure, which is what gives a floated figure a usable default width instead of collapsing.

6. **A stored width is clamped on READ, never rewritten.** A Part 42 image stores its intrinsic width, routinely far wider than the page. `displayImageWidth()` clamps it for painting so the figure stays inside the column; the document is only changed when an author actually resizes. A resize also *starts* from the measured width rather than the stored one, so grabbing a handle on a 4000 px image does not make it jump.

7. **The four handles are `aria-hidden` presentational spans, not buttons.** Four unlabelled tab stops per image would be noise for a keyboard user, and up to `maxImages` figures would be four hundred. WCAG 2.1.1 asks for an equivalent keyboard path, not for every pointer affordance to be focusable, and that path is the declared resize binding — which is registered in `keyboard-shortcuts.ts`, rendered in the help dialog, and covered by the exact-set shortcut suite.

8. **The handles carry `data-notted-print-hide` but deliberately not `data-notted-focus-hide`.** Focus mode hides *chrome that competes with writing*. The handles and the image toolbar appear only for an image the author has just selected, so hiding them would remove the ability to edit an image in focus mode rather than remove a distraction.

9. **The caption commits through a positional `setNodeMarkup`, not through `setNodeSelection` + `updateAttributes`.** Moving the editor selection makes ProseMirror sync the DOM selection, which blurs the input the author is typing into. `updateImageAt()` names its target by position instead; it is still one ordinary command in one transaction, in the undo stack, seen by `onUpdate` exactly like a typed character. Everything else (toolbar, keyboard resize, drag commit) uses `updateSelectedImage()`/`updateAttributes`, and nothing anywhere uses `addToHistory: false` — that remains the decoration-only behaviour Part 42 established.

10. **Reduced motion swaps the rendition rather than adding a control.** Part 41 already renders `medium` as a static first-frame poster and preserves animation only in `full`, so choosing `medium` stops an animated GIF at no processing cost and satisfies WCAG 2.2.2 without putting a play/pause button on every image. The cost is that a *still* image also drops to the 800 px rendition for those readers — see Known Limitations, where the narrower fix is recorded.

11. **No Radix dependency was added.** There is no `popover`, `tooltip`, `slider`, or `dropdown-menu` primitive in `components/ui`, and Part 42 declined to add one for a single widget. A `role="toolbar"` of native buttons with a roving tab index is the APG pattern anyway, and `useRovingToolbar` already implements it.

12. **`Mod-Shift-ArrowRight`/`Left` were chosen over `Mod-Alt-Arrow`.** On macOS, Chrome reserves `Cmd-Alt-Arrow` for tab switching and a page cannot reliably cancel it. `Mod-Shift-Arrow` is cancellable on both platforms, is unclaimed in `EDITOR_SHORTCUTS`, and is not bound by any configured extension through the keymap. Because the handler returns `false` unless an image is selected, the browser's own `Mod-Shift-Arrow` selection behaviour is untouched everywhere else.

13. **The alt-text dialog validates by calling the contract.** Rather than restating "bounded, no control characters", it builds the prospective attribute record and asks `noteDocumentImageAttrs` whether it parses. A second copy of the rules is a second thing to keep in step.

14. **The test harness gained `pressBinding` and arrow keys in `NAMED_KEYS`.** `userEvent.keyboard` performs focus bookkeeping between presses, jsdom emits a `selectionchange`, and ProseMirror reads it back — which collapses a programmatically placed `NodeSelection` before an image shortcut can ever run. That is the same failure `pressKey` was already documented for. The exact-set completeness assertion was **not** relaxed; a per-case `press` override was added instead.

## Files and Components

| Path | Purpose |
|---|---|
| `packages/shared-validators/src/document.schema.ts` | Four image attributes, the caption bound, the two enumerations, `resolveNoteImageWrap`, figure/caption rendering, plain-text projection, canonical normalization. |
| `packages/shared-validators/src/document.schema.test.ts` | Updated Part 42 expectations plus a new "Part 43 image manipulation contract" suite: round trip, boundaries, rejections, conflict resolution, rendering, projection. |
| `packages/shared-validators/src/index.ts` | Exports the new constants, types, and `resolveNoteImageWrap`. |
| `apps/web/src/components/editor/image-resize.ts` | **New.** Pure, DOM-free resize arithmetic: bounds, clamps, corner directions, ratio lock, Shift freeform, keyboard step, read-time display width. |
| `apps/web/src/components/editor/image-resize.test.ts` | **New.** Unit suite for all of the above. |
| `apps/web/src/components/editor/reduced-motion.ts` | **New.** One shared `prefers-reduced-motion` observer with a test seam. |
| `apps/web/src/components/editor/useSelectedNode.ts` | **New.** Generic `NodeSelection`-on-a-type tracker with viewport rect; reusable by Part 44. |
| `apps/web/src/components/editor/ImageToolbar.tsx` | **New.** Portalled floating toolbar: alignment, wrap, full width, alt text, remove. |
| `apps/web/src/components/editor/image-toolbar.test.tsx` | **New.** Toolbar and alt-dialog behaviour, states, and accessibility. |
| `apps/web/src/components/editor/ImageAltTextDialog.tsx` | **New.** Accessible alt-text editor that treats empty as a real choice. |
| `apps/web/src/components/editor/extensions/CustomImage.ts` | Layout attributes, figure/caption/handle/status DOM, resize gesture, caption field, keyboard resize command, reduced-motion rendition, measurement and attribute-write helpers. |
| `apps/web/src/components/editor/extensions/custom-image.test.ts` | Part 43 suites: layout projection, conflict resolution, sizing, caption (commit paths and debounce), pointer resize (preview, single commit, Shift, Escape, clamp), keyboard resize, reduced motion. |
| `apps/web/src/components/editor/extensions/index.ts` | Barrel exports for the new symbols. |
| `apps/web/src/components/editor/extensions/note-editor-extensions.test.ts` | New clipboard round-trip case for the four `data-*` attributes. |
| `apps/web/src/components/editor/keyboard-shortcuts.ts` | New `images` group and the two resize bindings. |
| `apps/web/src/components/editor/TiptapEditor.tsx` | Renders `<ImageToolbar>` with the existing portal target. |
| `apps/web/src/components/editor/editor-shortcuts.test.tsx` | Behavioural expectations for the two new bindings, plus the `press` override seam. |
| `apps/web/src/components/notes/note-autosave-integration.test.tsx` | The baseline guard (a Part 42 image note opens clean) and a resize saving through the one existing call site. |
| `apps/web/src/test/editor-harness.tsx` | Arrow keys in `NAMED_KEYS`, modifier options on `pressKey`, and `pressBinding`. |
| `apps/web/src/styles/globals.css` | The real Part 43 screen rules, replacing the placeholder comment. |
| `apps/web/src/styles/print.css` | Alignment, wrap, full width, and caption on paper; chrome suppressed. |
| `apps/web/e2e/note-images.spec.ts` | Three new browser journeys: resize persists and undoes, keyboard alignment persists and prints, caption survives a reload and prints as text. |

## Database and Data Changes

None. No migration, no seed change, no new persisted column. The document contract widened additively at version 1 (Decision 2), and the `attachments` table is unchanged.

No image was added to `seed-fixtures.ts`, for the same reason Part 42 recorded: a seeded image would need a real `attachments` row and its object bytes, and would ripple into tests that assert that document's exact shape.

## API, Configuration, and Operational Changes

No new route, environment variable, port, or flag. Nothing in `apps/api` was touched.

**No new save call site.** A resize, an alignment change, a full-width toggle, an alt-text edit, and a caption commit are all ordinary editor transactions that take exactly the route a typed character takes: `updateAttributes`/`setNodeMarkup` → `onUpdate` → `safeParseNoteDocument` → `onDocumentChange` → `useNoteAutosave` → one debounced PATCH carrying `expectedVersion`. Part 39's single-version-cell invariant is untouched. A whole drag produces exactly one transaction, and the caption's 500 ms debounce means typing a caption produces one transaction rather than one per character.

**`pnpm build:packages` is required before anything in `apps/web` type-checks or tests**, because `apps/web` consumes the shared-validators *dist* and this part adds new exports to it. It was **not** run here.

## Security and Tenant-Isolation Notes

- **The image node still has no `src`, `url`, `href`, or data-URI attribute, and the four additions are not URL-shaped.** `NODE_ALLOWED_ATTRS.image` grew from four keys to eight and the loop that rejects a ninth is unchanged; the Part 42 `it.each` proof is re-run against the widened set, including a new `captionUrl` case.
- **Caption text is untrusted author input and is treated exactly like alt.** Bounded at 1 000 characters, rejected outright if it carries control characters, escaped by `renderImageHtml`, and set through `textContent`/`input.value` in the DOM — never interpolated into markup.
- **`align`, `wrap`, and `fullWidth` are closed enumerations and a strict boolean.** `"true"`, `1`, and `null` are all rejected rather than coerced, so a layout flag's stored meaning cannot depend on which client wrote it. The renderer emits them from those closed sets, so nothing an author stores can become an arbitrary attribute value in an export.
- **The figure renderer copies nothing through.** Classes are module constants, layout values come from the enumerations, and no stored class or style is echoed. Asserted.
- **Backend policy remains authoritative.** Nothing here re-implements authorization; the only bytes fetched are from Part 40's proxied content endpoint, which re-checks workspace membership per request. Choosing `medium` instead of `full` under reduced motion changes which authorized URL is requested, nothing about who may request it.
- **No new network I/O anywhere.** The toolbar, the dialog, and the node view perform none; `tiptap-editor.test.tsx`'s "never contacts the server" assertion (which covers `fetch` *and* `XMLHttpRequest`) still applies unchanged.
- Removing an image from the editor deliberately does **not** delete the attachment. Destroying stored bytes from an undoable editor action would make a single Ctrl+Z unable to restore what it appears to restore; orphan reconciliation is Part 45.

## Accessibility Notes

- Every toolbar control is a real `<button type="button">` with an accessible name; alignment, wrap, and full width report `aria-pressed`. One roving tab stop, `role="toolbar"`, Escape to dismiss with focus returned to the editor.
- The caption is a labelled `<input>` (`aria-label="Image caption"`, placeholder "Add a caption"), reachable and operable from the keyboard, `disabled` in a read-only note.
- Resize is available from the keyboard through a declared, documented binding; the resulting size is announced through a visually hidden `role="status" aria-live="polite"` region, which is the only feedback a non-sighted keyboard user would otherwise get.
- The alt-text dialog states in prose that empty is a legitimate choice for a decorative image, offers "Mark as decorative" explicitly, and never forces a non-empty value — closing the WCAG 1.1.1 gap Part 42 carried forward.
- `prefers-reduced-motion: reduce` selects the static rendition for animated images (WCAG 2.2.2) and removes the fade-in and the resize transition.
- Handles are `aria-hidden` presentational elements with an equivalent keyboard path (Decision 7).

## Verification Evidence

Run by the fix pass after the first review round. Every row below was executed and watched.

| Check | Result | Notes |
|---|---|---|
| `pnpm build:packages` | Pass | Run first, as required — `apps/web` consumes the shared-validators dist. |
| `pnpm format:check` | Pass | After `pnpm format` fixed 29 files. |
| `pnpm lint` | Pass | After `pnpm lint:fix`. `--max-warnings 0`, 4/4 packages. |
| `pnpm type-check` | Pass | 6/6 tasks. |
| `pnpm test` | Pass | 6/6 tasks; web 1162/1162, shared-validators 292/292, shared-types 7/7. |
| `pnpm --filter @notted/web` coverage (70 % thresholds) | Pass | 81.98 % statements / 74.48 % branches / 84.39 % functions / 84.54 % lines; exit 0. |
| `pnpm build` | **Fail (environment, not code)** | `NEXT_PUBLIC_APP_URL must use a secure protocol in production`, from the dev `apps/web/.env.local`. Reproduced, then re-run with production-shaped env: `next build` completes and emits every route. `@notted/api build` passes standalone. |
| `custom-image.test.ts`, `editor-shortcuts.test.tsx`, `note-autosave-integration.test.tsx` | Pass | The keyboard-resize `RangeError: Applying a mismatched transaction` is fixed; `nottedResizeSelectedImage` now writes into the in-flight `tr`. |
| `apps/web/e2e/note-images.spec.ts` (Chromium, disposable stack with MinIO) | Pass | 8/8 with `note-attachments.spec.ts` under `pnpm e2e:test --grep "image\|attachment"`. Two Part 43 journeys failed on first execution and were fixed — see below. |
| `image-toolbar.test.tsx` roving navigation | Pass | 12/12. New regression guard; verified it fails when the handler is unbound, so it is not vacuous. |
| Firefox / WebKit | Not run | Only the Chromium project is the maintained baseline. Still owed. |
| Manual print preview | Not run | Print rules reviewed by reading; `print.css` covers `data-align`, `data-wrap`, `data-full-width`, `data-has-caption` and the `figcaption`. Still owed. |

Two defects surfaced only in a real browser, both found by review round 2 and fixed here:

- **The image toolbar's arrow keys were dead.** `useRovingToolbar` bound its `keydown` listener from an effect whose only dependency was a `useCallback([])`. `ImageToolbar` renders `null` until an image is selected, so the first and only effect pass saw a null ref and bailed; the listener was never attached once the element appeared. `EditorToolbar` escaped it purely by always being mounted. The hook now returns an `onKeyDown` for the caller to bind, and the effect and native listener are gone. This was a genuine WCAG 2.2 AA / APG failure against Part 43's own acceptance criterion, invisible to 1162 passing unit tests.
- **Two e2e tests were mis-authored.** The resize journey used a 64 px fixture and asserted a shrink of more than 50 px, which `IMAGE_MIN_WIDTH_PX = 48` correctly makes impossible — it now uses a 400 px fixture. Its undo assertion also ran *after* `page.reload()`, where the history stack is empty and Ctrl+Z proves nothing; undo/redo now run before the reload, and the redo settles to "No unsaved changes." rather than "Saved." because returning to the already-persisted document is correctly not a new save.

## Known Limitations and Follow-up Work

- **Reduced motion drops still images to the `medium` rendition too.** `AttachmentEntry` carries no "is animated" flag, so the swap cannot yet be narrowed to the images that actually animate. On a HiDPI screen that is a visible quality loss for readers who prefer reduced motion. The narrow fix is to have Part 41's metadata projection expose an `animated` boolean and gate the swap on it; the node view change is one condition.
- **An unsized figure that is switched to `wrap: "inline"` gets a 40 % default width from CSS rather than a stored one.** That default is presentation, not contract, so two surfaces (screen and print) restate it. If it ever needs to be author-controllable it should become a stored width written when the wrap mode changes.
- **`wrap: "inline"` with `align: "center"` floats to the start edge.** Centre has no side to float to; the combination is accepted by the contract and resolved in CSS only. Recorded here because it is the one alignment/wrap pair whose meaning lives in the stylesheet.
- **The floating toolbar is portalled to `document.body`, so it is at the end of the tab order, not adjacent to the image.** Escape and pointer/click access are correct, and every control is keyboard-operable once focused, but a keyboard-only author cannot Tab straight from a selected image into the toolbar. A follow-up should add an explicit "open image options" affordance or focus management from the node view. Part 44's attachment card will have the same shape of problem and should solve it once, in `useSelectedNode`'s consumers.
- **Existing small images will render smaller than before.** Under Part 42 a stored `width: 120` image still stretched to the full column because the frame had no explicit width; it now renders at 120 px. That is the correct behaviour and the reason the attribute exists, but it is a visible change for notes created between Parts 42 and 43.
- **Deleting an image still leaves the attachment row and its objects.** Part 45.
- The three new Playwright journeys, like the Part 42 ones, need the disposable stack **with MinIO** and are skipped otherwise.
- **`next build` deletes the tracked `apps/web/.next/.docker-mount` marker.** It must be restored (`git checkout -- apps/web/.next/.docker-mount`) after any local web build. A follow-up should move the marker outside `.next` or recreate it from the compose entrypoint.

## Handoff Notes

- **Run `pnpm build:packages` before anything else.** `apps/web` imports `NOTE_DOCUMENT_IMAGE_FIGURE_CLASS`, `NOTE_DOCUMENT_IMAGE_CAPTION_CLASS`, and `resolveNoteImageWrap` from the shared-validators **dist**; without a rebuild every web check fails with a resolution error that looks like a code bug.
- **The contract change and the node-view change must stay in the same commit.** ProseMirror writes every declared attribute into `getJSON()`, so an editor that declares `align`/`wrap`/`fullWidth`/`caption` against a contract that does not accept them produces output `safeParseNoteDocument` rejects — and Part 39 then stops saving silently for the entire session. `note-autosave-integration.test.tsx` has a dedicated test for the baseline path ("opens a Part 42 image note clean").
- **`resolveNoteImageWrap` is the only place the `fullWidth` + `inline` conflict may be decided.** Three callers agree by calling it. Do not add a fourth rule in CSS or in an exporter.
- **Do not divide pointer coordinates by the zoom scale in the drop handler** (Part 42, Decision 7 — the comment is still there). The resize *does* convert, once, through a measured factor; `pointerScaleOf()` explains why the two cases differ. Read both comments before changing either.
- **`rescueDeletedPlaceholders`, its whole-document exception, the absence of a decoration `destroy` hook, the uninstalled `@tiptap/extension-image`, and `loading`/`decoding` as attributes are all untouched and must stay that way.**
- **Part 44 can reuse, without change:** `useSelectedNode.ts` (contextual chrome for any selected atom node), `reduced-motion.ts` (shared preference observer), the `createPortal(…, document.body)` + `position: fixed` from the node rect pattern in `ImageToolbar.tsx`, `useRovingToolbar`, `useDialogFocusRestore`, and the `data-notted-print-hide` convention. `image-resize.ts` is image-specific and should not be generalised for files. There is deliberately **no** shared byte formatter yet — Part 44 introduces the first caller, so it should own it (suggested home: `apps/web/src/lib/notes/` beside the existing attachment helpers, so a later quota display in Part 45 can import it too).
- **The four exact-set guardrail suites:** `note-editor-extensions.test.ts` and `suggestion-modules.test.ts` needed **no** change (no new node type, no new slash command). `editor-shortcuts.test.tsx` gained two cases and a `press` override — the completeness assertion was not weakened. `keyboard-shortcuts-dialog.test.tsx` is entirely data-driven and needed no change; the new `images` group renders automatically.
- **Testing gotchas encountered:** jsdom has no `PointerEvent`, so the drag is driven with `MouseEvent`s carrying pointer event names; jsdom reports every rect as zero, so `measurePageContentWidth` returns `null` and the clamp falls back to `maxImageDimension` (which is why the unit expectations use 10 000, not the page width); `vi.stubGlobal("matchMedia", …)` must be paired with `resetReducedMotionForTests()` because the observer is cached at module level; fake timers are installed only in `beforeEach`/`afterEach` of the caption-debounce block.
- **If a reviewer sees an image "look dirty" the instant a note opens**, the cause is almost certainly a new attribute whose ProseMirror default the contract does not accept, or a `paintImage` side effect that writes to the document. Check `onDocumentBaseline` in `NoteEditorSurface.tsx` first.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-08-07 | frontend-editor-engineer agent | Initial record. Contract widening (align/wrap/fullWidth/caption), figure + figcaption rendering, resize handles with ratio lock and Shift freeform, page-width clamp, keyboard resize bindings, debounced caption field, portalled image toolbar, alt-text dialog, reduced-motion rendition swap, screen and print styling, three new unit suites, five extended suites, and three Playwright journeys. All verification deferred to the review round. |
