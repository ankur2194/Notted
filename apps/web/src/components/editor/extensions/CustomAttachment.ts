/**
 * Generic file attachments (Part 44).
 *
 * `Notted.md` names `extensions/CustomImage.ts` with a capital C and I even
 * though it is not a React component, and this file follows the same spelling
 * for the same reason: `Notted.md` is primary for directory structure, and
 * `Mention.ts` / `CustomImage.ts` already record that ruling.
 *
 * ## The node stores no URL, and that is the point
 *
 * `{ attachmentId, name, mimeType, sizeBytes }`, and nothing else — no `src`, no
 * `href`, no `downloadUrl`. `NODE_ALLOWED_ATTRS.attachment` rejects one. The
 * bytes are reached through the authorized content endpoint, which re-checks
 * workspace membership on every request, so a note that is copied, exported, or
 * shared can never carry a link that outlives the reader's permission. The three
 * non-id attributes are a **cached display projection**: the attachment
 * directory overrides all three the moment the authorized listing arrives, so a
 * stale value is a cosmetic inaccuracy and never an authority.
 *
 * ## Why the node view is plain DOM
 *
 * Identical reasoning to `CustomImage.ts`: `ignoreMutation: () => true` plus an
 * `AttachmentDirectory` subscription is what stops ProseMirror reading this
 * subtree back as document content, and a React node view changes both. The two
 * things that genuinely need React — the delete confirmation and the PDF preview
 * — live outside the node view in `AttachmentDialogs.tsx`, and the card reaches
 * them by dispatching a bubbling `CustomEvent`. That keeps every dialog, every
 * fetch, and every piece of React state out of the editor subtree while leaving
 * the card's own controls as ordinary, focusable DOM.
 */

import {
  NOTE_DOCUMENT_ATTACHMENT_CLASS,
  NOTE_DOCUMENT_ATTACHMENT_META_CLASS,
  NOTE_DOCUMENT_ATTACHMENT_NAME_CLASS,
  // `NOTE_DOCUMENT_ATTACHMENT_SIZE_CLASS` is deliberately NOT imported: the
  // server's `renderDocumentHtml` wraps the size in its own span, while this
  // NodeView folds kind, size, and upload date into one `.notted-attachment-detail`
  // line (the accessible equivalent lives in the `sr-only` sibling). There is no
  // size-only element here to carry the class, and putting it on `detail` would
  // label three values as one.
  NOTE_DOCUMENT_LIMITS,
  exactByteLabel,
  formatBinaryBytes,
  noteDocumentAttachmentAttrs,
} from "@notted/shared-validators";
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";

import {
  ATTACHMENT_KIND_LABELS,
  attachmentIconKind,
  createAttachmentIcon,
} from "../attachment-icons";
import { attachmentFilesFromDataTransfer, hasAttachmentFiles } from "../attachment-transfer";
import { hasMeaningfulHtml } from "../image-transfer";

import { createImageInsertionController } from "./image-upload-placeholder";

import type { AttachmentDirectory, AttachmentEntry } from "../attachment-directory";
import type { ImageInsertionController } from "./image-upload-placeholder";
import type { NoteDocumentAttachmentAttrs } from "@notted/shared-validators";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

export const ATTACHMENT_EXTENSION_NAME = "attachment";

export const ATTACHMENT_BODY_CLASS = "notted-attachment-body";
export const ATTACHMENT_ICON_CLASS = "notted-attachment-icon";
export const ATTACHMENT_DETAIL_CLASS = "notted-attachment-detail";
export const ATTACHMENT_ACTIONS_CLASS = "notted-attachment-actions";
export const ATTACHMENT_ACTION_CLASS = "notted-attachment-action";
export const ATTACHMENT_STATUS_CLASS = "notted-attachment-status";

/** Set on `view.dom` while a non-image file drag is over the editor. */
export const ATTACHMENT_DROP_ACTIVE_CLASS = "notted-attachment-drop-active";

export const ATTACHMENT_UNAVAILABLE_TEXT = "This file is unavailable.";
export const ATTACHMENT_LOADING_TEXT = "Loading file details…";
export const ATTACHMENT_FAILED_TEXT = "This file could not be processed.";
export const ATTACHMENT_DOWNLOAD_LABEL = "Download";
export const ATTACHMENT_PREVIEW_LABEL = "Preview";
export const ATTACHMENT_REMOVE_LABEL = "Delete";

