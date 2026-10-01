/**
 * Client pre-flight for generic file attachments (Part 44).
 *
 * A sibling of `checkImageFile` rather than a branch inside it, and it lives in
 * its own module so `image-uploads.ts` — the shared queue — never imports the
 * attachment bounds. The dependency runs one way only: this file imports the
 * queue's result types, the queue imports nothing from here, and the React
 * adapter injects the dispatcher that picks between the two.
 *
 * Generic attachments accept every filename and MIME type. Pre-flight checks
 * only report empty or oversized files before uploading; the server enforces
 * the same size ceiling and workspace quota without reclassifying the bytes.
 */

import { MAX_ATTACHMENT_UPLOAD_BYTES } from "@notted/shared-validators";

import { checkImageFile } from "./image-uploads";

import type { ImageFileCheck, UploadKind } from "./image-uploads";

function fileLabel(file: File): string {
  return file.name.length > 0 ? file.name : "This file";
}

/**
 * Client pre-flight for one generic attachment.
 *
 * Mirrors `checkImageFile`'s `"type" | "size" | "empty"` result shape so the
 * queue can treat both identically: any rejection lands the item in `error`
 * with `retryable: false`, because a file the shared bounds refuse would be
 * refused identically on every retry.
 */
export function checkAttachmentFile(file: File): ImageFileCheck {
  // Checked before the ceiling so a zero-byte file is reported as empty rather
  // than as an oversize failure, matching `checkImageFile`'s ordering.
  if (file.size <= 0) {
    return { ok: false, reason: "empty", message: `${fileLabel(file)} is empty.` };
  }
  if (file.size > MAX_ATTACHMENT_UPLOAD_BYTES) {
    const limitMb = Math.floor(MAX_ATTACHMENT_UPLOAD_BYTES / (1024 * 1024));
    return {
      ok: false,
      reason: "size",
      message: `${fileLabel(file)} is larger than the ${limitMb} MB file limit.`,
    };
  }
  return { ok: true };
}

/**
 * The `check` the shared upload manager is constructed with.
 *
 * Injected rather than branched on inside the queue: the queue stays free of
 * image validation and generic-file bounds, and a test can substitute a check.
 */
export function checkUploadFile(file: File, kind: UploadKind): ImageFileCheck {
  return kind === "file" ? checkAttachmentFile(file) : checkImageFile(file);
}
