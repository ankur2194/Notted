/**
 * Embedded images.
 *
 * `Notted.md`'s canonical structure names this file `extensions/CustomImage.ts`
 * with a capital C and I even though it is not a React component. `Notted.md` is
 * primary for directory structure, so the spec's spelling wins over the
 * kebab-case rule for `.ts` files in `CLAUDE.md` — the same ruling already
 * recorded in `extensions/Mention.ts`.
 *
 * ## Why this is hand-written instead of `@tiptap/extension-image`
 *
 * The stock extension stores a `src` attribute. The shared contract forbids one
 * outright (`NODE_ALLOWED_ATTRS.image`), because the absence of any URL-shaped
 * attribute is exactly what guarantees a saved note can never depend on a
 * `blob:` preview or a `data:` placeholder. Installing an extension whose entire
 * data model is a URL and then fighting it with attribute overrides would leave
 * a dependency whose next minor version could quietly reintroduce the field. So
 * the package is deliberately **not** installed, and the node is written here:
 * `{ attachmentId, alt, width, height, align, wrap, fullWidth, caption }`, no
 * `src`, resolved to real bytes at render time through an authorized, proxied
 * API URL.
 *
 * ## Why the node view stays plain DOM (Part 43)
 *
 * It would be tempting to convert to a React node view now that there is a
 * caption field and a set of handles. It is not done, and deliberately:
 * `ignoreMutation: () => true` plus the `AttachmentDirectory` subscription is
 * what keeps ProseMirror from ever reading this subtree back as document
 * content, and a React node view changes both. The *chrome* that genuinely wants
 * React — the floating toolbar and the alt-text dialog — lives outside the node
 * view in `ImageToolbar.tsx` and `ImageAltTextDialog.tsx`, portalled past the
 * paper's transform.
 */

import {
  NOTE_DOCUMENT_IMAGE_CAPTION_CLASS,
  NOTE_DOCUMENT_IMAGE_CLASS,
  NOTE_DOCUMENT_IMAGE_FIGURE_CLASS,
  NOTE_DOCUMENT_LIMITS,
  noteDocumentImageAttrs,
  resolveNoteImageWrap,
} from "@notted/shared-validators";
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";

import {
  IMAGE_RESIZE_HANDLES,
  IMAGE_RESIZE_HANDLE_LABELS,
  IMAGE_RESIZE_STEP_PX,
  displayImageWidth,
  resizeImage,
  resolveImageResizeBounds,
  stepImageWidth,
  type ImageResizeBounds,
  type ImageResizeHandle,
  type ImageSize,
} from "../image-resize";
import { hasImageFiles, hasMeaningfulHtml, imageFilesFromDataTransfer } from "../image-transfer";
import { editorShortcutBinding } from "../keyboard-shortcuts";
import { prefersReducedMotion, subscribeToReducedMotion } from "../reduced-motion";

import {
  IMAGE_DROP_ACTIVE_CLASS,
  createImageInsertionController,
  createImageUploadPlaceholderPlugin,
  type ImageInsertionController,
} from "./image-upload-placeholder";

import type { AttachmentDirectory } from "../attachment-directory";
import type { NoteDocumentImageAttrs } from "@notted/shared-validators";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

export const IMAGE_EXTENSION_NAME = "image";

/** Wrapper painted around the `<img>`; owns the blur-up and aspect ratio. */
export const IMAGE_FRAME_CLASS = "notted-image-frame";
export const IMAGE_FALLBACK_CLASS = "notted-image-fallback";
/** Part 43 chrome. The figure and caption classes come from the contract. */
export const IMAGE_HANDLES_CLASS = "notted-image-handles";
export const IMAGE_HANDLE_CLASS = "notted-image-handle";
export const IMAGE_CAPTION_INPUT_CLASS = "notted-image-caption__input";
export const IMAGE_CAPTION_TEXT_CLASS = "notted-image-caption__text";
export const IMAGE_STATUS_CLASS = "notted-image-status";

export const IMAGE_UNAVAILABLE_TEXT = "This image is unavailable.";
export const IMAGE_LOADING_TEXT = "Loading image…";
export const IMAGE_CAPTION_PLACEHOLDER = "Add a caption";
export const IMAGE_CAPTION_LABEL = "Image caption";

/**
 * How long the caption waits before writing to the document.
 *
 * Per-keystroke `updateAttributes` would push one undo step and one autosave
 * candidate per character: undo would rewind letter by letter and Part 39's
 * debounce would be re-armed on every keypress. Half a second is long enough to
 * coalesce ordinary typing and short enough that a caption committed by clicking
 * elsewhere is never surprising — and blur and Enter commit immediately anyway,
 * so the delay is never the only path to a save.
 */
export const IMAGE_CAPTION_COMMIT_DELAY_MS = 500;

/**
 * Events that must not escape the caption field.
 *
 * A text input inside a node view still bubbles its key and clipboard events up
 * to `EditorView.dom`, where ProseMirror would treat them as editing the
 * document. Every one of these is stopped at the field.
 */
const CAPTION_SWALLOWED_EVENTS: readonly string[] = Object.freeze([
  "keyup",
  "keypress",
  "beforeinput",
  "paste",
  "cut",
  "copy",
]);

/** What a paste, a drop, or the file picker hands to the upload host. */
export interface ImageUploadRequest {
  readonly files: readonly File[];
  /** Document position the images belong at. */
  readonly insertAt: number;
  /** The only way the host touches ProseMirror. */
  readonly controller: ImageInsertionController;
}

export type ImageUploadHandler = (request: ImageUploadRequest) => void;

/**
 * Asks the host to open its file picker. It carries a controller for the same
 * reason `ImageUploadRequest` does: the host must be able to place placeholders
 * without ever importing a ProseMirror module or holding an editor instance.
 */
export interface ImageFilePickerRequest {
  readonly insertAt: number;
  readonly controller: ImageInsertionController;
}

export type ImageFilePickerHandler = (request: ImageFilePickerRequest) => void;

