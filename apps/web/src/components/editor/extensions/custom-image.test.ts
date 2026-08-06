import { NOTE_DOCUMENT_IMAGE_CLASS, safeParseNoteDocument } from "@notted/shared-validators";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAttachmentDirectory } from "../attachment-directory";

import {
  IMAGE_FALLBACK_CLASS,
  IMAGE_FRAME_CLASS,
  IMAGE_LOADING_TEXT,
  IMAGE_UNAVAILABLE_TEXT,
} from "./CustomImage";
import { createNoteEditorExtensions } from "./note-editor-extensions";

import type { AttachmentDirectory, AttachmentEntry } from "../attachment-directory";
import type { ImageFilePickerRequest, ImageUploadRequest } from "./CustomImage";

const ATTACHMENT_ID = "3f4a1b2c-5d6e-4f70-8a91-b2c3d4e5f607";
const BLUR = "data:image/webp;base64,UklGRhoAAABXRUJQ";

const created: Editor[] = [];

afterEach(() => {
  while (created.length > 0) created.pop()?.destroy();
});

function entry(overrides: Partial<AttachmentEntry> = {}): AttachmentEntry {
  return {
    attachmentId: ATTACHMENT_ID,
    displayName: "chart.png",
    status: "ready",
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

function imageDocument(alt = "A chart") {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "before" }] },
      { type: "image", attrs: { attachmentId: ATTACHMENT_ID, alt, width: 1200, height: 800 } },
    ],
  };
}

interface Options {
  readonly directory?: AttachmentDirectory | null;
  readonly onUpload?: (request: ImageUploadRequest) => void;
  readonly onPick?: (request: ImageFilePickerRequest) => void;
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

  it("ignores a drop that carries no image", () => {
    const onUpload = vi.fn();
    const editor = makeEditor({ onUpload });
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
    ).toBe(false);
    expect(onUpload).not.toHaveBeenCalled();
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
    });
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
    expect(JSON.stringify(editor.getJSON())).toContain('"alt":"Inserted"');
  });
});
