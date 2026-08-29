import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useImageUploads } from "./useImageUploads";

import type { ImageUploadFileInputHandle } from "./ImageUploadFileInput";
import type { ImageInsertionController } from "@/components/editor/extensions/image-upload-placeholder";
import type { AttachmentMedia } from "@notted/shared-types";
import type { ReactNode, RefObject } from "react";

import { createAttachmentDirectory } from "@/components/editor/attachment-directory";
import { createImageInsertionController } from "@/components/editor/extensions/image-upload-placeholder";
import { createNoteEditorExtensions } from "@/components/editor/extensions/note-editor-extensions";
import { noteQueryKeys } from "@/lib/notes/query-keys";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const noteId = "30000000-0000-4000-8000-000000000002";
const attachmentId = "30000000-0000-4000-8000-000000000003";

const uploadMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/notes/upload-request", () => ({ uploadNoteImage: uploadMock }));
vi.mock("@/lib/notes/attachment-requests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notes/attachment-requests")>();
  return { ...actual, deleteAttachment: deleteMock };
});

function media(overrides: Partial<AttachmentMedia> = {}): AttachmentMedia {
  return {
    id: attachmentId,
    workspaceId,
    noteId,
    displayName: "chart.png",
    mimeType: "image/png",
    sizeBytes: 4096,
    status: "ready",
    width: 1200,
    height: 800,
    createdAt: "2026-08-06T00:00:00.000Z",
    mediaType: "image",
    variants: {
      full: { width: 1200, height: 800, bytes: 900, mimeType: "image/png" },
      blur: { dataUri: "data:image/webp;base64,AAAA", width: 16, height: 11 },
    },
    contentPath: `/api/v1/workspaces/${workspaceId}/attachments/${attachmentId}/content`,
    ...overrides,
  };
}

