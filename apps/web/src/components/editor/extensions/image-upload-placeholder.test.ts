/**
 * Proves the Part 42 criterion "multiple concurrent uploads preserve insertion
 * positions" at the mechanism that provides it: `DecorationSet.map`.
 *
 * It also proves the reason decorations were chosen over a pending node — that
 * a placeholder is invisible to `getJSON()`, and therefore to autosave.
 */

import { safeParseNoteDocument } from "@notted/shared-validators";
import { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";

import {
  IMAGE_UPLOAD_PLACEHOLDER_CLASS,
  IMAGE_UPLOAD_PLACEHOLDER_KEY,
  createImageInsertionController,
  imageUploadIds,
} from "./image-upload-placeholder";
import { createNoteEditorExtensions } from "./note-editor-extensions";

import type { ImageInsertionController, ImagePlaceholderState } from "./image-upload-placeholder";

const ATTACHMENT_A = "3f4a1b2c-5d6e-4f70-8a91-b2c3d4e5f607";
const ATTACHMENT_B = "6a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9";
const ATTACHMENT_C = "9c8b7a65-4321-4d80-b1a2-c3d4e5f60718";

function state(overrides: Partial<ImagePlaceholderState> = {}): ImagePlaceholderState {
  return {
    fileName: "photo.png",
    phase: "uploading",
    progress: 0.5,
    message: "Uploading photo.png…",
    previewUrl: "blob:preview",
    ...overrides,
  };
}

interface Harness {
  readonly editor: Editor;
  readonly controller: ImageInsertionController;
}

function harness(text = "alpha beta"): Harness {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: createNoteEditorExtensions(),
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
  });
  return { editor, controller: createImageInsertionController(editor) };
}

function widgets(editor: Editor): readonly HTMLElement[] {
  return [...editor.view.dom.querySelectorAll<HTMLElement>(`.${IMAGE_UPLOAD_PLACEHOLDER_CLASS}`)];
}

