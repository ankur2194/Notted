/**
 * Pure extraction of NON-IMAGE attachment files from a clipboard or drag
 * payload (Part 44).
 *
 * The sibling of `image-transfer.ts`, written against the same structural
 * `DataTransferLike` and for the same testability reason recorded there: jsdom
 * 25 implements neither `DataTransfer` nor a usable `ClipboardEvent`, so a
 * helper typed against the DOM types could never be exercised in a unit test at
 * all. Structural typing lets every extraction rule be proven here and reduces
 * the ProseMirror plugin in `CustomAttachment.ts` to a two-line adapter.
 *
 * ## Why images are excluded here rather than merged
 *
 * `CustomImage`'s transfer plugin is registered first and consumes any payload
 * containing an image; this one only ever sees the rest. Excluding image types
 * explicitly (rather than relying on that ordering alone) makes the split a
 * property of the *data* instead of a property of plugin registration order, so
 * a future reordering degrades to "nothing is uploaded twice" rather than to
 * "an image is uploaded as a generic file".
 *
 * Generic attachments accept every non-image file regardless of extension or
 * browser MIME metadata. Image MIME types here only select the dedicated image
 * transfer path; they do not restrict the explicit attachment picker.
 */

import { ATTACHMENT_IMAGE_MIME_TYPES } from "@notted/shared-validators";

import type { DataTransferLike } from "./image-transfer";

const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set<string>(ATTACHMENT_IMAGE_MIME_TYPES);

function toArray<T>(value: ArrayLike<T> | null | undefined): readonly T[] {
  if (value === null || value === undefined) return [];
  return Array.from(value);
}

/**
 * Whether one file should travel the generic-attachment path.
 *
 * An image is excluded whatever it is called — `CustomImage` owns those, and a
 * `.zip` extension on an `image/png` payload is far more likely to be a browser
 * quirk than an author's intent.
 */
export function isAttachmentCandidate(file: File): boolean {
  return !IMAGE_MIME_TYPES.has(file.type.toLowerCase());
}

/**
 * Every non-image attachment candidate in a clipboard or drag payload, in
 * payload order.
 *
 * `items` is preferred because it is the only place a *pasted* file appears in
 * some engines; `files` is the fallback used by drag payloads and by browsers
 * that populate only that list. Both are read defensively: a payload entry can
 * be a directory, a string, or simply yield `null`.
 */
export function attachmentFilesFromDataTransfer(
  transfer: DataTransferLike | null,
): readonly File[] {
  if (transfer === null) return [];
  const files: File[] = [];

  for (const item of toArray(transfer.items)) {
    if (item.kind !== "file") continue;
    if (IMAGE_MIME_TYPES.has(item.type.toLowerCase())) continue;
    const file = item.getAsFile();
    // An item can represent a directory or yield no usable file.
    if (file !== null && isAttachmentCandidate(file)) files.push(file);
  }
  if (files.length > 0) return files;

  for (const file of toArray(transfer.files)) {
    if (isAttachmentCandidate(file)) files.push(file);
  }
  return files;
}

/**
 * Whether a payload *looks like* it carries non-image files.
 *
 * Used only for the drag affordance, where `getAsFile()` deliberately returns
 * `null`: during a drag the browser exposes an item's `type` but withholds the
 * bytes — and therefore the *name* — until drop, so the real extraction above
 * cannot run yet. The best available signal mid-drag is "there is a file item
 * that is not an image". Empty or oversized files are reported by pre-flight
 * after the browser makes the file available.
 */
export function hasAttachmentFiles(transfer: DataTransferLike | null): boolean {
  if (transfer === null) return false;
  const items = toArray(transfer.items);
  if (
    items.some((item) => item.kind === "file" && !IMAGE_MIME_TYPES.has(item.type.toLowerCase()))
  ) {
    return true;
  }
  if (toArray(transfer.files).some((file) => isAttachmentCandidate(file))) return true;
  // Some engines expose nothing but the bare `Files` marker mid-drag. Only treat
  // it as a signal when no image item was advertised, so the image path keeps
  // its own highlight.
  return (
    items.length === 0 &&
    toArray(transfer.files).length === 0 &&
    toArray(transfer.types).includes("Files")
  );
}
