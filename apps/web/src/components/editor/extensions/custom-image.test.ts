import {
  NOTE_DOCUMENT_IMAGE_CLASS,
  NOTE_DOCUMENT_LIMITS,
  safeParseNoteDocument,
} from "@notted/shared-validators";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAttachmentDirectory } from "../attachment-directory";
import { IMAGE_MIN_WIDTH_PX, IMAGE_RESIZE_STEP_PX } from "../image-resize";
import { resetReducedMotionForTests } from "../reduced-motion";

import {
  IMAGE_CAPTION_COMMIT_DELAY_MS,
  IMAGE_CAPTION_INPUT_CLASS,
  IMAGE_CAPTION_LABEL,
  IMAGE_CAPTION_PLACEHOLDER,
  IMAGE_CAPTION_TEXT_CLASS,
  IMAGE_FALLBACK_CLASS,
  IMAGE_FRAME_CLASS,
  IMAGE_HANDLE_CLASS,
  IMAGE_LOADING_TEXT,
  IMAGE_STATUS_CLASS,
  IMAGE_UNAVAILABLE_TEXT,
} from "./CustomImage";
import { createNoteEditorExtensions } from "./note-editor-extensions";

import type { AttachmentDirectory, AttachmentEntry } from "../attachment-directory";
import type { AttachmentUploadRequest } from "./CustomAttachment";
import type { ImageFilePickerRequest, ImageUploadRequest } from "./CustomImage";

const ATTACHMENT_ID = "3f4a1b2c-5d6e-4f70-8a91-b2c3d4e5f607";
const BLUR = "data:image/webp;base64,UklGRhoAAABXRUJQ";

const created: Editor[] = [];

afterEach(() => {
  while (created.length > 0) created.pop()?.destroy();
  vi.unstubAllGlobals();
  resetReducedMotionForTests();
});

function entry(overrides: Partial<AttachmentEntry> = {}): AttachmentEntry {
  return {
    attachmentId: ATTACHMENT_ID,
    displayName: "chart.png",
    status: "ready",
    // Part 44 made these five required on `AttachmentEntry`: the card renders a
    // generic file from the authorized row, not from the document node.
    mediaType: "image",
    mimeType: "image/png",
    sizeBytes: 4096,
    createdAt: "2026-01-12T00:00:00.000Z",
    contentUrl: "http://api.test/api/v1/workspaces/w/attachments/a/content?variant=full",
    width: 1200,
    height: 800,
    blurDataUri: BLUR,
    sources: {
      full: "http://api.test/api/v1/workspaces/w/attachments/a/content?variant=full",
      medium: "http://api.test/api/v1/workspaces/w/attachments/a/content?variant=medium",
      thumbnail: "http://api.test/api/v1/workspaces/w/attachments/a/content?variant=thumbnail",
    },
    ...overrides,
  };
}

function imageDocument(alt = "A chart", attrs: Record<string, unknown> = {}) {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "before" }] },
      {
        type: "image",
        attrs: { attachmentId: ATTACHMENT_ID, alt, width: 1200, height: 800, ...attrs },
      },
    ],
  };
}

function figureOf(editor: Editor): HTMLElement {
  const figure = editor.view.dom.querySelector<HTMLElement>(".notted-image-figure");
  if (figure === null) throw new Error("no image figure was rendered");
  return figure;
}

function imageAttrs(editor: Editor): Record<string, unknown> {
  // Collected into an array rather than a nullable local: TypeScript does not
  // track assignments made inside a callback, so a `let x: T | null = null`
  // would still read as `null` after `descendants` returned.
  const found: Record<string, unknown>[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "image") found.push({ ...node.attrs });
    return true;
  });
  const attrs = found[0];
  if (attrs === undefined) throw new Error("no image node in the document");
  return attrs;
}

function selectTheImage(editor: Editor): number {
  let target = -1;
  editor.state.doc.descendants((node, pos) => {
    if (target === -1 && node.type.name === "image") target = pos;
    return target === -1;
  });
  if (target === -1) throw new Error("no image node in the document");
  editor.commands.setNodeSelection(target);
  return target;
}

/**
 * jsdom implements no `PointerEvent`, so the gesture is driven with
 * `MouseEvent`s carrying the pointer event names. The handlers only read
 * `clientX`/`clientY`/`shiftKey`, which `MouseEvent` provides; what a real
 * pointer does at 125 % zoom is asserted in Playwright.
 */
