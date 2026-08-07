// Part 44: the single decision point for "what kind of upload is this, and may
// it be stored at all?".
//
// One upload endpoint serves both media types, so something has to route. That
// something is here rather than in the controller, so the rule is a pure,
// unit-testable function with no request, no database, and no storage in scope —
// and so the two service methods can each re-run it rather than trusting a
// caller's classification (a transport must never be able to talk the service
// into the wrong admission path).
//
// ADMISSION POLICY, in the order it is applied:
//
//   1. IMAGE SIGNATURE. If the magic bytes are one of the six supported image
//      formats, this is an image. Part 41's pipeline rasterizes SVG and converts
//      HEIC, so nothing admitted here is ever served as active content.
//   2. FILE SIGNATURE. If the magic bytes are one of the nine supported
//      container formats, this is a generic file and keeps its sniffed type.
//   3. TEXT ALLOW-LIST + CONTENT SCAN. Otherwise, if the declared extension is
//      on the closed text/code list AND the payload has no NUL byte and is valid
//      UTF-8, this is a generic file stored as `text/plain`.
//   4. Everything else is refused.
//
// Step 1 comes first on purpose. A file named `notes.html` whose content really
// is an SVG document is an SVG, and is handed to the image pipeline that knows
// how to sanitize one — which is strictly safer than storing it as text under a
// name that suggests markup. The converse case (an `.svg` extension on a ZIP) is
// caught by step 2 and stored as a ZIP.

import { ATTACHMENT_TEXT_MIME_TYPE, MAX_ATTACHMENT_UPLOAD_BYTES } from "@notted/shared-validators";

import {
  canonicalFileExtension,
  FILE_SIGNATURE_HEAD_BYTES,
  sniffFileMediaType,
} from "./file-signature";
import { declaredFileExtension } from "./filename";
import { IMAGE_SIGNATURE_HEAD_BYTES, sniffImageMediaType } from "./image-signature";
import { isAllowedTextExtension, scanTextUpload, type TextRejectionReason } from "./text-safety";

import type { SniffedFileType } from "./file-signature";
import type { SniffedImageType } from "./image-signature";

/** Bytes of the head both sniffers need; the larger of the two windows. */
export const ATTACHMENT_SIGNATURE_HEAD_BYTES = Math.max(
  IMAGE_SIGNATURE_HEAD_BYTES,
  FILE_SIGNATURE_HEAD_BYTES,
);

export interface AdmittedImageUpload {
  readonly kind: "image";
  /** Authoritative, derived from the bytes. */
  readonly mimeType: SniffedImageType;
}

export interface AdmittedFileUpload {
  readonly kind: "file";
  /** Authoritative: a sniffed container type, or `text/plain` for text/code. */
  readonly mimeType: SniffedFileType | typeof ATTACHMENT_TEXT_MIME_TYPE;
  /**
   * The extension a download will carry. For a signature-verified binary it is
   * the canonical extension of the sniffed type; for text it is the
   * allow-listed extension the file already had, because a `.py` that downloads
   * as `.txt` is useless and every member of that list is inert.
   */
  readonly extension: string;
  /** Whether the text path admitted it. Recorded so callers can explain refusals. */
  readonly viaTextScan: boolean;
}

export type AdmittedUpload = AdmittedImageUpload | AdmittedFileUpload;

/** Why an upload was refused. Short, stable, and safe to log. */
export type AdmissionRejection =
  | { readonly reason: "empty" }
  | { readonly reason: "too_large" }
  | { readonly reason: "unsupported" }
  | { readonly reason: "unsafe_text"; readonly detail: TextRejectionReason };

export type AdmissionResult =
  | { readonly ok: true; readonly admitted: AdmittedUpload }
  | { readonly ok: false; readonly rejection: AdmissionRejection };

/**
 * Classify one uploaded payload.
 *
 * `declaredFilename` is untrusted and is used only through
 * `declaredFileExtension`, which reduces it to a short lowercase token compared
 * against closed sets. It can narrow a type the bytes already proved (DOCX vs
 * ZIP) or open the text gate, but it can never introduce a type of its own.
 */
export function admitUpload(buffer: Buffer, declaredFilename: string): AdmissionResult {
  if (buffer.byteLength === 0) return { ok: false, rejection: { reason: "empty" } };
  // A defensive backstop only: the multipart parser already refused anything
  // over the configured ceiling before and during transfer. This catches a
  // caller that reached the service by another route.
  if (buffer.byteLength > MAX_ATTACHMENT_UPLOAD_BYTES) {
    return { ok: false, rejection: { reason: "too_large" } };
  }

  const head = buffer.subarray(0, ATTACHMENT_SIGNATURE_HEAD_BYTES);
  const extension = declaredFileExtension(declaredFilename);

  const image = sniffImageMediaType(head.subarray(0, IMAGE_SIGNATURE_HEAD_BYTES));
  if (image !== null) return { ok: true, admitted: { kind: "image", mimeType: image } };

  const file = sniffFileMediaType(head, extension);
  if (file !== null) {
    return {
      ok: true,
      admitted: {
        kind: "file",
        mimeType: file,
        extension: canonicalFileExtension(file),
        viaTextScan: false,
      },
    };
  }

  if (!isAllowedTextExtension(extension)) {
    return { ok: false, rejection: { reason: "unsupported" } };
  }
  const scan = scanTextUpload(buffer, extension);
  if (!scan.ok) return { ok: false, rejection: { reason: "unsafe_text", detail: scan.reason } };
  return {
    ok: true,
    admitted: {
      kind: "file",
      mimeType: ATTACHMENT_TEXT_MIME_TYPE,
      extension,
      viaTextScan: true,
    },
  };
}