export interface NoteImageConfig {
  /** Loaded attachment metadata. `null` renders stored images neutrally. */
  readonly directory?: AttachmentDirectory | null;
  /** Injected so the editor itself performs no network I/O. */
  readonly resolveUploader?: () => ImageUploadHandler | null;
  /** Opens the host-owned `<input type="file">`. */
  readonly resolveFilePicker?: () => ImageFilePickerHandler | null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    nottedImage: {
      /** Insert an image that already has a permanent attachment reference. */
      setNoteImage: (attrs: NoteDocumentImageAttrs) => ReturnType;
      /** Ask the host to open the file picker at the current selection. */
      nottedRequestImageUpload: () => ReturnType;
      /** Widen (positive) or narrow (negative) the selected image by `step` px. */
      nottedResizeSelectedImage: (step: number) => ReturnType;
    };
  }
}

function integerAttribute(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function enumAttribute<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * Only a bounded, base64 WebP/PNG data URI is ever painted as a background.
 * The value already passed `attachmentBlurPlaceholderSchema` on the wire; this
 * is the second, local check that stops anything else reaching a CSS `url()`.
 */
const BLUR_DATA_URI_PATTERN = /^data:image\/[a-z+]{2,20};base64,[A-Za-z0-9+/=]{1,2048}$/u;

export interface ImageDom {
  readonly root: HTMLElement;
  readonly frame: HTMLElement;
  readonly image: HTMLImageElement;
  readonly fallback: HTMLElement;
  readonly handles: HTMLElement;
  readonly caption: HTMLElement;
  readonly captionInput: HTMLInputElement;
  readonly captionText: HTMLElement;
  readonly status: HTMLElement;
}

function createHandle(handle: ImageResizeHandle): HTMLElement {
  const element = document.createElement("span");
  element.className = IMAGE_HANDLE_CLASS;
  element.dataset.imageHandle = handle;
  // Presentational on purpose. Four unlabelled tab stops per image would be
  // noise for a keyboard user, and the same capability is reachable from the
  // keyboard through the declared resize bindings (WCAG 2.1.1 is satisfied by
  // an equivalent path, not by making every pointer affordance focusable).
  element.setAttribute("aria-hidden", "true");
  element.title = IMAGE_RESIZE_HANDLE_LABELS[handle];
  return element;
}

export function createImageDom(): ImageDom {
  const root = document.createElement("figure");
  root.className = NOTE_DOCUMENT_IMAGE_FIGURE_CLASS;
  root.setAttribute("contenteditable", "false");
  root.setAttribute("draggable", "true");

  const frame = document.createElement("div");
  frame.className = IMAGE_FRAME_CLASS;

  const image = document.createElement("img");
  image.className = NOTE_DOCUMENT_IMAGE_CLASS;
  // Native lazy loading and off-thread decoding: a note with many images paints
  // its text immediately instead of blocking on the images below the fold.
  // Set as ATTRIBUTES, not IDL properties. Both drive identical browser
  // behaviour, but only the attribute form is observable through
  // `getAttribute`, serializes into `outerHTML`, and survives a clone of the
  // node — which is what makes the behaviour assertable rather than invisible.
  image.setAttribute("loading", "lazy");
  image.setAttribute("decoding", "async");

  const fallback = document.createElement("div");
  fallback.className = IMAGE_FALLBACK_CLASS;
  fallback.hidden = true;

  // Editing chrome, never content: it must not print, and it is never part of
  // the document, the clipboard, or an export.
  const handles = document.createElement("div");
  handles.className = IMAGE_HANDLES_CLASS;
  handles.setAttribute("data-notted-print-hide", "");
  handles.setAttribute("aria-hidden", "true");
  for (const handle of IMAGE_RESIZE_HANDLES) handles.append(createHandle(handle));

  const caption = document.createElement("figcaption");
  caption.className = NOTE_DOCUMENT_IMAGE_CAPTION_CLASS;
  // Dragging the figure must start from the image, not from a text field.
  caption.setAttribute("draggable", "false");

  const captionInput = document.createElement("input");
  captionInput.type = "text";
  captionInput.className = IMAGE_CAPTION_INPUT_CLASS;
  captionInput.placeholder = IMAGE_CAPTION_PLACEHOLDER;
  captionInput.setAttribute("aria-label", IMAGE_CAPTION_LABEL);
  captionInput.maxLength = NOTE_DOCUMENT_LIMITS.maxImageCaption;
  // The typed value is chrome until it is committed; the printed caption comes
  // from `captionText`, which carries the value stored on the node.
  captionInput.setAttribute("data-notted-print-hide", "");

  const captionText = document.createElement("span");
  captionText.className = IMAGE_CAPTION_TEXT_CLASS;

  const status = document.createElement("div");
  status.className = IMAGE_STATUS_CLASS;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("data-notted-print-hide", "");

  caption.append(captionInput, captionText);
  frame.append(image, fallback, handles);
  root.append(frame, caption, status);
  return { root, frame, image, fallback, handles, caption, captionInput, captionText, status };
}

function showFallback(dom: ImageDom, alt: string, text: string): void {
  dom.image.hidden = true;
  dom.image.removeAttribute("src");
  dom.fallback.hidden = false;
  // A decorative image keeps a decorative fallback: announcing "unavailable"
  // for an image the author marked `alt=""` would add noise, not information.
  if (alt.length === 0) {
    dom.fallback.removeAttribute("role");
    dom.fallback.setAttribute("aria-hidden", "true");
  } else {
    dom.fallback.setAttribute("role", "img");
    dom.fallback.setAttribute("aria-label", alt);
    dom.fallback.removeAttribute("aria-hidden");
  }
  dom.fallback.textContent = text;
}

export interface ImagePaintContext {
  readonly directory: AttachmentDirectory | null;
  /** Read-only notes show a caption but never an editable field or a handle. */
  readonly editable: boolean;
  /** Chooses the static rendition for an animated image. */
  readonly reducedMotion: boolean;
  /** Clamp for the displayed width; see `resolveImageResizeBounds`. */
  readonly bounds: ImageResizeBounds;
}

/** Aspect ratio the frame should reserve, from the node first and metadata second. */
function ratioOf(width: number | null, height: number | null): number | null {
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  return width / height;
}

function applyImageLayout(
  dom: ImageDom,
  attrs: NoteDocumentImageAttrs,
  context: ImagePaintContext,
): void {
  dom.root.setAttribute("data-align", attrs.align);
  // The RESOLVED wrap, so the editor, `print.css`, and Part 63's export all lay
  // a full-width figure out identically. `resolveNoteImageWrap` is the one place
  // the `fullWidth` + `inline` conflict is decided.
  dom.root.setAttribute("data-wrap", resolveNoteImageWrap(attrs));
  dom.root.setAttribute("data-full-width", attrs.fullWidth ? "true" : "false");
  dom.root.setAttribute("data-image-editable", context.editable ? "true" : "false");

  /*
   * The width lives on the FIGURE, not on the frame.
   *
   * The frame is always `width: 100%` of the figure, so one inline value drives
   * the image, the caption, and the alignment together: alignment is then plain
   * `margin-inline`, which needs a definite width to mean anything. Clearing the
   * value hands sizing back to the stylesheet, which is what makes both "full
   * width" and "never resized" fall out of the same rule.
   *
   * A full-width figure takes the whole column, so a stored width is ignored
   * rather than fought with in CSS. Otherwise the stored width is clamped on
   * READ: a Part 42 image carrying a 4000 px intrinsic width is drawn inside the
   * page without rewriting the document, which would be an unrequested edit.
   */
  const width = attrs.fullWidth ? null : displayImageWidth(attrs.width, context.bounds);
  dom.root.style.width = width === null ? "" : `${width}px`;
  // Lets the stylesheet tell "the author chose this width" apart from "nothing
  // has ever sized this figure", which is the difference between honouring an
  // explicit width and giving a floated figure a usable default.
  dom.root.setAttribute("data-image-sized", width === null ? "false" : "true");

  dom.captionText.textContent = attrs.caption;
  // `print.css` uses this to keep an empty caption slot off the paper while the
  // editable field still occupies its place on screen.
  dom.root.setAttribute("data-has-caption", attrs.caption.length > 0 ? "true" : "false");
  dom.captionInput.disabled = !context.editable;
  dom.captionInput.readOnly = !context.editable;
  // Typing must never be clobbered by a repaint caused by something else (an
  // attachment list arriving, a sibling edit): the field owns its own value
  // while it has focus, and the debounce reconciles it.
  if (document.activeElement !== dom.captionInput && dom.captionInput.value !== attrs.caption) {
    dom.captionInput.value = attrs.caption;
  }
  // Nothing to show and nothing to type into.
  dom.caption.hidden = !context.editable && attrs.caption.length === 0;
}

/**
 * Paint one image from the node and the loaded attachment metadata.
 *
 * Three cases, and the difference matters exactly as it does for a mention:
 *
 * - **ready** — the attachment is known: reserve its aspect ratio, paint the
 *   blur placeholder, and load the authorized rendition. There is no layout
 *   shift, because the box is sized before a byte arrives;
 * - **missing** — metadata loaded and this id is not in it, so the attachment
 *   really is gone: say so;
 * - **unknown** — metadata has not loaded or the request failed. Reserve space
 *   and say the image is loading. An unavailable list is never evidence that an
 *   attachment was deleted.
 */
export function paintImage(dom: ImageDom, node: ProseMirrorNode, context: ImagePaintContext): void {
  const attrs = noteDocumentImageAttrs(node.attrs);
  if (attrs === null) {
    dom.root.removeAttribute("data-attachment-id");
    dom.caption.hidden = true;
    showFallback(dom, "", IMAGE_UNAVAILABLE_TEXT);
    return;
  }

  dom.root.setAttribute("data-attachment-id", attrs.attachmentId);
  const resolution =
    context.directory === null
      ? { kind: "unknown" as const }
      : context.directory.resolve(attrs.attachmentId);
  const entry = resolution.kind === "ready" ? resolution.entry : null;

  const width = attrs.width ?? entry?.width ?? null;
  const height = attrs.height ?? entry?.height ?? null;
  // The single most effective anti-layout-shift measure available: the box has
  // its final shape before the network is touched.
  const ratio = ratioOf(width, height);
  dom.frame.style.aspectRatio = ratio === null ? "" : `${width} / ${height}`;

  applyImageLayout(dom, attrs, context);

  const blur = entry?.blurDataUri ?? null;
  dom.frame.style.backgroundImage =
    blur !== null && BLUR_DATA_URI_PATTERN.test(blur) ? `url("${blur}")` : "";

  dom.root.setAttribute("data-image-state", resolution.kind);
  if (entry === null) {
    showFallback(
      dom,
      attrs.alt,
      resolution.kind === "missing" ? IMAGE_UNAVAILABLE_TEXT : IMAGE_LOADING_TEXT,
    );
    dom.root.setAttribute("aria-busy", resolution.kind === "missing" ? "false" : "true");
    return;
  }

  dom.root.setAttribute("aria-busy", "false");
  dom.fallback.hidden = true;
  dom.image.hidden = false;
  // `alt=""` is preserved verbatim: it is the accessible way to mark an image
  // decorative, and substituting a filename would be worse than nothing.
  dom.image.alt = attrs.alt;
  if (width !== null) dom.image.width = width;
  if (height !== null) dom.image.height = height;
  /*
   * Reduced motion (Part 43).
   *
   * `full` preserves an animated GIF's animation; Part 41 renders `medium` as a
   * STATIC first-frame poster. Selecting `medium` when the reader has asked for
   * reduced motion therefore stops the animation without re-processing anything
   * and without adding a play/pause control to every image (WCAG 2.2.2). A still
   * image is unaffected apart from resolution, which is why the swap is applied
   * to the rendition rather than to a CSS animation.
   */
  const source = context.reducedMotion ? entry.sources.medium : entry.sources.full;
  if (dom.image.getAttribute("src") !== source) {
    dom.root.setAttribute("data-image-loaded", "false");
    dom.image.setAttribute("src", source);
  }
}

/* -------------------------------------------------------------------------- */
/* Measurement                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The printable content width, in the paper's own untransformed pixels.
 *
 * `--notted-page-content-width` is published by `page-geometry.ts` precisely so
 * that this part can clamp against it (`globals.css` says so at the token's
 * definition). The arithmetic is deliberately **not** repeated here: two
 * independent derivations of "page width minus margins" drift the first time a
 * margin default changes.
 *
 * The token is a `calc()` in physical units, so it is resolved the only way a
 * custom property can be: by giving a throwaway element that width and reading
 * the used value back. `offsetWidth` is read rather than `getBoundingClientRect`
 * because the paper carries a zoom `transform` and `offsetWidth` reports layout
 * pixels, which is the space an inline `width` is expressed in.
 *
 * Returns `null` when there is no paper ancestor (a standalone editor), or when
 * the environment has no layout at all (jsdom reports every box as zero). The
 * caller then falls back to the contract bound — see `resolveImageResizeBounds`.
 */
export function measurePageContentWidth(element: HTMLElement | null): number | null {
  if (element === null || typeof document === "undefined") return null;
  const paper = element.closest<HTMLElement>(".notted-page-paper");
  if (paper === null) return null;
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.height = "0";
  probe.style.width = "var(--notted-page-content-width)";
  paper.append(probe);
  const measured = probe.offsetWidth;
  probe.remove();
  return measured > 0 ? measured : null;
}

/**
 * Viewport pixels per layout pixel for this element.
 *
 * **This is not the Part 42 "do not divide by the zoom scale" case, and the
 * difference is the whole reason this function exists.** Part 42's finding
 * (Decision 7, and the comment in `handleDrop` below) is that `posAtCoords`
 * compares `clientX` against `getBoundingClientRect()`, and *both* are already
 * in scaled viewport space — so dividing one of them is wrong.
 *
 * A resize is the other arrangement. A pointer delta is in scaled viewport
 * space, but the value being written is an inline `width`, which is a **layout**
 * length the zoom transform is applied to afterwards. The two sides are in
 * different spaces, so the delta has to be converted exactly once.
 *
 * The factor is *measured* — the element's own rect divided by its own layout
 * box — rather than read from the zoom store. That way it is correct for any
 * nesting of transforms, correct at 100 % (where it is exactly 1), and it cannot
 * drift from whatever `PageContainer` is actually doing.
 */
export function pointerScaleOf(element: HTMLElement): number {
  const layout = element.offsetWidth;
  if (layout <= 0) return 1;
  const rendered = element.getBoundingClientRect().width;
  if (!Number.isFinite(rendered) || rendered <= 0) return 1;
  return rendered / layout;
}

/* -------------------------------------------------------------------------- */
/* Attribute writes — every one of them participates in editor history          */
/* -------------------------------------------------------------------------- */

export type ImageAttributePatch = Partial<Omit<NoteDocumentImageAttrs, "attachmentId">>;

/**
 * Update the image the selection is on.
 *
 * `updateAttributes` runs through the ordinary command pipeline, so the change
 * is an ordinary transaction: it lands in the undo stack, `onUpdate` fires, and
 * Part 39's autosave sees it exactly as it sees a typed character. It must never
 * copy the upload placeholder's `addToHistory: false` — that is for decorations,
 * which are not document changes at all.
 */
export function updateSelectedImage(editor: Editor, patch: ImageAttributePatch): boolean {
  return editor.chain().updateAttributes(IMAGE_EXTENSION_NAME, patch).run();
}

/**
 * Update the image at a known position **without moving the selection**.
 *
 * The caption field needs this: `setNodeSelection` would move the editor
 * selection, and ProseMirror would then sync the DOM selection and blur the
 * input the author is typing into. It is still one ordinary transaction in the
 * undo stack — the only difference from `updateSelectedImage` is that it names
 * its target by position instead of by selection.
 */
export function updateImageAt(editor: Editor, pos: number, patch: ImageAttributePatch): boolean {
  return editor
    .chain()
    .command(({ tr, state }) => {
      const node = state.doc.nodeAt(pos);
      if (node === null || node.type.name !== IMAGE_EXTENSION_NAME) return false;
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch });
      return true;
    })
    .run();
}