function pngFile(name = "chart.png", type = "image/png", size = 2048): File {
  const file = new File([new Uint8Array([1])], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

/** Records every call the hook makes into the editor, and nothing else. */
function fakeController() {
  const begun: Array<{ id: string; pos: number; state: unknown }> = [];
  const updated: Array<{ id: string; state: { phase: string; message: string } }> = [];
  const completed: Array<{ id: string; attrs: Record<string, unknown> }> = [];
  // Part 44. Kept separate from `completed` on purpose: the whole point of the
  // second method is that a file and an image must never take one another's
  // insertion path, and one shared array could not prove that.
  const completedAttachments: Array<{ id: string; attrs: Record<string, unknown> }> = [];
  const abandoned: string[] = [];
  const controller: ImageInsertionController = {
    begin: (id, pos, state) => {
      begun.push({ id, pos, state });
      return true;
    },
    update: (id, state) => {
      updated.push({ id, state: { phase: state.phase, message: state.message } });
      return true;
    },
    complete: (id, attrs) => {
      completed.push({ id, attrs: { ...attrs } });
      return true;
    },
    completeAttachment: (id, attrs) => {
      completedAttachments.push({ id, attrs: { ...attrs } });
      return true;
    },
    abandon: (id) => {
      abandoned.push(id);
      return true;
    },
    has: () => true,
    ids: () => [],
  };
  return { controller, begun, updated, completed, completedAttachments, abandoned };
}

/** The hook hands back a `RefObject`, whose `current` React types as readonly. */
function mutableRef(ref: RefObject<ImageUploadFileInputHandle | null>): {
  current: ImageUploadFileInputHandle | null;
} {
  return ref as { current: ImageUploadFileInputHandle | null };
}

function setup(editable = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const directory = createAttachmentDirectory();
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useImageUploads({ workspaceId, noteId, directory, editable }), {
    wrapper,
  });
  return { ...view, client, directory };
}

beforeEach(() => {
  uploadMock.mockReset();
  deleteMock.mockReset();
  deleteMock.mockResolvedValue({ ok: true, data: { id: attachmentId, deleted: true } });
  // Older jsdom builds ship no object-URL support at all; supply it only when
  // it is genuinely absent so a real implementation is never shadowed.
  const url = globalThis.URL as unknown as Record<string, unknown>;
  if (typeof url.createObjectURL !== "function") {
    url.createObjectURL = (): string => "blob:preview";
    url.revokeObjectURL = (): void => undefined;
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useImageUploads", () => {
  it("places a placeholder per file at the requested position", async () => {
    uploadMock.mockReturnValue(new Promise(() => undefined));
    const { result } = setup();
    const { controller, begun } = fakeController();

    act(() => {
      result.current.uploadImages({
        files: [pngFile("a.png"), pngFile("b.png"), pngFile("c.png")],
        insertAt: 7,
        controller,
      });
    });

    expect(begun).toHaveLength(3);
    // Every placeholder in one batch is anchored at the drop point; the
    // decoration set keeps them there from that moment on.
    expect(begun.every((entry) => entry.pos === 7)).toBe(true);
    expect(new Set(begun.map((entry) => entry.id)).size).toBe(3);
    // Concurrency is bounded, so only three sockets open even for a bigger batch.
    expect(uploadMock).toHaveBeenCalledTimes(3);
  });

  it("seeds the directory before swapping, so the image never flashes empty", async () => {
    uploadMock.mockResolvedValue({ ok: true, data: media() });
    const { result, directory } = setup();
    const { controller, completed } = fakeController();
    const seenAtCompletion: string[] = [];
    const originalComplete = controller.complete.bind(controller);
    const spying: ImageInsertionController = {
      ...controller,
      complete: (id, attrs) => {
        seenAtCompletion.push(directory.resolve(attachmentId).kind);
        return originalComplete(id, attrs);
      },
    };

    await act(async () => {
      result.current.uploadImages({ files: [pngFile()], insertAt: 3, controller: spying });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(completed).toHaveLength(1));
    expect(seenAtCompletion).toEqual(["ready"]);
    expect(completed[0]?.attrs).toEqual({
      attachmentId,
      alt: "chart",
      width: 1200,
      height: 800,
    });
  });

  it("lands one image per file when a whole batch uploads into a REAL editor", async () => {
    // The Playwright-observed case, reproduced at unit speed. Every other test
    // here uses `fakeController`, which records calls and can never lose a node;
    // this one drives the real ProseMirror controller, because the defect only
    // exists in the interaction between the two.
    const ids = [
      "40000000-0000-4000-8000-00000000000a",
      "40000000-0000-4000-8000-00000000000b",
      "40000000-0000-4000-8000-00000000000c",
    ] as const;
    let call = 0;
    // Each upload settles in its OWN task, exactly as three independent network
    // responses do. Resolving them together would hide any re-render that
    // happens between completions.
    uploadMock.mockImplementation(async () => {
      const id = ids[call] ?? ids[0];
      call += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { ok: true, data: media({ id, displayName: `${id}.png` }) };
    });

    const element = document.createElement("div");
    document.body.append(element);
    const editor = new Editor({
      element,
      extensions: createNoteEditorExtensions(),
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Figures below." }] }],
      },
    });
    const controller = createImageInsertionController(editor);
    const { result } = setup();

    await act(async () => {
      result.current.uploadImages({
        files: [pngFile("red.png"), pngFile("blue.png"), pngFile("green.png")],
        insertAt: 3,
        controller,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const inserted: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "image") inserted.push(String(node.attrs.attachmentId));
      return true;
    });
    // Three files uploaded and three rows exist on the server, so three images
    // must exist in the document. Anything fewer silently discards an upload.
    expect(inserted).toHaveLength(3);
    expect(new Set(inserted).size).toBe(3);
    editor.destroy();
  });

  it("caches the attachment under the note's query key", async () => {
    uploadMock.mockResolvedValue({ ok: true, data: media() });
    const { result, client } = setup();
    const { controller, completed } = fakeController();

    await act(async () => {
      result.current.uploadImages({ files: [pngFile()], insertAt: 1, controller });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(completed).toHaveLength(1));
    // The cached page carries the server's truncation quartet alongside the
    // items; a locally added upload does not change what the server truncated.
    expect(client.getQueryData(noteQueryKeys.attachments(workspaceId, noteId))).toMatchObject({
      items: [media()],
      returned: 1,
      truncated: false,
    });
  });

  it("surfaces a retryable failure with a Retry action and no document change", async () => {
    uploadMock.mockResolvedValue({ ok: false, kind: "unavailable", retryable: true });
    const { result } = setup();
    const { controller, updated, completed, abandoned } = fakeController();

    await act(async () => {
      result.current.uploadImages({ files: [pngFile()], insertAt: 1, controller });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(updated.some((entry) => entry.state.phase === "error")).toBe(true));
    expect(completed).toHaveLength(0);
    expect(abandoned).toHaveLength(0);
    // One automatic attempt beyond the first, then it waits for a person.
    expect(uploadMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an unsupported file locally, without any request", () => {
    const { result } = setup();
    const { controller, begun } = fakeController();

    act(() => {
      result.current.uploadImages({
        files: [pngFile("notes.pdf", "application/pdf")],
        insertAt: 1,
        controller,
      });
    });

    expect(uploadMock).not.toHaveBeenCalled();
    const state = begun[0]?.state as { phase: string; message: string };
    expect(state.phase).toBe("error");
    expect(state.message).toContain("not a supported image type");
  });

  it("deletes an attachment that lands after the writer cancelled", async () => {
    const deferred: { settle: (value: unknown) => void } = { settle: () => undefined };
    uploadMock.mockReturnValue(
      new Promise((resolve) => {
        deferred.settle = resolve;
      }),
    );
    const { result } = setup();
    const { controller, begun, abandoned } = fakeController();

    act(() => {
      result.current.uploadImages({ files: [pngFile()], insertAt: 1, controller });
    });
    const state = begun[0]?.state as { onCancel?: () => void };
    act(() => state.onCancel?.());
    expect(abandoned).toEqual([begun[0]?.id]);

    await act(async () => {
      deferred.settle({ ok: true, data: media() });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Nothing will ever reference the row, so it is removed rather than orphaned.
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(workspaceId, attachmentId));
  });

  it("remembers the caret position across the file dialog", () => {
    const { result } = setup();
    const { controller, begun } = fakeController();
    const open = vi.fn();
    uploadMock.mockReturnValue(new Promise(() => undefined));

    act(() => {
      mutableRef(result.current.fileInputRef).current = { open };
      result.current.requestImageFiles({ insertAt: 12, controller });
    });
    expect(open).toHaveBeenCalledTimes(1);

    act(() => result.current.handlePickedFiles([pngFile()]));
    expect(begun[0]?.pos).toBe(12);
  });

  it("ignores picked files that nothing asked for", () => {
    const { result } = setup();
    act(() => result.current.handlePickedFiles([pngFile()]));
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("uploads nothing at all on a read-only note", () => {
    const { result } = setup(false);
    const { controller, begun } = fakeController();
    const open = vi.fn();

    act(() => {
      mutableRef(result.current.fileInputRef).current = { open };
      result.current.uploadImages({ files: [pngFile()], insertAt: 1, controller });
      result.current.requestImageFiles({ insertAt: 1, controller });
    });

    expect(begun).toHaveLength(0);
    expect(open).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("aborts everything still running when the note unmounts", async () => {
    const signals: AbortSignal[] = [];
    uploadMock.mockImplementation((call: { signal: AbortSignal }) => {
      signals.push(call.signal);
      return new Promise(() => undefined);
    });
    const { result, unmount } = setup();
    const { controller } = fakeController();

    act(() => {
      result.current.uploadImages({
        files: [pngFile("a.png"), pngFile("b.png")],
        insertAt: 1,
        controller,
      });
    });
    expect(signals).toHaveLength(2);

    unmount();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});

describe("useImageUploads generic file attachments (Part 44)", () => {
  function pdfFile(name = "report.pdf", type = "application/pdf", size = 4096): File {
    const file = new File([new Uint8Array([1])], name, { type });
    Object.defineProperty(file, "size", { value: size });
    return file;
  }

  function fileMedia(): AttachmentMedia {
    return media({
      displayName: "report.pdf",
      mediaType: "file",
      mimeType: "application/pdf",
      sizeBytes: 4096,
      width: null,
      height: null,
      variants: {},
    });
  }

  it("completes a file through completeAttachment, never through complete", async () => {
    uploadMock.mockResolvedValue({ ok: true, data: fileMedia() });
    const { result } = setup();
    const { controller, completed, completedAttachments } = fakeController();

    act(() => {
      result.current.uploadAttachments({ files: [pdfFile()], insertAt: 5, controller });
    });

    await waitFor(() => expect(completedAttachments).toHaveLength(1));
    // The image path must not have run at all: the two node types are different
    // and a wrong guess here would insert an unrenderable node.
    expect(completed).toHaveLength(0);
    expect(completedAttachments[0]?.attrs).toEqual({
      attachmentId,
      // The SERVER's sanitized name, type, and size — not the browser's.
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4096,
    });
  });

  it("routes the upload with the file kind so the queue can bound it correctly", async () => {
    uploadMock.mockResolvedValue({ ok: true, data: fileMedia() });
    const { result } = setup();
    const { controller, completedAttachments } = fakeController();

    act(() => {
      result.current.uploadAttachments({ files: [pdfFile()], insertAt: 1, controller });
    });

    await waitFor(() => expect(completedAttachments).toHaveLength(1));
    expect(uploadMock.mock.calls[0]?.[0]).toMatchObject({ kind: "file" });
  });

  it("mints no blob preview for a file, which an img could never render", () => {
    uploadMock.mockReturnValue(new Promise(() => undefined));
    const { result } = setup();
    const { controller, begun } = fakeController();

    act(() => {
      result.current.uploadAttachments({ files: [pdfFile()], insertAt: 1, controller });
    });

    expect((begun[0]?.state as { previewUrl: string | null }).previewUrl).toBeNull();
  });

  it("opens its OWN picker and remembers the caret across the dialog", () => {
    uploadMock.mockReturnValue(new Promise(() => undefined));
    const { result } = setup();
    const { controller, begun } = fakeController();
    const openImage = vi.fn();
    const openAttachment = vi.fn();

    act(() => {
      mutableRef(result.current.fileInputRef).current = { open: openImage };
      mutableRef(result.current.attachmentInputRef).current = { open: openAttachment };
      result.current.requestAttachmentFiles({ insertAt: 9, controller });
    });

    // Two inputs, so `accept` is already correct when the dialog opens and the
    // image picker is never the one shown.
    expect(openAttachment).toHaveBeenCalledTimes(1);
    expect(openImage).not.toHaveBeenCalled();

    act(() => result.current.handlePickedAttachmentFiles([pdfFile()]));
    expect(begun[0]?.pos).toBe(9);
  });

  it("keeps the two pending picks apart", () => {
    uploadMock.mockReturnValue(new Promise(() => undefined));
    const { result } = setup();
    const { controller, completed, completedAttachments } = fakeController();

    act(() => {
      mutableRef(result.current.attachmentInputRef).current = { open: vi.fn() };
      result.current.requestAttachmentFiles({ insertAt: 3, controller });
      // Files arriving on the IMAGE input with no image request pending are
      // dropped rather than consuming the attachment request.
      result.current.handlePickedFiles([pngFile()]);
    });

    expect(uploadMock).not.toHaveBeenCalled();
    expect(completed).toHaveLength(0);
    expect(completedAttachments).toHaveLength(0);
  });

  it("attaches nothing at all on a read-only note", () => {
    const { result } = setup(false);
    const { controller, begun } = fakeController();
    const open = vi.fn();

    act(() => {
      mutableRef(result.current.attachmentInputRef).current = { open };
      result.current.uploadAttachments({ files: [pdfFile()], insertAt: 1, controller });
      result.current.requestAttachmentFiles({ insertAt: 1, controller });
    });

    expect(begun).toHaveLength(0);
    expect(open).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });
});
