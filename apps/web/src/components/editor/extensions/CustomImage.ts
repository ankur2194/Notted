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
 * `{ attachmentId, alt, width, height }`, no `src`, resolved to real bytes at
 * render time through an authorized, proxied API URL.
 *
 * Part 43 adds alignment, wrap, caption, and full-width sizing on top of this
 * node; it is block-level for exactly that reason.
 */

import { NOTE_DOCUMENT_IMAGE_CLASS, noteDocumentImageAttrs } from "@notted/shared-validators";
import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import { hasImageFiles, hasMeaningfulHtml, imageFilesFromDataTransfer } from "../image-transfer";

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

export const IMAGE_UNAVAILABLE_TEXT = "This image is unavailable.";
export const IMAGE_LOADING_TEXT = "Loading image…";

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
    };
  }
}

function integerAttribute(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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
}

function createImageDom(): ImageDom {
  const root = document.createElement("div");
  root.className = "notted-image-figure";
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

  frame.append(image, fallback);
  root.append(frame);
  return { root, frame, image, fallback };
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
export function paintImage(
  dom: ImageDom,
  node: ProseMirrorNode,
  directory: AttachmentDirectory | null,
): void {
  const attrs = noteDocumentImageAttrs(node.attrs);
  if (attrs === null) {
    dom.root.removeAttribute("data-attachment-id");
    showFallback(dom, "", IMAGE_UNAVAILABLE_TEXT);
    return;
  }

  dom.root.setAttribute("data-attachment-id", attrs.attachmentId);
  const resolution =
    directory === null ? { kind: "unknown" as const } : directory.resolve(attrs.attachmentId);
  const entry = resolution.kind === "ready" ? resolution.entry : null;

  const width = attrs.width ?? entry?.width ?? null;
  const height = attrs.height ?? entry?.height ?? null;
  // The single most effective anti-layout-shift measure available: the box has
  // its final shape before the network is touched.
  dom.frame.style.aspectRatio = width === null || height === null ? "" : `${width} / ${height}`;

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
  const source = entry.sources.full;
  if (dom.image.getAttribute("src") !== source) {
    dom.root.setAttribute("data-image-loaded", "false");
    dom.image.setAttribute("src", source);
  }
}

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

    /** Never emits a `src`. The node has none to emit. */
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
      return attrs === null || attrs.alt.length === 0 ? "" : attrs.alt;
    },

    addNodeView() {
      return ({ node }) => {
        const dom = createImageDom();
        let current = node;
        const repaint = (): void => paintImage(dom, current, directory);

        const onLoad = (): void => dom.root.setAttribute("data-image-loaded", "true");
        const onError = (): void => {
          const attrs = noteDocumentImageAttrs(current.attrs);
          showFallback(dom, attrs?.alt ?? "", IMAGE_UNAVAILABLE_TEXT);
        };
        dom.image.addEventListener("load", onLoad);
        dom.image.addEventListener("error", onError);

        repaint();
        const unsubscribe = directory?.subscribe(repaint) ?? null;

        return {
          dom: dom.root,
          ignoreMutation: () => true,
          update: (nextNode) => {
            if (nextNode.type.name !== IMAGE_EXTENSION_NAME) return false;
            current = nextNode;
            repaint();
            return true;
          },
          destroy: () => {
            dom.image.removeEventListener("load", onLoad);
            dom.image.removeEventListener("error", onError);
            unsubscribe?.();
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