/** The image a `NodeSelection` is on, with its position, or `null`. */
export function selectedImage(
  editor: Editor,
): { readonly node: ProseMirrorNode; readonly pos: number } | null {
  const { selection } = editor.state;
  if (!(selection instanceof NodeSelection)) return null;
  if (selection.node.type.name !== IMAGE_EXTENSION_NAME) return null;
  return { node: selection.node, pos: selection.from };
}

/**
 * The box a resize starts from.
 *
 * Preference order: what the frame actually measures, then the stored width
 * clamped to the page, then the width of the printable column.
 *
 * The measurement comes **first** on purpose. A Part 42 image stores its
 * intrinsic width, which is routinely far wider than the page, and it is drawn
 * clamped; starting a drag or a keypress from the stored 4000 would make the
 * figure jump to something it was never showing. The last fallback is the column
 * width because a figure with no stored width *is* displayed at full column
 * width, so that genuinely is its current size.
 */
function currentSize(
  node: ProseMirrorNode,
  frame: HTMLElement | null,
  bounds: ImageResizeBounds,
): ImageSize {
  const attrs = noteDocumentImageAttrs(node.attrs);
  const measured = frame === null ? 0 : frame.offsetWidth;
  const stored = displayImageWidth(attrs?.width ?? null, bounds) ?? bounds.maxWidth;
  return { width: measured > 0 ? measured : stored, height: attrs?.height ?? null };
}