function pointer(
  target: EventTarget,
  type: string,
  init: { readonly clientX: number; readonly clientY: number; readonly shiftKey?: boolean },
): void {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: init.clientX,
      clientY: init.clientY,
      shiftKey: init.shiftKey ?? false,
    }),
  );
}

function captionInput(editor: Editor): HTMLInputElement {
  const input = editor.view.dom.querySelector<HTMLInputElement>(`.${IMAGE_CAPTION_INPUT_CLASS}`);
  if (input === null) throw new Error("no caption field was rendered");
  return input;
}

interface Options {
  readonly directory?: AttachmentDirectory | null;
  readonly onUpload?: (request: ImageUploadRequest) => void;
  readonly onPick?: (request: ImageFilePickerRequest) => void;
  readonly onAttachmentUpload?: (request: AttachmentUploadRequest) => void;
  readonly content?: unknown;
}

function makeEditor(options: Options = {}): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: createNoteEditorExtensions({
      attachmentDirectory: options.directory ?? null,
      resolveImageUploader: () => options.onUpload ?? null,
      resolveImageFilePicker: () => options.onPick ?? null,
      resolveAttachmentUploader: () => options.onAttachmentUpload ?? null,
    }),
    content: options.content ?? { type: "doc", content: [{ type: "paragraph" }] },
  });
  created.push(editor);
  return editor;
}

function file(name: string, type: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

/**
 * jsdom implements neither `DataTransfer` nor a usable `ClipboardEvent`, so the
 * payload is supplied structurally — the same reason `imageFilesFromDataTransfer`
 * is a pure function over `DataTransferLike`. The browser-side truth (that a real
 * paste and a real drop populate this object at all) is covered in Playwright.
 */
function fakeTransfer(files: readonly File[], html?: string) {
  return {
    items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
    files,
    types: html === undefined ? ["Files"] : ["Files", "text/html"],
    // Honour the requested type. A `getData` that returns the HTML for EVERY
    // type is not what a real DataTransfer does, and it breaks the case where
    // CustomImage correctly declines a Word paste: the payload then falls
    // through to `@tiptap/extension-code-block`, which calls
    // `JSON.parse(getData("vscode-editor-data"))` and throws on the HTML.
    getData: (type: string) => (type === "text/html" ? (html ?? "") : ""),
    dropEffect: "none",
  };
}

function paste(editor: Editor, transfer: unknown): boolean {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: transfer });
  return (
    editor.view.someProp("handlePaste", (fn) => fn(editor.view, event as never, null as never)) ===
    true
  );
}

function drop(
  editor: Editor,
  transfer: unknown,
  coords: { readonly clientX: number; readonly clientY: number },
  moved = false,
): boolean {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: transfer });
  Object.defineProperty(event, "clientX", { value: coords.clientX });
  Object.defineProperty(event, "clientY", { value: coords.clientY });
  return (
    editor.view.someProp("handleDrop", (fn) =>
      fn(editor.view, event as never, null as never, moved),
    ) === true
  );
}

