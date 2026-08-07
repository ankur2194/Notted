import { MAX_ATTACHMENT_UPLOAD_BYTES, MAX_IMAGE_UPLOAD_BYTES } from "@notted/shared-validators";
import { describe, expect, it, vi } from "vitest";

import {
  attachmentFileExtension,
  checkAttachmentFile,
  checkUploadFile,
} from "./attachment-uploads";
import { createImageUploadManager, uploadFailureMessage } from "./image-uploads";

import type { ImageUploadEvent, ImageUploadManagerOptions } from "./image-uploads";
import type { AttachmentMedia } from "@notted/shared-types";

/**
 * A `File` of a chosen apparent size.
 *
 * `size` is derived from the parts rather than stubbed, so the boundary cases
 * below exercise the real property the browser would report — but a 50 MiB
 * buffer per case would make the suite allocate gigabytes, so the property is
 * redefined instead of materialised.
 */
function sizedFile(name: string, type: string, size: number): File {
  const file = new File([new Uint8Array(Math.min(size, 8))], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("attachmentFileExtension", () => {
  it("returns only the final segment, lower-cased, or an empty string", () => {
    expect(attachmentFileExtension("report.PDF")).toBe(".pdf");
    expect(attachmentFileExtension("logs.tar.gz")).toBe(".gz");
    // The double-extension case the server also refuses: the last segment wins,
    // so `invoice.pdf.exe` reads as `.exe` and never as `.pdf`.
    expect(attachmentFileExtension("invoice.pdf.exe")).toBe(".exe");
    expect(attachmentFileExtension("archive")).toBe("");
    expect(attachmentFileExtension(".gitignore")).toBe("");
    expect(attachmentFileExtension("trailing.")).toBe("");
  });
});

describe("checkAttachmentFile", () => {
  it.each([
    ["report.pdf", "application/pdf"],
    ["budget.xlsx", ""],
    ["logs.tar.gz", "application/gzip"],
    // Browsers report wildly inconsistent types for these, frequently "", which
    // is exactly why the extension is the gate rather than `file.type`.
    ["main.py", ""],
    ["data.csv", "application/vnd.ms-excel"],
    ["notes.md", ""],
  ])("admits %s declared as %s", (name, type) => {
    expect(checkAttachmentFile(sizedFile(name, type, 1_024))).toEqual({ ok: true });
  });

  it("refuses an extension outside the allow list", () => {
    const result = checkAttachmentFile(sizedFile("installer.exe", "application/octet-stream", 512));
    expect(result).toEqual({
      ok: false,
      reason: "type",
      message: "installer.exe is not a supported file type.",
    });
  });

  it("refuses a double extension whose final segment is not allowed", () => {
    // The same defence the server applies by forcing the extension to the
    // canonical one for the sniffed type.
    expect(checkAttachmentFile(sizedFile("invoice.pdf.exe", "application/pdf", 512)).ok).toBe(
      false,
    );
  });

  it("admits an extensionless file only when the browser typed it as a known binary", () => {
    expect(checkAttachmentFile(sizedFile("archive", "application/zip", 512)).ok).toBe(true);
    expect(checkAttachmentFile(sizedFile("archive", "", 512)).ok).toBe(false);
  });

  it("reports an empty file as empty rather than as the wrong type or size", () => {
    expect(checkAttachmentFile(sizedFile("report.pdf", "application/pdf", 0))).toEqual({
      ok: false,
      reason: "empty",
      message: "report.pdf is empty.",
    });
  });

  it("accepts the exact ceiling and refuses one byte past it", () => {
    expect(
      checkAttachmentFile(sizedFile("big.zip", "application/zip", MAX_ATTACHMENT_UPLOAD_BYTES)).ok,
    ).toBe(true);
    const over = checkAttachmentFile(
      sizedFile("big.zip", "application/zip", MAX_ATTACHMENT_UPLOAD_BYTES + 1),
    );
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.reason).toBe("size");
      expect(over.message).toContain("50 MB");
    }
  });

  it("uses the generic-file ceiling, which is far above the image one", () => {
    // The two bounds are genuinely different: image ingestion decodes the whole
    // buffer in-process, so its ceiling is much lower. A 20 MiB PDF is fine.
    const file = sizedFile("scan.pdf", "application/pdf", MAX_IMAGE_UPLOAD_BYTES + 1);
    expect(checkAttachmentFile(file).ok).toBe(true);
  });
});