/**
 * The bubbling events the card raises so a React host can own the dialogs.
 *
 * A `CustomEvent` rather than a callback prop because the node view is created
 * by ProseMirror, not by React: there is no place to thread a prop to, and the
 * alternatives (a module-level registry, a second injected resolver) are both
 * more coupling than a DOM event that the host already has an element for.
 * Both are `bubbles: true` and are listened for on `editor.view.dom`.
 */
export const ATTACHMENT_EVENTS = Object.freeze({
  preview: "notted:attachment-preview",
  remove: "notted:attachment-remove",
} as const);

/** Payload carried by both events. Identifiers and display metadata only. */
export interface AttachmentEventDetail {
  readonly attachmentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** Document position, so the host can remove exactly this node. */
  readonly pos: number | null;
}

/** What a drop or the file picker hands to the upload host. */
export interface AttachmentUploadRequest {
  readonly files: readonly File[];
  readonly insertAt: number;
  readonly controller: ImageInsertionController;
}

export type AttachmentUploadHandler = (request: AttachmentUploadRequest) => void;

export interface AttachmentFilePickerRequest {
  readonly insertAt: number;
  readonly controller: ImageInsertionController;
}

export type AttachmentFilePickerHandler = (request: AttachmentFilePickerRequest) => void;

export interface NoteAttachmentConfig {
  /** Loaded attachment metadata. `null` renders stored cards neutrally. */
  readonly directory?: AttachmentDirectory | null;
  /** Injected so the editor itself performs no network I/O. */
  readonly resolveUploader?: () => AttachmentUploadHandler | null;
  /** Opens the host-owned `<input type="file">`. */
  readonly resolveFilePicker?: () => AttachmentFilePickerHandler | null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    nottedAttachment: {
      /** Insert a card that already has a permanent attachment reference. */
      setNoteAttachment: (attrs: NoteDocumentAttachmentAttrs) => ReturnType;
      /** Ask the host to open the file picker at the current selection. */
      nottedRequestAttachmentUpload: () => ReturnType;
    };
  }
}

/** MIME types the in-app preview can render. Deliberately exactly one. */
export const ATTACHMENT_PREVIEWABLE_MIME_TYPES: ReadonlySet<string> = new Set(["application/pdf"]);

export interface AttachmentDom {
  readonly root: HTMLElement;
  readonly icon: HTMLElement;
  readonly name: HTMLElement;
  readonly fullName: HTMLElement;
  readonly detail: HTMLElement;
  readonly status: HTMLElement;
  readonly actions: HTMLElement;
  readonly download: HTMLAnchorElement;
  readonly preview: HTMLButtonElement;
  readonly remove: HTMLButtonElement;
}

function actionButton(label: string, testId: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = ATTACHMENT_ACTION_CLASS;
  element.textContent = label;
  element.dataset.testid = testId;
  // Without this ProseMirror moves the selection on mousedown and steals the
  // click before the button ever sees it — the same defence the upload
  // placeholder's buttons need.
  element.addEventListener("mousedown", (event) => event.preventDefault());
  return element;
}