describe("image node rendering", () => {
  it("renders a frame with the aspect ratio and blur before any bytes arrive", () => {
    const directory = createAttachmentDirectory([entry()]);
    const editor = makeEditor({ directory, content: imageDocument() });

    const frame = editor.view.dom.querySelector<HTMLElement>(`.${IMAGE_FRAME_CLASS}`);
    expect(frame).not.toBeNull();
    // Reserved before the network is touched: this is the whole anti-layout-shift
    // measure, and it is why the intrinsic size is stored on the node.
    expect(frame?.style.aspectRatio).toBe("1200 / 800");
    expect(frame?.style.backgroundImage).toContain(BLUR);

    const image = editor.view.dom.querySelector<HTMLImageElement>(`.${NOTE_DOCUMENT_IMAGE_CLASS}`);
    expect(image?.getAttribute("src")).toBe(entry().sources.full);
    expect(image?.getAttribute("alt")).toBe("A chart");
    expect(image?.getAttribute("loading")).toBe("lazy");
    expect(image?.getAttribute("decoding")).toBe("async");
  });

  it("keeps an empty alt verbatim for a decorative image", () => {
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument(""),
    });
    const image = editor.view.dom.querySelector<HTMLImageElement>(`.${NOTE_DOCUMENT_IMAGE_CLASS}`);
    expect(image?.getAttribute("alt")).toBe("");
  });

  it("says loading — never deleted — while metadata is unavailable", () => {
    // An unavailable list is not evidence that an attachment was removed.
    const editor = makeEditor({ directory: createAttachmentDirectory(), content: imageDocument() });
    const figure = editor.view.dom.querySelector<HTMLElement>(".notted-image-figure");
    expect(figure?.getAttribute("data-image-state")).toBe("unknown");
    expect(figure?.getAttribute("aria-busy")).toBe("true");
    expect(figure?.querySelector(`.${IMAGE_FALLBACK_CLASS}`)?.textContent).toBe(IMAGE_LOADING_TEXT);
  });

  it("reports a genuinely missing attachment with an accessible fallback", () => {
    const editor = makeEditor({
      directory: createAttachmentDirectory([]),
      content: imageDocument("A chart"),
    });
    const fallback = editor.view.dom.querySelector<HTMLElement>(`.${IMAGE_FALLBACK_CLASS}`);
    expect(fallback?.hidden).toBe(false);
    expect(fallback?.textContent).toBe(IMAGE_UNAVAILABLE_TEXT);
    // The author's text alternative is still exposed, so the reader learns what
    // the image was meant to show.
    expect(fallback?.getAttribute("role")).toBe("img");
    expect(fallback?.getAttribute("aria-label")).toBe("A chart");
  });

  it("hides the fallback from assistive technology for a decorative image", () => {
    const editor = makeEditor({
      directory: createAttachmentDirectory([]),
      content: imageDocument(""),
    });
    const fallback = editor.view.dom.querySelector<HTMLElement>(`.${IMAGE_FALLBACK_CLASS}`);
    expect(fallback?.getAttribute("aria-hidden")).toBe("true");
    expect(fallback?.hasAttribute("role")).toBe(false);
  });

  it("repaints when the directory later resolves the attachment", () => {
    const directory = createAttachmentDirectory();
    const editor = makeEditor({ directory, content: imageDocument() });
    expect(editor.view.dom.querySelector(`.${IMAGE_FALLBACK_CLASS}`)?.hasAttribute("hidden")).toBe(
      false,
    );

    directory.setEntries([entry()]);

    const image = editor.view.dom.querySelector<HTMLImageElement>(`.${NOTE_DOCUMENT_IMAGE_CLASS}`);
    expect(image?.getAttribute("src")).toBe(entry().sources.full);
  });

  it("refuses a blur value that is not a bounded image data URI", () => {
    const directory = createAttachmentDirectory([
      entry({ blurDataUri: 'x"); background-image: url(https://evil.test/beacon.png' }),
    ]);
    const editor = makeEditor({ directory, content: imageDocument() });
    const frame = editor.view.dom.querySelector<HTMLElement>(`.${IMAGE_FRAME_CLASS}`);
    expect(frame?.style.backgroundImage).toBe("");
  });

  it("never writes a src into the document", () => {
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument(),
    });
    const json = JSON.stringify(editor.getJSON());
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
    expect(json).toContain(ATTACHMENT_ID);
    expect(json).not.toContain("http://api.test");
    expect(json).not.toContain("src");
  });
});

describe("paste", () => {
  it("consumes a screenshot paste and asks the host to upload it", () => {
    const onUpload = vi.fn();
    const editor = makeEditor({ onUpload });
    const image = file("shot.png", "image/png");

    expect(paste(editor, fakeTransfer([image]))).toBe(true);
    expect(onUpload).toHaveBeenCalledTimes(1);
    const request = onUpload.mock.calls[0]?.[0] as ImageUploadRequest;
    expect(request.files).toEqual([image]);
    expect(request.insertAt).toBe(editor.state.selection.from);
    expect(typeof request.controller.begin).toBe("function");
  });

  it("declines a Word paste that carries an inline image alongside real HTML", () => {
    // Consuming this as an upload would silently throw the document away.
    const onUpload = vi.fn();
    const editor = makeEditor({ onUpload });
    expect(
      paste(
        editor,
        fakeTransfer([file("inline.png", "image/png")], "<p>Quarterly results</p><img>"),
      ),
    ).toBe(false);
    expect(onUpload).not.toHaveBeenCalled();
  });

  it("declines a plain text paste", () => {
    const onUpload = vi.fn();
    const editor = makeEditor({ onUpload });
    expect(paste(editor, { items: [], files: [], types: ["text/plain"], getData: () => "" })).toBe(
      false,
    );
    expect(onUpload).not.toHaveBeenCalled();
  });

  it("declines when no upload host is wired at all", () => {
    const editor = makeEditor();
    expect(paste(editor, fakeTransfer([file("a.png", "image/png")]))).toBe(false);
  });
});

