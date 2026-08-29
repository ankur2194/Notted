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
  NOTE_DOCUMENT_IMAGE_CLASS,
  NOTE_DOCUMENT_LIMITS,
  noteDocumentImageAttrs,
} from "@notted/shared-validators";
import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import {
  IMAGE_RESIZE_STEP_PX,
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

import { currentSize, currentSizeOfFigure, selectedImage, updateImageAt } from "./image-commands";
import {
  IMAGE_EXTENSION_NAME,
  IMAGE_STATUS_CLASS,
  IMAGE_TOOLBAR_REQUEST_EVENT,
  IMAGE_UNAVAILABLE_TEXT,
} from "./image-constants";
import { measurePageContentWidth, pointerScaleOf } from "./image-measurement";
import { createImageDom, paintImage, ratioOf, showFallback } from "./image-node-dom";
import {
  IMAGE_DROP_ACTIVE_CLASS,
  createImageInsertionController,
  createImageUploadPlaceholderPlugin,
  type ImageInsertionController,
} from "./image-upload-placeholder";

import type { AttachmentDirectory } from "../attachment-directory";
import type { NoteDocumentImageAttrs } from "@notted/shared-validators";
import type { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";

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
/*
 * Re-exported, not moved on paper: `extensions/index.ts`, the toolbar, and four
 * test files import these from this path. A split that renames anyone's import
 * is a refactor, and this is meant to be a split.
 */
export {
  IMAGE_CAPTION_INPUT_CLASS,
  IMAGE_CAPTION_LABEL,
  IMAGE_CAPTION_PLACEHOLDER,
  IMAGE_CAPTION_TEXT_CLASS,
  IMAGE_EXTENSION_NAME,
  IMAGE_FALLBACK_CLASS,
  IMAGE_FRAME_CLASS,
  IMAGE_HANDLE_CLASS,
  IMAGE_HANDLES_CLASS,
  IMAGE_LOADING_TEXT,
  IMAGE_STATUS_CLASS,
  IMAGE_TOOLBAR_REQUEST_EVENT,
  IMAGE_UNAVAILABLE_TEXT,
} from "./image-constants";
export {
  createImageDom,
  paintImage,
  type ImageDom,
  type ImagePaintContext,
} from "./image-node-dom";
export { measurePageContentWidth, pointerScaleOf } from "./image-measurement";
export {
  selectedImage,
  updateImageAt,
  updateSelectedImage,
  type ImageAttributePatch,
} from "./image-commands";

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
            // COMMIT, not discard. A caption typed within
            // `IMAGE_CAPTION_COMMIT_DELAY_MS` of teardown -- type, then click a
            // sidebar link, and the in-app navigation unmounts the editor before
            // the debounce fires and before any blur handler runs -- was thrown
            // away with no transaction, so it reached neither the document nor
            // autosave. `commitCaption` already clears the timer, already
            // returns when the position is gone, and already no-ops when the
            // value is unchanged; the only thing it needs is a live editor to
            // dispatch into.
            if (editor.isDestroyed) clearCaptionTimer();
            else commitCaption();
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
        [editorShortcutBinding("imageOptions")]: () => {
          // Returning false with no image selected lets the chord fall through
          // to whatever else may claim it, exactly as the resize bindings do.
          if (selectedImage(this.editor) === null) return false;
          this.editor.view.dom.dispatchEvent(
            new CustomEvent(IMAGE_TOOLBAR_REQUEST_EVENT, { bubbles: true, composed: false }),
          );
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
