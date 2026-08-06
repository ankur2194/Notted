/**
 * Pure extraction of image files from a clipboard or drag payload (Part 42).
 *
 * Everything here is a plain function over a **structural** `DataTransferLike`
 * rather than over the DOM types, and that is a testability decision with teeth:
 * jsdom 25 implements neither `DataTransfer` nor a real `ClipboardEvent`
 * (`src/test/setup.ts` installs a stub whose `clipboardData` is hardcoded to
 * `null`). A helper typed against `DataTransfer` could therefore never be
 * exercised in a unit test at all. Structural typing lets every extraction rule
 * be proven here, and reduces the ProseMirror plugin wiring in `CustomImage.ts`
 * to a two-line adapter whose only untested part — that the browser really
 * populates the payload — is covered in Playwright.
 */

import { ATTACHMENT_IMAGE_MIME_TYPES } from "@notted/shared-validators";

/** Structural view of one `DataTransferItem`. */
export interface DataTransferItemLike {
  readonly kind: string;
  readonly type: string;
  getAsFile: () => File | null;
}

/** Structural view of a `DataTransfer`, as both paste and drop expose one. */
export interface DataTransferLike {
  readonly items?: ArrayLike<DataTransferItemLike> | null;
  readonly files?: ArrayLike<File> | null;
  readonly types?: ArrayLike<string> | null;
  readonly getData?: (format: string) => string;
}

/** The `accept` value for the picker, kept identical to the server's allow list. */
export const IMAGE_UPLOAD_ACCEPT = ATTACHMENT_IMAGE_MIME_TYPES.join(",");

const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(ATTACHMENT_IMAGE_MIME_TYPES);

/**
 * How much pasted HTML is inspected. A clipboard payload can be megabytes of
 * Word markup; the question being asked ("is there anything here besides an
 * image?") is answered by the first few kilobytes in every realistic case.
 */
const HTML_INSPECTION_LIMIT = 64 * 1024;

/**
 * Tags that carry no content of their own. Anything outside this set means the
 * payload describes a document, not a bare image.
 */
const WRAPPER_TAGS: ReadonlySet<string> = new Set([
  "html",
  "head",
  "body",
  "meta",
  "link",
  "style",
  "title",
  "base",
  "div",
  "span",
  "p",
  "br",
  "img",
  "figure",
]);

const TAG_PATTERN = /<\/?([a-z][a-z0-9-]*)\b/giu;
const COMMENT_PATTERN = /<!--[\s\S]*?-->/gu;

function toArray<T>(value: ArrayLike<T> | null | undefined): readonly T[] {
  if (value === null || value === undefined) return [];
  return Array.from(value);
}

function isImageType(type: string): boolean {
  return IMAGE_MIME_TYPES.has(type.toLowerCase());
}

/**
 * Every image file in a clipboard or drag payload, in payload order.
 *
 * `items` is preferred because it is the only place a *pasted* file appears in
 * some engines; `files` is the fallback used by drag payloads and by browsers
 * that populate only that list. Both are read defensively: a payload entry can
 * be a directory, a string, or simply yield `null`.
 */
export function imageFilesFromDataTransfer(transfer: DataTransferLike | null): readonly File[] {
  if (transfer === null) return [];
  const files: File[] = [];

  for (const item of toArray(transfer.items)) {
    if (item.kind !== "file" || !isImageType(item.type)) continue;
    const file = item.getAsFile();
    if (file !== null) files.push(file);
  }
  if (files.length > 0) return files;

  for (const file of toArray(transfer.files)) {
    // A dropped directory has an empty type in every engine that allows one.
    if (isImageType(file.type)) files.push(file);
  }
  return files;
}

/**
 * Whether a payload *looks like* it carries image files.
 *
 * Used only for the drag affordance, where `getAsFile()` deliberately returns
 * `null` — during a drag the browser exposes an item's `type` but withholds the
 * bytes until drop, so the real extraction above cannot run yet. An explicit
 * image item is the strong signal; a bare `Files` entry is the weak fallback for
 * engines that expose nothing else mid-drag. Highlighting for a file that turns
 * out not to be an image is a harmless affordance, not a decision.
 */