describe("drop", () => {
  it("uploads dropped files at the position under the pointer", () => {
    const onUpload = vi.fn();
    const editor = makeEditor({
      onUpload,
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
      },
    });
    // jsdom reports every rect as zero, so `posAtCoords` finds nothing and the
    // handler falls back to the selection. Where a *real* pointer lands — at
    // 125 % zoom in particular — is asserted in `e2e/note-images.spec.ts`.
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 2, inside: 1 });

    expect(
      drop(editor, fakeTransfer([file("d.png", "image/png")]), { clientX: 40, clientY: 60 }),
    ).toBe(true);
    expect((onUpload.mock.calls[0]?.[0] as ImageUploadRequest).insertAt).toBe(2);
  });

  it("ignores a node dragged within the document, so an image is never re-uploaded", () => {
    const onUpload = vi.fn();
    const editor = makeEditor({ onUpload });
    expect(
      drop(editor, fakeTransfer([file("d.png", "image/png")]), { clientX: 0, clientY: 0 }, true),
    ).toBe(false);
    expect(onUpload).not.toHaveBeenCalled();
  });

  /**
   * Part 44 changed what "no image" means. A `.txt` drop is no longer inert —
   * it is a legitimate ATTACHMENT, handled by `CustomAttachment`'s transfer
   * plugin. So the "nothing happens" case has to be a file on NEITHER
   * allow-list, and the file that used to stand for it gets its own assertion
   * below.
   */
  it("ignores a drop whose file is on neither allow-list", () => {
    const onUpload = vi.fn();
    const onAttachmentUpload = vi.fn();
    const editor = makeEditor({ onUpload, onAttachmentUpload });
    expect(
      drop(
        editor,
        {
          items: [],
          files: [file("installer.exe", "application/octet-stream")],
          types: ["Files"],
          getData: () => "",
        },
        { clientX: 0, clientY: 0 },
      ),
    ).toBe(false);
    expect(onUpload).not.toHaveBeenCalled();
    expect(onAttachmentUpload).not.toHaveBeenCalled();
  });

  it("routes a dropped text file to the attachment uploader, not the image one", () => {
    const onUpload = vi.fn();
    const onAttachmentUpload = vi.fn();
    const editor = makeEditor({ onUpload, onAttachmentUpload });
    // `CustomAttachment.handleDrop` calls `posAtCoords`, which reaches
    // `document.elementFromPoint` — absent in jsdom. Stubbing it is what lets
    // this path run at all in a unit test; where a real pointer lands is
    // asserted in `e2e/note-images.spec.ts`.
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 });

    expect(
      drop(
        editor,
        {
          items: [],
          files: [file("notes.txt", "text/plain")],
          types: ["Files"],
          getData: () => "",
        },
        { clientX: 0, clientY: 0 },
      ),
    ).toBe(true);
    expect(onUpload).not.toHaveBeenCalled();
    expect(onAttachmentUpload).toHaveBeenCalledTimes(1);
    const request = onAttachmentUpload.mock.calls[0]?.[0] as AttachmentUploadRequest;
    expect(request.files.map((entry) => entry.name)).toEqual(["notes.txt"]);
    expect(request.insertAt).toBe(1);
  });
});

