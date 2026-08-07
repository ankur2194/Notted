/**
 * Client pre-flight for generic file attachments (Part 44).
 *
 * A sibling of `checkImageFile` rather than a branch inside it, and it lives in
 * its own module so `image-uploads.ts` — the shared queue — never imports the
 * attachment bounds. The dependency runs one way only: this file imports the
 * queue's result types, the queue imports nothing from here, and the React
 * adapter injects the dispatcher that picks between the two.
 *
 * Everything here is a **courtesy**, never a control. The server re-derives the
 * type from the magic bytes (or, for text and code, from the extension
 * allow-list plus a UTF-8/NUL scan), re-measures the length, and re-checks the
 * workspace quota on every upload. A browser check exists only so a writer
 * learns about a 60 MB `.dmg` immediately instead of after a minute of
 * uploading, and its bounds come from the same shared constants the API
 * enforces so the two cannot drift apart.
 */

import {
  ATTACHMENT_FILE_EXTENSIONS,
  ATTACHMENT_FILE_MIME_TYPES,
  ATTACHMENT_TEXT_EXTENSIONS,
  MAX_ATTACHMENT_UPLOAD_BYTES,
} from "@notted/shared-validators";

import { checkImageFile } from "./image-uploads";

import type { ImageFileCheck, UploadKind } from "./image-uploads";

/**
 * Every extension the picker offers, lower-cased for comparison.
 *
 * The extension is the primary gate rather than `file.type`, for the reason
 * `ATTACHMENT_UPLOAD_ACCEPT` records: browsers disagree wildly about the MIME
 * type they report for `.md`, `.py`, `.ts`, and `.csv`, and frequently report
 * the empty string. Rejecting on a missing or unfamiliar `file.type` would hide
 * legitimate files that the server admits happily.
 */
const ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set<string>([
  ...ATTACHMENT_FILE_EXTENSIONS,
  ...ATTACHMENT_TEXT_EXTENSIONS,
]);

/**
 * The binary MIME types the server can admit by signature.
 *
 * Consulted only as a *fallback* when the file has no recognisable extension —
 * a `.tar.gz` renamed to `archive` still uploads fine if the browser managed to
 * type it — never as an additional requirement on top of the extension.
 */
const ATTACHMENT_FILE_TYPES: ReadonlySet<string> = new Set<string>(ATTACHMENT_FILE_MIME_TYPES);

function fileLabel(file: File): string {
  return file.name.length > 0 ? file.name : "This file";
}

/**
 * The lower-cased final extension of a name, including the dot, or `""`.
 *
 * Only the last segment is considered, which is what makes `invoice.pdf.exe`
 * read as `.exe` and get refused here exactly as the server refuses it.
 */
export function attachmentFileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return "";
  return fileName.slice(dot).toLowerCase();
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
  const extension = attachmentFileExtension(file.name);
  const admissible =
    ATTACHMENT_EXTENSIONS.has(extension) ||
    (extension === "" && ATTACHMENT_FILE_TYPES.has(file.type.toLowerCase()));
  if (!admissible) {
    return {
      ok: false,
      reason: "type",
      message: `${fileLabel(file)} is not a supported file type.`,
    };
  }
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
 * both allow-lists, and a test can substitute a check without having to
 * fabricate `File` objects that satisfy a real MIME or extension set.
 */
export function checkUploadFile(file: File, kind: UploadKind): ImageFileCheck {
  return kind === "file" ? checkAttachmentFile(file) : checkImageFile(file);
}
