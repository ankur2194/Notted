/**
 * The image node view's DOM: how the figure is built, and how one node's
 * attributes are painted onto it.
 *
 * Split out of `CustomImage.ts`, which had grown past 1 250 lines by holding the
 * DOM, the measurement helpers, the attribute commands, the resize gesture, the
 * caption field and the transfer plugin in one place. Nothing here knows about
 * TipTap: `createImageDom` builds elements, `paintImage` writes a node's
 * attributes onto them, and both are callable from a test with no editor at all.
 *
 * Every export is re-exported from `CustomImage.ts`, so no importer moved.
 */

import {
  NOTE_DOCUMENT_IMAGE_CLASS,
  NOTE_DOCUMENT_IMAGE_CAPTION_CLASS,
  NOTE_DOCUMENT_IMAGE_FIGURE_CLASS,
  NOTE_DOCUMENT_LIMITS,
  noteDocumentImageAttrs,
  resolveNoteImageWrap,
} from "@notted/shared-validators";

import {
  IMAGE_RESIZE_HANDLES,
  IMAGE_RESIZE_HANDLE_LABELS,
  displayImageWidth,
  type ImageResizeBounds,
  type ImageResizeHandle,
} from "../image-resize";

import {
  IMAGE_CAPTION_INPUT_CLASS,
  IMAGE_CAPTION_LABEL,
  IMAGE_CAPTION_PLACEHOLDER,
  IMAGE_CAPTION_TEXT_CLASS,
  IMAGE_FALLBACK_CLASS,
  IMAGE_FRAME_CLASS,
  IMAGE_HANDLE_CLASS,
  IMAGE_HANDLES_CLASS,
  IMAGE_LOADING_TEXT,
  IMAGE_STATUS_CLASS,
  IMAGE_UNAVAILABLE_TEXT,
} from "./image-constants";

import type { AttachmentDirectory } from "../attachment-directory";
import type { NoteDocumentImageAttrs } from "@notted/shared-validators";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

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

export function showFallback(dom: ImageDom, alt: string, text: string): void {
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
export function ratioOf(width: number | null, height: number | null): number | null {
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