describe("the file-picker command", () => {
  it("reports the caret position and a controller, and inserts nothing", () => {
    const onPick = vi.fn();
    const editor = makeEditor({
      onPick,
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "abc" }] }],
      },
    });
    editor.commands.setTextSelection(3);

    expect(editor.commands.nottedRequestImageUpload()).toBe(true);
    expect(onPick).toHaveBeenCalledTimes(1);
    const request = onPick.mock.calls[0]?.[0] as ImageFilePickerRequest;
    expect(request.insertAt).toBe(3);
    expect(typeof request.controller.begin).toBe("function");
    expect(editor.getJSON()).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { textAlign: null },
          content: [{ type: "text", text: "abc" }],
        },
      ],
    });
  });

  it("is unavailable without a host, and reports availability without side effects", () => {
    const editor = makeEditor();
    expect(editor.can().nottedRequestImageUpload()).toBe(false);
    expect(editor.commands.nottedRequestImageUpload()).toBe(false);

    const onPick = vi.fn();
    const wired = makeEditor({ onPick });
    expect(wired.can().nottedRequestImageUpload()).toBe(true);
    // `can()` must never open a file dialog.
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe("setNoteImage", () => {
  it("inserts a contract-valid image node", () => {
    const editor = makeEditor();
    editor.commands.setNoteImage({
      attachmentId: ATTACHMENT_ID,
      alt: "Inserted",
      width: 640,
      height: 480,
      align: "center",
      wrap: "block",
      fullWidth: false,
      caption: "",
    });
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
    expect(JSON.stringify(editor.getJSON())).toContain('"alt":"Inserted"');
  });
});

/* -------------------------------------------------------------------------- */
/* Part 43                                                                      */
/* -------------------------------------------------------------------------- */

describe("Part 43 layout attributes", () => {
  it("defaults a Part 42 document to centred, block, not full width, no caption", () => {
    // The load-bearing compatibility check: ProseMirror fills in every declared
    // attribute, so the editor's own output for a pre-Part-43 document must
    // still be something the contract accepts. If it were not, `onDocumentChange`
    // would stop firing and autosave would go silent for the whole session.
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument(),
    });
    expect(imageAttrs(editor)).toMatchObject({
      align: "center",
      wrap: "block",
      fullWidth: false,
      caption: "",
    });
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
  });

  it("projects alignment, wrap, and full width onto the figure", () => {
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument("A chart", { align: "right", wrap: "inline", caption: "Figure 1" }),
    });
    const figure = figureOf(editor);
    expect(figure.tagName).toBe("FIGURE");
    expect(figure.getAttribute("data-align")).toBe("right");
    expect(figure.getAttribute("data-wrap")).toBe("inline");
    expect(figure.getAttribute("data-full-width")).toBe("false");
    expect(figure.getAttribute("data-has-caption")).toBe("true");
    expect(figure.querySelector(`.${IMAGE_CAPTION_TEXT_CLASS}`)?.textContent).toBe("Figure 1");
  });

  it("resolves full width against inline wrap, deterministically and in one place", () => {
    // Both values are stored verbatim — rejecting the pair would let the editor
    // build a document the API refuses — and `resolveNoteImageWrap` decides that
    // a figure spanning the whole column cannot also be a float.
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument("A chart", { wrap: "inline", fullWidth: true }),
    });
    expect(imageAttrs(editor)).toMatchObject({ wrap: "inline", fullWidth: true });
    expect(figureOf(editor).getAttribute("data-wrap")).toBe("block");
    expect(figureOf(editor).getAttribute("data-full-width")).toBe("true");
  });

  it("sizes the figure from the stored width, and hands sizing back for full width", () => {
    const sized = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument("A chart", { width: 320, height: 240 }),
    });
    expect(figureOf(sized).style.width).toBe("320px");
    expect(figureOf(sized).getAttribute("data-image-sized")).toBe("true");

    const full = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument("A chart", { width: 320, height: 240, fullWidth: true }),
    });
    expect(full.view.dom.querySelector<HTMLElement>(".notted-image-figure")?.style.width).toBe("");
    expect(figureOf(full).getAttribute("data-image-sized")).toBe("false");
  });

  it("marks the figure editable so read-only notes show text instead of a field", () => {
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument("A chart", { caption: "Figure 1" }),
    });
    expect(figureOf(editor).getAttribute("data-image-editable")).toBe("true");
    expect(captionInput(editor).disabled).toBe(false);
  });
});