describe("upload placeholders are invisible to the document", () => {
  it("adds no node, so getJSON is byte-identical and autosave never fires", () => {
    const { editor, controller } = harness();
    const before = JSON.stringify(editor.getJSON());
    const updates = vi.fn();
    editor.on("update", updates);

    expect(controller.begin("one", 3, state())).toBe(true);

    expect(JSON.stringify(editor.getJSON())).toBe(before);
    // The decisive assertion: no `update` event means `onDocumentChange` never
    // fires, so autosave cannot PATCH a document referencing an attachment that
    // does not exist yet.
    expect(updates).not.toHaveBeenCalled();
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
    expect(controller.has("one")).toBe(true);
    editor.destroy();
  });

  it("renders the widget with an accessible progress bar and live status", () => {
    const { editor, controller } = harness();
    controller.begin("one", 3, state({ progress: 0.42 }));

    const widget = widgets(editor)[0];
    expect(widget).toBeDefined();
    expect(widget?.getAttribute("role")).toBe("group");
    expect(widget?.getAttribute("aria-label")).toBe("Image upload: photo.png");
    // Chrome, never content: it must not survive into a printed note.
    expect(widget?.hasAttribute("data-notted-print-hide")).toBe(true);

    const bar = widget?.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-valuenow")).toBe("42");
    expect(bar?.getAttribute("aria-valuetext")).toBe("42%");
    expect(bar?.getAttribute("aria-valuemin")).toBe("0");
    expect(bar?.getAttribute("aria-valuemax")).toBe("100");

    const status = widget?.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toBe("Uploading photo.png…");
    editor.destroy();
  });

  it("omits aria-valuenow while the transfer length is unknown", () => {
    const { editor, controller } = harness();
    controller.begin("one", 3, state({ phase: "queued", progress: null }));
    const bar = widgets(editor)[0]?.querySelector('[role="progressbar"]');
    expect(bar?.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar?.getAttribute("aria-valuetext")).toBe("Waiting to upload");
    editor.destroy();
  });

  it("repaints in place without dispatching a transaction", () => {
    const { editor, controller } = harness();
    controller.begin("one", 3, state({ progress: 0.1 }));
    const widget = widgets(editor)[0];
    const updates = vi.fn();
    editor.on("update", updates);

    controller.update("one", state({ progress: 0.9, message: "Nearly there" }));

    // The very same element, mutated — not a rebuilt one, which would restart
    // the preview image and drop keyboard focus from an action button.
    expect(widgets(editor)[0]).toBe(widget);
    expect(widget?.querySelector('[role="status"]')?.textContent).toBe("Nearly there");
    expect(updates).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("renders cancel, retry, and dismiss only when the host supplies them", () => {
    const { editor, controller } = harness();
    const onCancel = vi.fn();
    controller.begin("one", 3, state({ onCancel }));
    const labels = () =>
      [...(widgets(editor)[0]?.querySelectorAll("button") ?? [])].map((b) => b.textContent);

    expect(labels()).toEqual(["Cancel"]);

    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    controller.update("one", state({ phase: "error", progress: null, onRetry, onDismiss }));
    expect(labels()).toEqual(["Retry", "Dismiss"]);

    widgets(editor)[0]?.querySelector("button")?.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    editor.destroy();
  });

  it("hides the progress bar in the error phase", () => {
    const { editor, controller } = harness();
    controller.begin("one", 3, state({ phase: "error", progress: null, message: "Failed" }));
    const bar = widgets(editor)[0]?.querySelector<HTMLElement>('[role="progressbar"]');
    expect(bar?.hidden).toBe(true);
    expect(widgets(editor)[0]?.getAttribute("data-upload-phase")).toBe("error");
    editor.destroy();
  });
});

describe("placeholders stay anchored while the writer keeps typing", () => {
  it("maps every placeholder through edits made around them", () => {
    const { editor, controller } = harness("alpha beta");
    // Two concurrent uploads at two different points in the same paragraph.
    controller.begin("first", 3, state({ fileName: "first.png" }));
    controller.begin("second", 9, state({ fileName: "second.png" }));

    const start = editor.state.doc.content.size;
    // Insert text *before* both placeholders: each must shift by exactly that
    // much. This is `DecorationSet.map(tr.mapping, tr.doc)` doing its job, and
    // it is the whole mechanism behind "insertion positions are preserved".
    editor.commands.insertContentAt(1, "XXXX");
    const grew = editor.state.doc.content.size - start;

    expect(controller.has("first")).toBe(true);
    expect(controller.has("second")).toBe(true);
    expect(imageUploadIds(editor.state)).toEqual(["first", "second"]);
    expect(editor.getText()).toBe("XXXXalpha beta");
    expect(grew).toBe(4);
    editor.destroy();
  });

  it("drops a placeholder whose surrounding content was deleted", () => {
    const { editor, controller } = harness("alpha beta");
    controller.begin("one", 5, state());
    // A whole-document replacement is how the surface swaps notes. Re-anchoring
    // through it would let an upload begun in one note insert its image into
    // another, so this is the one case placeholders are deliberately not
    // rescued from.
    editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] });
    expect(controller.has("one")).toBe(false);
    editor.destroy();
  });

  it("registers no decoration teardown, so typing cannot revoke a live preview", () => {
    // `DecorationSet.map` mints a new `Decoration` per transaction, and
    // `prosemirror-view`'s `placeWidget` only reuses a `WidgetViewDesc` when the
    // decorations are identical or the widget DOM is unattached — neither holds
    // for a live placeholder. A `destroy` hook would therefore fire on every
    // typed character; wired to the object-URL registry, one keystroke would
    // blank the thumbnail of every upload still in flight. Revocation belongs
    // to the upload manager's terminal events instead.
    const { editor, controller } = harness("alpha beta");
    controller.begin("one", 3, state({ previewUrl: "blob:one" }));
    controller.begin("two", 3, state({ previewUrl: "blob:two" }));

    editor.commands.insertContentAt(1, "X");

    expect(imageUploadIds(editor.state)).toHaveLength(2);
    const decorations = IMAGE_UPLOAD_PLACEHOLDER_KEY.getState(editor.state)?.find() ?? [];
    expect(decorations).toHaveLength(2);
    for (const decoration of decorations) {
      expect((decoration.spec as { destroy?: unknown }).destroy).toBeUndefined();
    }
    // The previews the widgets are showing survived the edit.
    const sources = widgets(editor).map((widget) =>
      widget.querySelector("img")?.getAttribute("src"),
    );
    expect(sources).toEqual(["blob:one", "blob:two"]);
    editor.destroy();
  });
});