/** `currentSize` from the node's whole figure element. */
function currentSizeOfFigure(
  node: ProseMirrorNode,
  figure: HTMLElement | null,
  bounds: ImageResizeBounds,
): ImageSize {
  const frame = figure?.querySelector<HTMLElement>(`.${IMAGE_FRAME_CLASS}`) ?? null;
  return currentSize(node, frame, bounds);
}

/* -------------------------------------------------------------------------- */
/* Resize interaction                                                           */
/* -------------------------------------------------------------------------- */

interface ResizeSession {
  readonly handle: ImageResizeHandle;
  readonly startX: number;
  readonly startY: number;
  readonly startWidth: number;
  readonly startHeight: number | null;
  readonly scale: number;
  readonly bounds: ImageResizeBounds;
  /** Inline styles to restore when the gesture is cancelled with Escape. */
  readonly restoreWidth: string;
  readonly restoreAspectRatio: string;
  /** Last pointer position, so Shift can be sampled without a pointer move. */
  lastX: number;
  lastY: number;
  freeform: boolean;
  latest: ImageSize;
}

function describeSize(size: ImageSize): string {
  return size.height === null
    ? `Image width ${size.width} pixels`
    : `Image ${size.width} by ${size.height} pixels`;
}

/* -------------------------------------------------------------------------- */
/* Paste, drop, and the drag affordance                                         */
/* -------------------------------------------------------------------------- */