describe("Part 43 caption field", () => {
  it("is a labelled, bounded text field with a placeholder", () => {
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument(),
    });
    const input = captionInput(editor);
    expect(input.getAttribute("aria-label")).toBe(IMAGE_CAPTION_LABEL);
    expect(input.placeholder).toBe(IMAGE_CAPTION_PLACEHOLDER);
    expect(input.maxLength).toBe(NOTE_DOCUMENT_LIMITS.maxImageCaption);
    // Chrome, not content: the committed text is what prints.
    expect(input.hasAttribute("data-notted-print-hide")).toBe(true);
  });

  it("commits on Enter and keeps the key away from the ProseMirror keymap", () => {
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument(),
    });
    const input = captionInput(editor);
    input.value = "Quarterly revenue";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(imageAttrs(editor).caption).toBe("Quarterly revenue");
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
    // Enter never reached the editor, so no block was split.
    expect(editor.state.doc.childCount).toBe(2);
  });

  it("commits on blur", () => {
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument(),
    });
    const input = captionInput(editor);
    input.value = "Committed on blur";
    input.dispatchEvent(new Event("blur", { bubbles: false }));
    expect(imageAttrs(editor).caption).toBe("Committed on blur");
  });

  it("restores the stored caption on Escape without writing anything", () => {
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument("A chart", { caption: "Original" }),
    });
    const input = captionInput(editor);
    input.value = "Half typed";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(input.value).toBe("Original");
    expect(imageAttrs(editor).caption).toBe("Original");
  });
});

describe("Part 43 caption debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes once after typing stops, never per keystroke", () => {
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument(),
    });
    const updates = vi.fn();
    editor.on("update", updates);
    const input = captionInput(editor);

    for (const value of ["F", "Fi", "Fig"]) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    // Nothing has reached the document yet: a per-keystroke write would push one
    // undo step and re-arm Part 39's autosave debounce on every character.
    expect(updates).not.toHaveBeenCalled();
    expect(imageAttrs(editor).caption).toBe("");

    vi.advanceTimersByTime(IMAGE_CAPTION_COMMIT_DELAY_MS);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(imageAttrs(editor).caption).toBe("Fig");
  });

  it("commits a half-typed caption when the editor is torn down", () => {
    // Type a caption, then click a sidebar link: the in-app navigation unmounts
    // the editor before the debounce fires, and removing a focused input fires
    // no blur. Discarding the timer here loses the caption with no transaction,
    // so it reaches neither the document nor autosave.
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument(),
    });
    const input = captionInput(editor);
    input.value = "Typed then navigated away";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(imageAttrs(editor).caption).toBe("");

    const committed = vi.fn();
    editor.on("update", committed);
    editor.destroy();

    expect(committed).toHaveBeenCalledOnce();
  });

  it("does not write when the value is unchanged", () => {
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument("A chart", { caption: "Same" }),
    });
    const updates = vi.fn();
    editor.on("update", updates);
    const input = captionInput(editor);
    input.value = "Same";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(IMAGE_CAPTION_COMMIT_DELAY_MS);
    expect(updates).not.toHaveBeenCalled();
  });
});