export function hasImageFiles(transfer: DataTransferLike | null): boolean {
  if (transfer === null) return false;
  for (const item of toArray(transfer.items)) {
    if (item.kind === "file" && isImageType(item.type)) return true;
  }
  for (const file of toArray(transfer.files)) {
    if (isImageType(file.type)) return true;
  }
  return toArray(transfer.types).includes("Files");
}

/**
 * Whether the payload carries HTML that means something beyond a bare image.
 *
 * This is the rule that keeps "paste a Word document containing an inline
 * image" working: such a payload carries both `text/html` and an image file, and
 * consuming it as an image upload would silently throw the document away. Only a
 * payload that is *nothing but* an image — a screenshot, a copied `<img>` — is
 * taken over by the upload path.
 *
 * The HTML is inspected as text and never parsed into a live DOM: this function
 * decides routing, so it must not be able to execute or fetch anything.
 */
export function hasMeaningfulHtml(transfer: DataTransferLike | null): boolean {
  if (transfer === null) return false;
  const types = toArray(transfer.types).map((type) => type.toLowerCase());
  if (!types.includes("text/html")) return false;
  const html = transfer.getData?.("text/html") ?? "";
  if (html.length === 0) return false;

  const inspected = html.slice(0, HTML_INSPECTION_LIMIT).replace(COMMENT_PATTERN, " ");
  const text = inspected
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .trim();
  if (text.length > 0) return true;

  TAG_PATTERN.lastIndex = 0;
  for (
    let match = TAG_PATTERN.exec(inspected);
    match !== null;
    match = TAG_PATTERN.exec(inspected)
  ) {
    const tag = match[1]?.toLowerCase();
    if (tag !== undefined && !WRAPPER_TAGS.has(tag)) return true;
  }
  return false;
}

/**
 * Object URLs for local previews, tracked so revocation is exact.
 *
 * A `blob:` URL is the *only* place a temporary source ever exists in Part 42,
 * and it lives exclusively inside a decoration widget's DOM — never in the
 * document, because the contract has no attribute that could hold it. Each URL
 * is revoked in exactly two places, both owned by the upload manager: `forget()`
 * on either terminal outcome — cancellation and the successful temp→permanent
 * swap — and `releaseAll()` on the editor host's unmount teardown. Keying them
 * here makes a repeat a harmless no-op instead of a `URL.revokeObjectURL` call
 * on a string that was already freed.
 *
 * Revocation deliberately does **not** hang off the decoration's teardown.
 * `DecorationSet.map` mints a new `Decoration` each transaction and
 * `prosemirror-view` rebuilds the widget desc whenever identity changes, so a
 * `destroy` hook would fire on every typed character and blank the thumbnails
 * of uploads still in flight. See `image-upload-placeholder.ts`.
 *
 * The factory and revoker are injectable because jsdom implements neither.
 */
export interface ObjectUrlRegistry {
  create(key: string, file: Blob): string;
  get(key: string): string | null;
  release(key: string): void;
  releaseAll(): void;
  readonly size: number;
}

export function createObjectUrlRegistry(
  createUrl: (file: Blob) => string = (file) => URL.createObjectURL(file),
  revokeUrl: (url: string) => void = (url) => {
    URL.revokeObjectURL(url);
  },
): ObjectUrlRegistry {
  const urls = new Map<string, string>();
  return {
    create: (key, file) => {
      const existing = urls.get(key);
      if (existing !== undefined) return existing;
      const url = createUrl(file);
      urls.set(key, url);
      return url;
    },
    get: (key) => urls.get(key) ?? null,
    release: (key) => {
      const url = urls.get(key);
      if (url === undefined) return;
      urls.delete(key);
      revokeUrl(url);
    },
    releaseAll: () => {
      for (const url of urls.values()) revokeUrl(url);
      urls.clear();
    },
    get size() {
      return urls.size;
    },
  };
}