describe("checkUploadFile", () => {
  it("dispatches on the upload kind rather than on the file", () => {
    const pdf = sizedFile("report.pdf", "application/pdf", 1_024);
    const png = sizedFile("photo.png", "image/png", 1_024);

    expect(checkUploadFile(pdf, "file").ok).toBe(true);
    // The same PDF is not an image, and the image path must say so.
    expect(checkUploadFile(pdf, "image").ok).toBe(false);
    expect(checkUploadFile(png, "image").ok).toBe(true);
    // An image is never admitted through the generic-file path; `CustomImage`
    // owns those and the extension allow-list has no image extensions in it.
    expect(checkUploadFile(png, "file").ok).toBe(false);
  });
});

describe("shared upload queue with a kind discriminator", () => {
  const target = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    noteId: "22222222-2222-4222-8222-222222222222",
  };

  const media = (): AttachmentMedia =>
    ({
      id: "33333333-3333-4333-8333-333333333333",
      workspaceId: target.workspaceId,
      noteId: target.noteId,
      displayName: "report.pdf",
      mediaType: "file",
      mimeType: "application/pdf",
      sizeBytes: 1_024,
      status: "ready",
      createdAt: "2026-01-12T09:30:00.000Z",
      width: null,
      height: null,
      variants: {},
    }) as unknown as AttachmentMedia;

  it("carries the kind onto the item, the upload call, and the failure copy", async () => {
    const events: ImageUploadEvent[] = [];
    // The signature is supplied as a type argument rather than inferred from the
    // implementation: `vi.fn(async () => …)` produces a ZERO-argument mock, and
    // `upload.mock.calls[0][0]` — the assertion that the manager really routes
    // `kind` through to the transport — is then a read off an empty tuple.
    const upload = vi.fn<ImageUploadManagerOptions["upload"]>(async () => ({
      ok: true as const,
      data: media(),
    }));
    const manager = createImageUploadManager({
      upload,
      onEvent: (event) => events.push(event),
      check: checkUploadFile,
      createId: (() => {
        let n = 0;
        return () => `id-${(n += 1)}`;
      })(),
    });

    const [item] = manager.enqueue(
      target,
      [sizedFile("report.pdf", "application/pdf", 1_024)],
      "file",
    );
    expect(item?.kind).toBe("file");

    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0]?.[0]).toMatchObject({ kind: "file" });

    await vi.waitFor(() => expect(events.some((event) => event.kind === "uploaded")).toBe(true));
  });

  it("defaults to the image kind, so every existing caller is unchanged", () => {
    const manager = createImageUploadManager({
      upload: async () => ({ ok: true as const, data: media() }),
      onEvent: () => undefined,
      check: checkUploadFile,
    });
    const [item] = manager.enqueue(target, [sizedFile("photo.png", "image/png", 1_024)]);
    expect(item?.kind).toBe("image");
  });

  it("rejects a file the shared bounds refuse without ever calling upload", () => {
    const upload = vi.fn(async () => ({ ok: true as const, data: media() }));
    const manager = createImageUploadManager({
      upload,
      onEvent: () => undefined,
      check: checkUploadFile,
    });
    const [item] = manager.enqueue(
      target,
      [sizedFile("installer.exe", "application/octet-stream", 512)],
      "file",
    );

    expect(item?.status).toBe("error");
    // A rejected file would be rejected identically forever, so no Retry.
    expect(item?.retryable).toBe(false);
    expect(item?.message).toContain("not a supported file type");
    expect(upload).not.toHaveBeenCalled();
  });

  it("writes failure copy about a file rather than about an image", () => {
    expect(uploadFailureMessage("report.pdf", { ok: false, kind: "invalid" }, "file")).toContain(
      "unsupported or oversized file",
    );
    expect(
      uploadFailureMessage("report.pdf", { ok: false, kind: "forbidden-or-not-found" }, "file"),
    ).toContain("permission to add files");
    // The default is still the image wording, so no existing caller changes.
    expect(uploadFailureMessage("a.png", { ok: false, kind: "invalid" })).toContain(
      "unsupported or oversized image",
    );
  });
});