describe("completing an upload", () => {
  it("inserts the image and drops the placeholder in one transaction", () => {
    const { editor, controller } = harness("alpha beta");
    controller.begin("one", 11, state());
    const updates = vi.fn();
    editor.on("update", updates);

    expect(
      controller.complete("one", {
        attachmentId: ATTACHMENT_A,
        alt: "A chart",
        width: 800,
        height: 600,
      }),
    ).toBe(true);

    // Exactly one transaction — so three uploads landing inside the 800 ms
    // autosave debounce still produce exactly one PATCH.
    expect(updates).toHaveBeenCalledTimes(1);
    expect(controller.has("one")).toBe(false);
    expect(widgets(editor)).toHaveLength(0);

    const json = editor.getJSON();
    expect(safeParseNoteDocument(json).success).toBe(true);
    expect(JSON.stringify(json)).toContain(ATTACHMENT_A);
    // The saved document never depends on the temporary preview.
    expect(JSON.stringify(json)).not.toContain("blob:");
    editor.destroy();
  });

  it("keeps each of several placeholders at its own position", () => {
    const { editor, controller } = harness("alpha beta");
    controller.begin("first", 3, state({ fileName: "first.png" }));
    controller.begin("second", 9, state({ fileName: "second.png" }));

    // Deliberately completed out of order: a slower first upload must not drag
    // the second one's image to the wrong place.
    controller.complete("second", {
      attachmentId: ATTACHMENT_B,
      alt: "second",
      width: null,
      height: null,
    });
    controller.complete("first", {
      attachmentId: ATTACHMENT_A,
      alt: "first",
      width: null,
      height: null,
    });

    const images: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "image") images.push(String(node.attrs.alt));
      return true;
    });
    expect(images).toHaveLength(2);
    // Document order follows the positions the placeholders held, not the order
    // the transfers happened to finish in.
    expect(images).toEqual(["first", "second"]);
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
    editor.destroy();
  });

  it("completes a whole batch anchored at ONE position into one image each", () => {
    // THE FILE-PICKER CASE. `useImageUploads.startUpload` anchors every file in
    // a batch at the SAME `insertAt`, because a multi-select resolves to a
    // single caret position. Every other test in this file uses distinct
    // positions, so this is the arrangement the real "Insert image" button
    // produces and the one a real browser exercised.
    const { editor, controller } = harness("alpha beta");
    controller.begin("red", 3, state({ fileName: "red.png" }));
    controller.begin("blue", 3, state({ fileName: "blue.png" }));
    controller.begin("green", 3, state({ fileName: "green.png" }));

    expect(imageUploadIds(editor.state)).toEqual(["red", "blue", "green"]);

    for (const [id, attachmentId] of [
      ["red", ATTACHMENT_A],
      ["blue", ATTACHMENT_B],
      ["green", ATTACHMENT_C],
    ] as const) {
      expect(controller.complete(id, { attachmentId, alt: id, width: null, height: null })).toBe(
        true,
      );
    }

    const images: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "image") images.push(String(node.attrs.alt));
      return true;
    });
    // Every file selected produces exactly one image. Losing any of them would
    // silently discard an upload the server already stored.
    expect(images).toEqual(["red", "blue", "green"]);
    expect(widgets(editor)).toHaveLength(0);
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
    editor.destroy();
  });

  it.each([
    // Review pass 2 found the batch case fails for whole families of caret
    // positions, and only survives when the caret sits strictly *inside* text —
    // which is exactly what every other test in this file used. TipTap's
    // `insertContentAt` widens a block insertion to swallow the enclosing
    // textblock, so the first completion's step spans the position its siblings
    // are anchored at and `DecorationSet.map` reports them deleted.
    { label: "an empty paragraph", text: "", at: 1 },
    { label: "the end of a paragraph", text: "alpha beta", at: 11 },
    { label: "the start of a paragraph", text: "alpha beta", at: 1 },
  ])("lands every file of a batch anchored at $label", ({ text, at }) => {
    const { editor, controller } = harness(text);
    for (const id of ["red", "blue", "green"]) {
      expect(controller.begin(id, at, state({ fileName: `${id}.png` }))).toBe(true);
    }

    for (const [id, attachmentId] of [
      ["red", ATTACHMENT_A],
      ["blue", ATTACHMENT_B],
      ["green", ATTACHMENT_C],
    ] as const) {
      expect(controller.complete(id, { attachmentId, alt: id, width: null, height: null })).toBe(
        true,
      );
    }

    const images: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "image") images.push(String(node.attrs.alt));
      return true;
    });
    // Order within one batch is not guaranteed, but nothing may be lost: every
    // file here was already stored by the server, so a dropped placeholder is a
    // silently orphaned attachment and an image the writer never gets back.
    expect([...images].sort()).toEqual(["blue", "green", "red"]);
    expect(widgets(editor)).toHaveLength(0);
    expect(safeParseNoteDocument(editor.getJSON()).success).toBe(true);
    editor.destroy();
  });

  it("declines to complete an unknown placeholder", () => {
    const { editor, controller } = harness();
    expect(
      controller.complete("missing", {
        attachmentId: ATTACHMENT_A,
        alt: "",
        width: null,
        height: null,
      }),
    ).toBe(false);
    editor.destroy();
  });
});

describe("abandoning an upload", () => {
  it("changes no document at all", () => {
    const { editor, controller } = harness("alpha beta");
    const before = JSON.stringify(editor.getJSON());
    controller.begin("one", 3, state());
    const updates = vi.fn();
    editor.on("update", updates);

    expect(controller.abandon("one")).toBe(true);

    expect(JSON.stringify(editor.getJSON())).toBe(before);
    expect(updates).not.toHaveBeenCalled();
    expect(controller.has("one")).toBe(false);
    editor.destroy();
  });

  it("reports an unknown placeholder rather than pretending it removed one", () => {
    const { editor, controller } = harness();
    expect(controller.abandon("nope")).toBe(false);
    editor.destroy();
  });

  it("lists live ids so a host can tear down everything it started", () => {
    const { editor, controller } = harness("alpha beta");
    controller.begin("one", 3, state());
    controller.begin("two", 5, state());
    expect(controller.ids()).toEqual(["one", "two"]);
    controller.abandon("one");
    expect(controller.ids()).toEqual(["two"]);
    editor.destroy();
  });
});