export function createAttachmentDom(): AttachmentDom {
  const root = document.createElement("figure");
  root.className = NOTE_DOCUMENT_ATTACHMENT_CLASS;
  root.setAttribute("contenteditable", "false");
  root.setAttribute("draggable", "true");
  // A card is a self-contained unit of content; announcing it as a group lets a
  // screen reader move over it as one thing rather than four loose strings.
  root.setAttribute("role", "group");

  const body = document.createElement("div");
  body.className = ATTACHMENT_BODY_CLASS;

  const icon = document.createElement("span");
  icon.className = ATTACHMENT_ICON_CLASS;
  icon.setAttribute("aria-hidden", "true");

  const meta = document.createElement("div");
  meta.className = NOTE_DOCUMENT_ATTACHMENT_META_CLASS;

  // Visually truncated by the stylesheet. The `title` gives a pointer user the
  // full name and the visually hidden sibling gives it to assistive technology,
  // so neither has to guess at `Quarterly_repo…pdf`.
  const name = document.createElement("span");
  name.className = NOTE_DOCUMENT_ATTACHMENT_NAME_CLASS;
  name.setAttribute("aria-hidden", "true");

  const fullName = document.createElement("span");
  fullName.className = "sr-only";

  const detail = document.createElement("p");
  detail.className = ATTACHMENT_DETAIL_CLASS;

  const status = document.createElement("p");
  status.className = ATTACHMENT_STATUS_CLASS;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const actions = document.createElement("div");
  actions.className = ATTACHMENT_ACTIONS_CLASS;
  // Controls, never content: they must not print and must not reach an export.
  actions.setAttribute("data-notted-print-hide", "");

  // A real anchor, not a button: downloading is a navigation, and an anchor is
  // what gives the browser its own "save as", middle-click, and context menu.
  const download = document.createElement("a");
  download.className = ATTACHMENT_ACTION_CLASS;
  download.textContent = ATTACHMENT_DOWNLOAD_LABEL;
  download.rel = "noopener noreferrer";
  download.dataset.testid = "attachment-download";
  download.addEventListener("mousedown", (event) => event.stopPropagation());

  const preview = actionButton(ATTACHMENT_PREVIEW_LABEL, "attachment-preview");
  const remove = actionButton(ATTACHMENT_REMOVE_LABEL, "attachment-remove");

  meta.append(name, fullName, detail);
  body.append(icon, meta);
  actions.append(download, preview, remove);
  root.append(body, actions, status);
  return { root, icon, name, fullName, detail, status, actions, download, preview, remove };
}

export interface AttachmentPaintContext {
  readonly directory: AttachmentDirectory | null;
  /** A read-only note shows the card and the download, but never delete. */
  readonly editable: boolean;
}