describe("Part 43 pointer resize", () => {
  function handleOf(editor: Editor, corner: string): HTMLElement {
    const handle = editor.view.dom.querySelector<HTMLElement>(
      `.${IMAGE_HANDLE_CLASS}[data-image-handle="${corner}"]`,
    );
    if (handle === null) throw new Error(`no ${corner} handle was rendered`);
    return handle;
  }

  it("renders four presentational corner handles that never print", () => {
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument(),
    });
    const handles = editor.view.dom.querySelectorAll(`.${IMAGE_HANDLE_CLASS}`);
    expect(handles).toHaveLength(4);
    for (const handle of handles) expect(handle.getAttribute("aria-hidden")).toBe("true");
    expect(
      editor.view.dom
        .querySelector(".notted-image-handles")
        ?.hasAttribute("data-notted-print-hide"),
    ).toBe(true);
  });

  it("previews during the drag and commits exactly once on release", () => {
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument(),
    });
    const updates = vi.fn();
    editor.on("update", updates);

    pointer(handleOf(editor, "se"), "pointerdown", { clientX: 0, clientY: 0 });
    pointer(window, "pointermove", { clientX: 50, clientY: 0 });
    pointer(window, "pointermove", { clientX: 100, clientY: 0 });

    // A live preview is a direct style mutation, so nothing has been written.
    expect(figureOf(editor).style.width).toBe("1300px");
    expect(updates).not.toHaveBeenCalled();

    pointer(window, "pointerup", { clientX: 100, clientY: 0 });

    // One write for the whole gesture, so one undo step.
    expect(updates).toHaveBeenCalledTimes(1);
    expect(imageAttrs(editor)).toMatchObject({ width: 1300, height: 867 });
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
  });

  it("keeps the aspect ratio locked unless Shift is held, sampled live", () => {
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument(),
    });
    pointer(handleOf(editor, "se"), "pointerdown", { clientX: 0, clientY: 0 });
    // Shift was NOT held at pointer-down; it is pressed mid-drag and must be
    // honoured on the very next sample.
    pointer(window, "pointermove", { clientX: 100, clientY: -200, shiftKey: true });
    pointer(window, "pointerup", { clientX: 100, clientY: -200, shiftKey: true });
    expect(imageAttrs(editor)).toMatchObject({ width: 1300, height: 600 });
  });

  it("restores the pre-drag size when Escape cancels the gesture", () => {
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument("A chart", { width: 400, height: 300 }),
    });
    const updates = vi.fn();
    editor.on("update", updates);

    pointer(handleOf(editor, "se"), "pointerdown", { clientX: 0, clientY: 0 });
    pointer(window, "pointermove", { clientX: 120, clientY: 0 });
    expect(figureOf(editor).style.width).toBe("520px");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(figureOf(editor).style.width).toBe("400px");
    expect(updates).not.toHaveBeenCalled();
    expect(imageAttrs(editor)).toMatchObject({ width: 400, height: 300 });

    // The gesture really ended: further movement changes nothing.
    pointer(window, "pointermove", { clientX: 400, clientY: 0 });
    expect(figureOf(editor).style.width).toBe("400px");
  });

  it("clamps a drag to the contract bound when there is no page to measure", () => {
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument(),
    });
    pointer(handleOf(editor, "se"), "pointerdown", { clientX: 0, clientY: 0 });
    pointer(window, "pointerup", { clientX: 100_000, clientY: 0 });
    expect(imageAttrs(editor).width).toBe(NOTE_DOCUMENT_LIMITS.maxImageDimension);
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
  });
});

describe("Part 43 keyboard resize", () => {
  it("steps the selected image and announces the new size", () => {
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument("A chart", { width: 400, height: 200 }),
    });
    selectTheImage(editor);

    expect(editor.commands.nottedResizeSelectedImage(IMAGE_RESIZE_STEP_PX)).toBe(true);
    expect(imageAttrs(editor)).toMatchObject({ width: 432, height: 216 });
    expect(editor.view.dom.querySelector(`.${IMAGE_STATUS_CLASS}`)?.textContent).toContain("432");
  });

  it("never narrows below the minimum", () => {
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument("A chart", { width: 56, height: 28 }),
    });
    selectTheImage(editor);
    editor.commands.nottedResizeSelectedImage(-IMAGE_RESIZE_STEP_PX);
    expect(imageAttrs(editor).width).toBe(IMAGE_MIN_WIDTH_PX);
  });

  it("declines when no image is selected, so the browser keeps the key", () => {
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument(),
    });
    editor.commands.setTextSelection(2);
    expect(editor.commands.nottedResizeSelectedImage(IMAGE_RESIZE_STEP_PX)).toBe(false);
  });
});

describe("Part 43 reduced motion", () => {
  function stubReducedMotion(matches: boolean): void {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduce") && matches,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    resetReducedMotionForTests();
  }

  it("loads the static medium rendition when the reader prefers reduced motion", () => {
    // Part 41 renders `medium` as a static first-frame poster and preserves
    // animation only in `full`, so this is how an animated GIF stops animating
    // without re-processing anything (WCAG 2.2.2).
    stubReducedMotion(true);
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument(),
    });
    const image = editor.view.dom.querySelector<HTMLImageElement>(`.${NOTE_DOCUMENT_IMAGE_CLASS}`);
    expect(image?.getAttribute("src")).toBe(entry().sources.medium);
  });

  it("loads the full rendition otherwise", () => {
    stubReducedMotion(false);
    const editor = makeEditor({
      directory: createAttachmentDirectory([entry()]),
      content: imageDocument(),
    });
    const image = editor.view.dom.querySelector<HTMLImageElement>(`.${NOTE_DOCUMENT_IMAGE_CLASS}`);
    expect(image?.getAttribute("src")).toBe(entry().sources.full);
  });
});