function dataTransferOf(event: Event): DataTransfer | null {
  const candidate = event as {
    clipboardData?: DataTransfer | null;
    dataTransfer?: DataTransfer | null;
  };
  return candidate.clipboardData ?? candidate.dataTransfer ?? null;
}

function setDropActive(view: EditorView, active: boolean): void {
  view.dom.classList.toggle(IMAGE_DROP_ACTIVE_CLASS, active);
}

/**
 * Paste, drop, and the drag affordance.
 *
 * These live in `addProseMirrorPlugins()` rather than in `TiptapEditor`'s
 * `editorProps`, which stays `attributes`-only: paste and drop are *this node's*
 * behaviour, and putting them here means the editor component never grows a
 * handler that knows what an upload is.
 */
function createImageTransferPlugin(
  editor: Editor,
  resolveUploader: () => ImageUploadHandler | null,
): Plugin {
  let dragDepth = 0;

  const dispatch = (view: EditorView, files: readonly File[], insertAt: number): boolean => {
    const handler = resolveUploader();
    if (handler === null || files.length === 0 || !view.editable) return false;
    handler({ files, insertAt, controller: createImageInsertionController(editor) });
    return true;
  };

  return new Plugin({
    key: new PluginKey("nottedImageTransfer"),
    props: {
      handlePaste: (view, event) => {
        const transfer = dataTransferOf(event);
        const files = imageFilesFromDataTransfer(transfer);
        if (files.length === 0) return false;
        // A Word or Google Docs paste carries an inline image *and* real HTML.
        // Consuming it as an upload would silently throw the document away, so
        // the clipboard's HTML wins whenever it means anything.
        if (hasMeaningfulHtml(transfer)) return false;
        if (!dispatch(view, files, view.state.selection.from)) return false;
        event.preventDefault();
        return true;
      },

      handleDrop: (view, event, _slice, moved) => {
        dragDepth = 0;
        setDropActive(view, false);
        // `moved` means an existing node is being dragged inside this document.
        // Without this, dragging an image two paragraphs down would re-upload it.
        if (moved) return false;
        const files = imageFilesFromDataTransfer(dataTransferOf(event));
        if (files.length === 0) return false;
        /*
         * Zoom gotcha, verified in Chromium at 125%:
         *
         * `PageContainer` renders the sheet inside a `transform: scale()`. It is
         * tempting to divide the pointer coordinates by that scale — and wrong.
         * ProseMirror's `posAtCoords` compares `clientX`/`clientY` against
         * `getBoundingClientRect()`, and a transformed element's rect is ALREADY
         * reported in scaled viewport space. Both sides of the comparison carry
         * the same scale, so dividing one of them puts the image somewhere the
         * writer never dropped it.
         *
         * Part 43's resize is the OTHER arrangement — a viewport delta written
         * into a layout length — and converts exactly once through a measured
         * factor. See `pointerScaleOf`.
         */
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
        const insertAt = at?.pos ?? view.state.selection.from;
        if (!dispatch(view, files, insertAt)) return false;
        event.preventDefault();
        return true;
      },

      handleDOMEvents: {
        dragenter: (view, event) => {
          if (!hasImageFiles(dataTransferOf(event))) return false;
          // A counter, not a boolean: dragging across a child element fires
          // `dragleave` for the parent, and a boolean would flicker the
          // highlight off on every internal boundary crossing.
          dragDepth += 1;
          setDropActive(view, true);
          return false;
        },
        dragover: (_view, event) => {
          const transfer = dataTransferOf(event);
          if (!hasImageFiles(transfer) || transfer === null) return false;
          // Say "copy", because dropping a file never moves anything.
          transfer.dropEffect = "copy";
          return false;
        },
        dragleave: (view) => {
          dragDepth = Math.max(0, dragDepth - 1);
          if (dragDepth === 0) setDropActive(view, false);
          return false;
        },
        drop: (view) => {
          dragDepth = 0;
          setDropActive(view, false);
          return false;
        },
      },
    },
  });
}