/** `12 January 2026`, or `""` when the timestamp is absent or unparseable. */
export function formatAttachmentDate(iso: string | null): string {
  if (iso === null || iso.length === 0) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  // `en-GB`, not `en`: the day-first long form is what this function documents
  // and what the card's aria-label promises, and it is unambiguous read aloud in
  // every locale. `en` resolves to `en-US` and would silently produce
  // "January 12, 2026" instead.
  //
  // `timeZone: "UTC"` for the same reason `NoteCard` and `WorkspaceCard` pin it:
  // without it a viewer far enough west of UTC is told the file was uploaded a
  // day before the timestamp says, and the assertion below would depend on the
  // machine's clock settings.
  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

/**
 * Paint one card from the node and the loaded attachment metadata.
 *
 * Four states, and the difference matters exactly as it does for an image:
 *
 * - **ready** — the attachment is known and processed: show everything and
 *   enable the download;
 * - **failed** — the row exists but processing failed: say so, and offer no
 *   download, because there are no bytes to fetch;
 * - **missing** — metadata loaded and this id is not in it, so the attachment
 *   really is gone: say so;
 * - **unknown** — metadata has not loaded or the request failed. Show the
 *   node's cached name and size and say details are loading. An unavailable list
 *   is never evidence that an attachment was deleted.
 */
export function paintAttachment(
  dom: AttachmentDom,
  node: ProseMirrorNode,
  context: AttachmentPaintContext,
): void {
  const attrs = noteDocumentAttachmentAttrs(node.attrs);
  if (attrs === null) {
    dom.root.removeAttribute("data-attachment-id");
    dom.root.setAttribute("data-attachment-state", "missing");
    dom.name.textContent = "";
    dom.fullName.textContent = ATTACHMENT_UNAVAILABLE_TEXT;
    dom.detail.textContent = "";
    dom.status.textContent = ATTACHMENT_UNAVAILABLE_TEXT;
    dom.actions.hidden = true;
    return;
  }

  dom.root.setAttribute("data-attachment-id", attrs.attachmentId);
  const resolution =
    context.directory === null
      ? { kind: "unknown" as const }
      : context.directory.resolve(attrs.attachmentId);
  const entry: AttachmentEntry | null = resolution.kind === "ready" ? resolution.entry : null;

  // The DIRECTORY wins wherever it has an opinion: it is the authorized
  // projection of the database row, while the node holds a snapshot taken when
  // the card was inserted.
  const name = entry?.displayName ?? attrs.name;
  const mimeType = entry?.mimeType ?? attrs.mimeType;
  const sizeBytes = entry?.sizeBytes ?? attrs.sizeBytes;

  const state =
    entry === null
      ? resolution.kind
      : entry.status === "ready"
        ? "ready"
        : entry.status === "failed"
          ? "failed"
          : "processing";
  dom.root.setAttribute("data-attachment-state", state);
  dom.root.setAttribute("data-mime-type", mimeType);
  dom.root.setAttribute(
    "aria-busy",
    state === "unknown" || state === "processing" ? "true" : "false",
  );

  const kind = attachmentIconKind(mimeType, name);
  dom.icon.replaceChildren(createAttachmentIcon(kind));
  dom.icon.dataset.attachmentKind = kind;

  dom.name.textContent = name;
  dom.name.title = name;
  const size = formatBinaryBytes(sizeBytes);
  const uploaded = formatAttachmentDate(entry?.createdAt ?? null);
  // The visually hidden line is the one a screen reader gets, so it carries the
  // untruncated name, the kind, and the EXACT byte count rather than the
  // rounded one — the same pairing `WorkspaceStorageLimit` uses.
  dom.fullName.textContent = [
    name,
    ATTACHMENT_KIND_LABELS[kind],
    exactByteLabel(sizeBytes),
    uploaded.length > 0 ? `uploaded ${uploaded}` : "",
  ]
    .filter((part) => part.length > 0)
    .join(", ");
  dom.detail.textContent = [ATTACHMENT_KIND_LABELS[kind], size, uploaded]
    .filter((part) => part.length > 0)
    .join(" · ");
  // Visual only: the accessible equivalent is already in `fullName`.
  dom.detail.setAttribute("aria-hidden", "true");
  dom.root.setAttribute("aria-label", dom.fullName.textContent);

  dom.status.textContent =
    state === "missing"
      ? ATTACHMENT_UNAVAILABLE_TEXT
      : state === "failed"
        ? ATTACHMENT_FAILED_TEXT
        : state === "unknown" || state === "processing"
          ? ATTACHMENT_LOADING_TEXT
          : "";

  dom.actions.hidden = false;
  const downloadable = state === "ready" && entry !== null;
  if (downloadable) {
    dom.download.href = entry.contentUrl;
    // The browser saves under the server's sanitized name. `download` is only
    // honoured same-origin, and the API is a different origin in development, so
    // the authoritative name is the one in `Content-Disposition` either way.
    dom.download.download = name;
    dom.download.removeAttribute("aria-disabled");
    dom.download.tabIndex = 0;
  } else {
    dom.download.removeAttribute("href");
    dom.download.removeAttribute("download");
    dom.download.setAttribute("aria-disabled", "true");
    dom.download.tabIndex = -1;
  }
  dom.download.setAttribute("aria-label", `${ATTACHMENT_DOWNLOAD_LABEL} ${name}`);

  dom.preview.hidden = !(downloadable && ATTACHMENT_PREVIEWABLE_MIME_TYPES.has(mimeType));
  dom.preview.setAttribute("aria-label", `${ATTACHMENT_PREVIEW_LABEL} ${name}`);

  // Deleting a file is a permission-bearing action, so a read-only reader never
  // sees the control at all — the server would refuse it anyway.
  dom.remove.hidden = !context.editable;
  dom.remove.setAttribute("aria-label", `${ATTACHMENT_REMOVE_LABEL} ${name}`);
}

/**
 * Paste, drop, and the drag affordance for NON-IMAGE files.
 *
 * Registered after `CustomImage`'s transfer plugin, which is what makes the
 * split work: ProseMirror offers a drop to each `handleDrop` in plugin order and
 * stops at the first that returns `true`. The image plugin consumes any payload
 * containing an image and declines otherwise, so this one only ever sees
 * payloads with no images in them. A *mixed* drop therefore uploads the images
 * and ignores the rest — recorded as a known limitation rather than papered
 * over, because making both consume one drop would mean one of them calling
 * `preventDefault` on the other's behalf.
 */
function createAttachmentTransferPlugin(
  editor: Editor,
  resolveUploader: () => AttachmentUploadHandler | null,
): Plugin {
  let dragDepth = 0;

  const setDropActive = (view: EditorView, active: boolean): void => {
    view.dom.classList.toggle(ATTACHMENT_DROP_ACTIVE_CLASS, active);
  };

  const dataTransferOf = (event: Event): DataTransfer | null => {
    const candidate = event as {
      clipboardData?: DataTransfer | null;
      dataTransfer?: DataTransfer | null;
    };
    return candidate.clipboardData ?? candidate.dataTransfer ?? null;
  };

  const dispatch = (view: EditorView, files: readonly File[], insertAt: number): boolean => {
    const handler = resolveUploader();
    if (handler === null || files.length === 0 || !view.editable) return false;
    handler({ files, insertAt, controller: createImageInsertionController(editor) });
    return true;
  };

  return new Plugin({
    key: new PluginKey("nottedAttachmentTransfer"),
    props: {
      handlePaste: (view, event) => {
        const transfer = dataTransferOf(event);
        const files = attachmentFilesFromDataTransfer(transfer);
        if (files.length === 0) return false;
        // A document paste that happens to carry a file attachment still means
        // the document; the same rule the image path applies.
        if (hasMeaningfulHtml(transfer)) return false;
        if (!dispatch(view, files, view.state.selection.from)) return false;
        event.preventDefault();
        return true;
      },

      handleDrop: (view, event, _slice, moved) => {
        dragDepth = 0;
        setDropActive(view, false);
        // An existing node being dragged within the document must not re-upload.
        if (moved) return false;
        const files = attachmentFilesFromDataTransfer(dataTransferOf(event));
        if (files.length === 0) return false;
        // Coordinates are used unmodified: `posAtCoords` compares `clientX`
        // against `getBoundingClientRect()`, and both are already in scaled
        // viewport space (Part 42, Decision 7 — see the note in `CustomImage`).
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
        const insertAt = at?.pos ?? view.state.selection.from;
        if (!dispatch(view, files, insertAt)) return false;
        event.preventDefault();
        return true;
      },

      handleDOMEvents: {
        dragenter: (view, event) => {
          if (!hasAttachmentFiles(dataTransferOf(event))) return false;
          dragDepth += 1;
          setDropActive(view, true);
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

/** The attachment a `NodeSelection` is on, with its position, or `null`. */
export function selectedAttachment(
  editor: Editor,
): { readonly node: ProseMirrorNode; readonly pos: number } | null {
  const { selection } = editor.state;
  if (!(selection instanceof NodeSelection)) return null;
  if (selection.node.type.name !== ATTACHMENT_EXTENSION_NAME) return null;
  return { node: selection.node, pos: selection.from };
}

/** Per-instance factory; never a module-level singleton. */
export function createNoteAttachment(config: NoteAttachmentConfig = {}) {
  const directory = config.directory ?? null;
  const resolveUploader = config.resolveUploader ?? ((): null => null);
  const resolveFilePicker = config.resolveFilePicker ?? ((): null => null);

  return Node.create({
    name: ATTACHMENT_EXTENSION_NAME,
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
        name: {
          default: "",
          parseHTML: (element: HTMLElement) =>
            (element.getAttribute("data-name") ?? "").slice(
              0,
              NOTE_DOCUMENT_LIMITS.maxAttachmentName,
            ),
          renderHTML: (attributes: Record<string, unknown>) => ({
            "data-name": typeof attributes.name === "string" ? attributes.name : "",
          }),
        },
        mimeType: {
          default: "application/octet-stream",
          parseHTML: (element: HTMLElement) =>
            element.getAttribute("data-mime-type") ?? "application/octet-stream",
          renderHTML: (attributes: Record<string, unknown>) => ({
            "data-mime-type":
              typeof attributes.mimeType === "string"
                ? attributes.mimeType
                : "application/octet-stream",
          }),
        },
        sizeBytes: {
          default: 0,
          parseHTML: (element: HTMLElement) => {
            const parsed = Number.parseInt(element.getAttribute("data-size-bytes") ?? "", 10);
            return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
          },
          renderHTML: (attributes: Record<string, unknown>) => ({
            "data-size-bytes":
              typeof attributes.sizeBytes === "number" ? String(attributes.sizeBytes) : "0",
          }),
        },
      };
    },

    /**
     * Only an element that already carries this node's own marker is adopted.
     * A pasted `<figure>` or `<div>` from anywhere else matches nothing, so no
     * foreign markup can become an attachment card. An adopted id is still only
     * a *reference*: every read of the bytes is authorized server-side, so a
     * forged id from another workspace discloses nothing — it renders as
     * unavailable.
     */
    parseHTML() {
      return [{ tag: "div[data-notted-attachment]" }];
    },

    /**
     * ProseMirror's clipboard serializer, which has to round-trip through
     * `parseHTML`. It emits a marker `div` with `data-*` attributes rather than
     * the semantic `<figure>` the *contract's* `renderDocumentHtml` produces —
     * the same two-projection split `CustomImage.ts` records. Never a URL,
     * because the node has none to emit.
     */
    renderHTML({ HTMLAttributes }) {
      return [
        "div",
        mergeAttributes(HTMLAttributes, {
          "data-notted-attachment": "",
          class: NOTE_DOCUMENT_ATTACHMENT_CLASS,
        }),
      ];
    },

    renderText({ node }) {
      return noteDocumentAttachmentAttrs(node.attrs)?.name ?? "";
    },

    addNodeView() {
      return ({ node, editor, getPos }) => {
        const dom = createAttachmentDom();
        let current = node;

        const paint = (): void => {
          paintAttachment(dom, current, { directory, editable: editor.isEditable });
        };

        const detail = (): AttachmentEventDetail | null => {
          const attrs = noteDocumentAttachmentAttrs(current.attrs);
          if (attrs === null) return null;
          const pos = getPos?.();
          return {
            attachmentId: attrs.attachmentId,
            name: attrs.name,
            mimeType: attrs.mimeType,
            sizeBytes: attrs.sizeBytes,
            pos: typeof pos === "number" ? pos : null,
          };
        };

        const raise =
          (type: string) =>
          (event: Event): void => {
            event.preventDefault();
            event.stopPropagation();
            const payload = detail();
            if (payload === null) return;
            dom.root.dispatchEvent(
              new CustomEvent<AttachmentEventDetail>(type, {
                detail: payload,
                bubbles: true,
                // Stays inside the editor's DOM; the host listens on `view.dom`.
                composed: false,
              }),
            );
          };

        const onPreview = raise(ATTACHMENT_EVENTS.preview);
        const onRemove = raise(ATTACHMENT_EVENTS.remove);
        // A disabled download must not navigate; an enabled one is left entirely
        // to the browser so "save link as" and middle-click keep working.
        const onDownload = (event: Event): void => {
          if (dom.download.getAttribute("aria-disabled") === "true") event.preventDefault();
          event.stopPropagation();
        };

        dom.preview.addEventListener("click", onPreview);
        dom.remove.addEventListener("click", onRemove);
        dom.download.addEventListener("click", onDownload);

        paint();
        const unsubscribe = directory?.subscribe(paint) ?? null;

        return {
          dom: dom.root,
          ignoreMutation: () => true,
          update: (nextNode) => {
            if (nextNode.type.name !== ATTACHMENT_EXTENSION_NAME) return false;
            current = nextNode;
            paint();
            return true;
          },
          // Keep ProseMirror out of the card's controls entirely: without this
          // the view treats a click on a button as an editor event and moves the
          // selection out from under it before the handler runs.
          stopEvent: (event: Event) => {
            const target = event.target;
            return target instanceof HTMLElement && dom.actions.contains(target);
          },
          destroy: () => {
            dom.preview.removeEventListener("click", onPreview);
            dom.remove.removeEventListener("click", onRemove);
            dom.download.removeEventListener("click", onDownload);
            unsubscribe?.();
          },
        };
      };
    },

    addCommands() {
      return {
        setNoteAttachment:
          (attrs: NoteDocumentAttachmentAttrs) =>
          ({ commands }) =>
            commands.insertContent({ type: ATTACHMENT_EXTENSION_NAME, attrs: { ...attrs } }),

        nottedRequestAttachmentUpload:
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
      return [createAttachmentTransferPlugin(this.editor, resolveUploader)];
    },
  });
}