/** Per-instance factory; never a module-level singleton. */
export function createNoteImage(config: NoteImageConfig = {}) {
  const directory = config.directory ?? null;
  const resolveUploader = config.resolveUploader ?? ((): null => null);
  const resolveFilePicker = config.resolveFilePicker ?? ((): null => null);

  return Node.create({
    name: IMAGE_EXTENSION_NAME,
    group: "block",
    atom: true,
    draggable: true,
    selectable: true,

    addAttributes() {
      return {
        attachmentId: {
          default: null,
          parseHTML: (element: HTMLElement) => element.getAttribute("data-attachment-id"),
          renderHTML: (attributes: Record<string, unknown>) =>
            typeof attributes.attachmentId === "string"
              ? { "data-attachment-id": attributes.attachmentId }
              : {},
        },
        alt: {
          default: "",
          parseHTML: (element: HTMLElement) => element.getAttribute("alt") ?? "",
          renderHTML: (attributes: Record<string, unknown>) => ({
            alt: typeof attributes.alt === "string" ? attributes.alt : "",
          }),
        },
        width: {
          default: null,
          parseHTML: (element: HTMLElement) => integerAttribute(element.getAttribute("width")),
          renderHTML: (attributes: Record<string, unknown>) =>
            typeof attributes.width === "number" ? { width: String(attributes.width) } : {},
        },
        height: {
          default: null,
          parseHTML: (element: HTMLElement) => integerAttribute(element.getAttribute("height")),
          renderHTML: (attributes: Record<string, unknown>) =>
            typeof attributes.height === "number" ? { height: String(attributes.height) } : {},
        },
        /*
         * Part 43. The defaults match the contract's documented defaults exactly,
         * so a document stored before Part 43 opens, serializes, and saves as the
         * same picture it always was. ProseMirror always writes every declared
         * attribute into `toJSON()`, which is precisely why the contract had to
         * accept these four in the same change as this one: without that,
         * `safeParseNoteDocument` would reject the editor's own output and Part
         * 39's autosave would go silent for the whole session.
         */
        align: {
          default: "center",
          parseHTML: (element: HTMLElement) =>
            enumAttribute(
              element.getAttribute("data-align"),
              ["left", "center", "right"],
              "center",
            ),
          renderHTML: (attributes: Record<string, unknown>) => ({
            "data-align": typeof attributes.align === "string" ? attributes.align : "center",
          }),
        },
        wrap: {
          default: "block",
          parseHTML: (element: HTMLElement) =>
            enumAttribute(element.getAttribute("data-wrap"), ["block", "inline"], "block"),
          renderHTML: (attributes: Record<string, unknown>) => ({
            "data-wrap": typeof attributes.wrap === "string" ? attributes.wrap : "block",
          }),
        },
        fullWidth: {
          default: false,
          parseHTML: (element: HTMLElement) => element.getAttribute("data-full-width") === "true",
          renderHTML: (attributes: Record<string, unknown>) => ({
            "data-full-width": attributes.fullWidth === true ? "true" : "false",
          }),
        },
        caption: {
          default: "",
          parseHTML: (element: HTMLElement) => element.getAttribute("data-caption") ?? "",
          renderHTML: (attributes: Record<string, unknown>) =>
            typeof attributes.caption === "string" && attributes.caption.length > 0
              ? { "data-caption": attributes.caption }
              : {},
        },
      };
    },

    /**
     * Only an `<img>` that already carries an attachment reference is adopted.
     * A pasted `<img src="https://evil.example/tracker.gif">` matches nothing
     * and is dropped, so no remote reference can enter a note through the
     * clipboard. An adopted id is still only a *reference*: every read of the
     * bytes is authorized server-side, so a forged id from another workspace
     * discloses nothing — it renders as unavailable.
     */
    parseHTML() {
      return [{ tag: "img[data-attachment-id]" }];
    },

    /**
     * Never emits a `src`. The node has none to emit.
     *
     * This stays a bare `<img>` rather than the `<figure>` the *contract's*
     * `renderImageHtml` emits, and the difference is deliberate: this is
     * ProseMirror's DOM serializer, which has to round-trip through `parseHTML`
     * for copy and paste inside the editor. Wrapping it in a figure here would
     * mean the clipboard produced markup this node cannot read back. Layout
     * therefore travels as `data-*` attributes, which `parseHTML` reads.
     * `renderImageHtml` is the projection for print, export, and any non-editor
     * reader, and it is the one that emits semantic figure markup.
     */
    renderHTML({ HTMLAttributes }) {
      return [
        "img",
        mergeAttributes(HTMLAttributes, {
          class: NOTE_DOCUMENT_IMAGE_CLASS,
          loading: "lazy",
          decoding: "async",
        }),
      ];
    },

    renderText({ node }) {
      const attrs = noteDocumentImageAttrs(node.attrs);
      if (attrs === null) return "";
      return [attrs.alt, attrs.caption].filter((part) => part.length > 0).join("\n");
    },

    addNodeView() {
      return ({ node, editor, getPos }) => {
        const dom = createImageDom();
        let current = node;
        let bounds = resolveImageResizeBounds(null);
        let session: ResizeSession | null = null;
        let captionTimer: ReturnType<typeof setTimeout> | null = null;

        const paint = (): void => {
          paintImage(dom, current, {
            directory,
            editable: editor.isEditable,
            reducedMotion: prefersReducedMotion(),
            bounds,
          });
        };
        const repaint = (): void => {
          // Re-measured on every repaint rather than cached: the page size, the
          // margins, and the paper itself can all change while a note is open.
          bounds = resolveImageResizeBounds(measurePageContentWidth(dom.root));
          paint();
        };

        const positionOf = (): number | null => {
          const pos = getPos?.();
          return typeof pos === "number" ? pos : null;
        };

        const announce = (message: string): void => {
          dom.status.textContent = message;
        };

        /* ------------------------------------------------------- caption */

        const clearCaptionTimer = (): void => {
          if (captionTimer !== null) {
            clearTimeout(captionTimer);
            captionTimer = null;
          }
        };

        const commitCaption = (): void => {
          clearCaptionTimer();
          if (!editor.isEditable) return;
          const pos = positionOf();
          if (pos === null) return;
          const next = dom.captionInput.value.slice(0, NOTE_DOCUMENT_LIMITS.maxImageCaption);
          const attrs = noteDocumentImageAttrs(current.attrs);
          if (attrs !== null && attrs.caption === next) return;
          updateImageAt(editor, pos, { caption: next });
        };

        const onCaptionInput = (): void => {
          clearCaptionTimer();
          captionTimer = setTimeout(commitCaption, IMAGE_CAPTION_COMMIT_DELAY_MS);
        };

        const onCaptionBlur = (): void => {
          commitCaption();
        };

        /*
         * A text field inside a `contenteditable="false"` node view still emits
         * key events that bubble to `EditorView.dom`, where ProseMirror's keymap
         * would happily treat Backspace as "delete the selected node" and Enter
         * as "split the block". Stopping propagation is what makes the field a
         * field. It also means the image resize bindings deliberately do not
         * fire while a caption is being typed.
         */
        const onCaptionKeyDown = (event: KeyboardEvent): void => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            commitCaption();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            clearCaptionTimer();
            dom.captionInput.value = noteDocumentImageAttrs(current.attrs)?.caption ?? "";
            editor.commands.focus();
          }
        };
        const swallow = (event: Event): void => event.stopPropagation();

        dom.captionInput.addEventListener("input", onCaptionInput);
        dom.captionInput.addEventListener("blur", onCaptionBlur);
        dom.captionInput.addEventListener("keydown", onCaptionKeyDown);
        for (const type of CAPTION_SWALLOWED_EVENTS) {
          dom.captionInput.addEventListener(type, swallow);
        }
        // Without this, clicking into the field makes ProseMirror select the
        // node and pull DOM focus straight back out of the input.
        dom.caption.addEventListener("pointerdown", swallow);
        dom.caption.addEventListener("mousedown", swallow);

        /* -------------------------------------------------------- resize */

        function previewSize(size: ImageSize): void {
          // Direct style mutation: a live preview must never touch the document,
          // or a single drag would push one undo step and one autosave candidate
          // per pointer sample. The commit happens once, on pointer-up.
          dom.root.style.width = `${size.width}px`;
          if (size.height !== null) dom.frame.style.aspectRatio = `${size.width} / ${size.height}`;
        }

        function endSession(): void {
          session = null;
          dom.root.removeAttribute("data-image-resizing");
          window.removeEventListener("pointermove", onPointerMove);
          window.removeEventListener("pointerup", onPointerUp);
          window.removeEventListener("pointercancel", onPointerCancel);
          window.removeEventListener("keydown", onSessionKeyDown, true);
          window.removeEventListener("keyup", onSessionKeyUp, true);
        }

        /** Recompute and preview from the session's last known pointer position. */
        function recompute(active: ResizeSession): void {
          active.latest = resizeImage({
            handle: active.handle,
            startWidth: active.startWidth,
            startHeight: active.startHeight,
            // Converted from viewport space to layout space exactly once; see
            // `pointerScaleOf` for why this is not the Part 42 "do not divide"
            // case.
            deltaX: (active.lastX - active.startX) / active.scale,
            deltaY: (active.lastY - active.startY) / active.scale,
            freeform: active.freeform,
            bounds: active.bounds,
          });
          previewSize(active.latest);
        }

        function applySession(active: ResizeSession, event: PointerEvent | MouseEvent): void {
          active.lastX = event.clientX;
          active.lastY = event.clientY;
          active.freeform = event.shiftKey;
          recompute(active);
        }

        function onPointerMove(event: PointerEvent): void {
          if (session === null) return;
          event.preventDefault();
          applySession(session, event);
        }

        function onPointerUp(event: PointerEvent): void {
          const active = session;
          if (active === null) return;
          applySession(active, event);
          const committed = active.latest;
          endSession();
          const pos = positionOf();
          if (pos === null || !editor.isEditable) {
            repaint();
            return;
          }
          /*
           * ONE write for the whole gesture, so undo restores the size the
           * figure had before the drag rather than replaying every pixel — and
           * one chain, so the selection and the attribute change are a single
           * transaction and therefore a single history step. `updateAttributes`
           * is used deliberately: it is an ordinary command, so the change is an
           * ordinary undoable transaction that Part 39's autosave observes. It
           * must never borrow the upload placeholder's `addToHistory: false`,
           * which exists for decorations that are not document changes at all.
           */
          editor
            .chain()
            .setNodeSelection(pos)
            .updateAttributes(IMAGE_EXTENSION_NAME, {
              width: committed.width,
              height: committed.height,
            })
            .run();
          announce(describeSize(committed));
        }

        /** Escape or a lost pointer: put the figure back exactly as it was. */
        function onPointerCancel(): void {
          const active = session;
          if (active === null) return;
          dom.root.style.width = active.restoreWidth;
          dom.frame.style.aspectRatio = active.restoreAspectRatio;
          endSession();
        }

        /**
         * Shift is sampled live: pressing or releasing it mid-drag re-previews
         * immediately from the last pointer position, so the author does not
         * have to jiggle the mouse to see the mode change. Every pointer move
         * also re-reads `event.shiftKey`, so the two sources cannot disagree.
         */
        function onSessionKeyDown(event: KeyboardEvent): void {
          const active = session;
          if (active === null) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onPointerCancel();
            return;
          }
          if (event.key !== "Shift" || active.freeform) return;
          active.freeform = true;
          recompute(active);
        }

        function onSessionKeyUp(event: KeyboardEvent): void {
          const active = session;
          if (active === null || event.key !== "Shift" || !active.freeform) return;
          active.freeform = false;
          recompute(active);
        }

        const onHandlePointerDown = (event: PointerEvent): void => {
          if (!editor.isEditable || session !== null) return;
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          const handle = target.dataset.imageHandle as ImageResizeHandle | undefined;
          if (handle === undefined) return;
          event.preventDefault();
          event.stopPropagation();

          const pos = positionOf();
          if (pos !== null) editor.commands.setNodeSelection(pos);

          bounds = resolveImageResizeBounds(measurePageContentWidth(dom.root));
          const attrs = noteDocumentImageAttrs(current.attrs);
          const { width: startWidth } = currentSize(current, dom.frame, bounds);
          const ratio =
            ratioOf(attrs?.width ?? null, attrs?.height ?? null) ??
            (dom.frame.offsetHeight > 0 ? dom.frame.offsetWidth / dom.frame.offsetHeight : null);
          const startHeight = ratio === null ? null : Math.round(startWidth / ratio);

          session = {
            handle,
            startX: event.clientX,
            startY: event.clientY,
            startWidth,
            startHeight,
            scale: pointerScaleOf(dom.frame),
            bounds,
            restoreWidth: dom.root.style.width,
            restoreAspectRatio: dom.frame.style.aspectRatio,
            lastX: event.clientX,
            lastY: event.clientY,
            freeform: event.shiftKey,
            latest: { width: startWidth, height: startHeight },
          };
          dom.root.setAttribute("data-image-resizing", "true");
          window.addEventListener("pointermove", onPointerMove);
          window.addEventListener("pointerup", onPointerUp);
          window.addEventListener("pointercancel", onPointerCancel);
          // Capture phase: Escape must cancel the drag before anything else
          // (a dialog, the focus-mode toggle) reacts to it.
          window.addEventListener("keydown", onSessionKeyDown, true);
          window.addEventListener("keyup", onSessionKeyUp, true);
        };

        dom.handles.addEventListener("pointerdown", onHandlePointerDown);

        /* --------------------------------------------------------- paint */

        const onLoad = (): void => dom.root.setAttribute("data-image-loaded", "true");
        const onError = (): void => {
          const attrs = noteDocumentImageAttrs(current.attrs);
          showFallback(dom, attrs?.alt ?? "", IMAGE_UNAVAILABLE_TEXT);
        };
        dom.image.addEventListener("load", onLoad);
        dom.image.addEventListener("error", onError);

        repaint();
        const unsubscribe = directory?.subscribe(repaint) ?? null;
        const unsubscribeMotion = subscribeToReducedMotion(paint);

        return {
          dom: dom.root,
          ignoreMutation: () => true,
          update: (nextNode) => {
            if (nextNode.type.name !== IMAGE_EXTENSION_NAME) return false;
            current = nextNode;
            repaint();
            return true;
          },
          // `stopEvent` keeps ProseMirror out of the caption field entirely:
          // without it the view treats a click or a keystroke inside the input
          // as an editor event and moves the selection out from under it.
          stopEvent: (event: Event) => {
            const target = event.target;
            return target instanceof HTMLElement && dom.caption.contains(target);
          },
          destroy: () => {
            clearCaptionTimer();
            endSession();
            dom.image.removeEventListener("load", onLoad);
            dom.image.removeEventListener("error", onError);
            dom.handles.removeEventListener("pointerdown", onHandlePointerDown);
            dom.captionInput.removeEventListener("input", onCaptionInput);
            dom.captionInput.removeEventListener("blur", onCaptionBlur);
            dom.captionInput.removeEventListener("keydown", onCaptionKeyDown);
            for (const type of CAPTION_SWALLOWED_EVENTS) {
              dom.captionInput.removeEventListener(type, swallow);
            }
            dom.caption.removeEventListener("pointerdown", swallow);
            dom.caption.removeEventListener("mousedown", swallow);
            unsubscribe?.();
            unsubscribeMotion();
          },
        };
      };
    },

    addCommands() {
      return {
        setNoteImage:
          (attrs: NoteDocumentImageAttrs) =>
          ({ commands }) =>
            commands.insertContent({ type: IMAGE_EXTENSION_NAME, attrs: { ...attrs } }),

        nottedRequestImageUpload:
          () =>
          ({ editor, state, dispatch }) => {
            const handler = resolveFilePicker();
            if (handler === null) return false;
            // Report availability without side effects for `editor.can()`.
            if (dispatch === undefined) return true;
            // The caret at the moment the command ran is where the picked files
            // belong, even though the dialog resolves much later.
            handler({
              insertAt: state.selection.from,
              controller: createImageInsertionController(editor),
            });
            return true;
          },

        /**
         * Keyboard resize. Same clamp and the same single history step as a
         * pointer drag, so the two paths can never disagree about what fits.
         *
         * Writes into the IN-FLIGHT transaction (`tr`) rather than starting a
         * fresh `editor.chain()`. A command handler runs inside `CommandManager`,
         * which already holds a `tr` derived from the current state and will
         * dispatch it when the chain finishes. An inner chain dispatches its own
         * transaction first, advancing the state; the outer dispatch then arrives
         * carrying a `tr` built on the state before that — and ProseMirror
         * rejects it with `RangeError: Applying a mismatched transaction`. Same
         * pattern as `updateImageAt`.
         */
        nottedResizeSelectedImage:
          (step: number) =>
          ({ editor, tr, dispatch }) => {
            const selected = selectedImage(editor);
            if (selected === null) return false;
            if (dispatch === undefined) return true;
            const dom = editor.view.nodeDOM(selected.pos);
            const element = dom instanceof HTMLElement ? dom : null;
            const bounds = resolveImageResizeBounds(measurePageContentWidth(element));
            const next = stepImageWidth(
              currentSizeOfFigure(selected.node, element, bounds),
              step,
              bounds,
            );
            tr.setNodeMarkup(selected.pos, undefined, {
              ...selected.node.attrs,
              width: next.width,
              height: next.height,
            });
            const status = element?.querySelector<HTMLElement>(`.${IMAGE_STATUS_CLASS}`) ?? null;
            if (status !== null) status.textContent = describeSize(next);
            return true;
          },
      };
    },

    addKeyboardShortcuts() {
      return {
        [editorShortcutBinding("imageWiden")]: () =>
          this.editor.commands.nottedResizeSelectedImage(IMAGE_RESIZE_STEP_PX),
        [editorShortcutBinding("imageNarrow")]: () =>
          this.editor.commands.nottedResizeSelectedImage(-IMAGE_RESIZE_STEP_PX),
      };
    },

    addProseMirrorPlugins() {
      return [
        createImageUploadPlaceholderPlugin(),
        createImageTransferPlugin(this.editor, resolveUploader),
      ];
    },
  });
}
