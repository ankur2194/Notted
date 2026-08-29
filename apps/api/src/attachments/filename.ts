// Part 40: filename sanitization for DISPLAY metadata only (ADR 0005).
//
// The raw user filename never reaches object storage as a key. These two values
// are stored purely so a download can carry a sensible
// `Content-Disposition`:
//
// - `originalName` keeps the user's own extension (what they think they sent).
// - `filename` carries the CANONICAL extension for the sniffed type and is what
//   drives the download disposition. Forcing the extension is what kills
//   `.svg`-masquerading-as-`.png` and double extensions such as
//   `invoice.pdf.exe`.

import { stripUnsafeText } from "@notted/shared-validators";

import type { SniffedImageType } from "./image-signature";

const DISPLAY_EXTENSION_BY_TYPE: Readonly<Record<SniffedImageType, string>> = Object.freeze({
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/heic": ".heic",
});

/** Windows reserved device names; a bare `CON` or `CON.png` is still reserved. */
const RESERVED_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_value, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_value, index) => `lpt${index + 1}`),
]);

/*
 * The unsafe-character table now lives in `@notted/shared-validators`
 * (`UNSAFE_TEXT_PATTERN`), because the document contract needs exactly the same
 * one. It used to live here alone and cover more than the contract's did, which
 * is how `U+202E` in an ATTACHMENT NAME could be stripped on upload and then
 * accepted inside a note document. Two copies of a security table drift, and
 * nothing fails when they do. Per ADR 0001 the shared fact belongs to the
 * package and this app reads it — never the reverse.
 *
 * `WINDOWS_ILLEGAL` and `RESERVED_DEVICE_NAMES` stay here: those are filesystem
 * concerns, not text-safety ones, and no shared consumer has them.
 */
const WINDOWS_ILLEGAL = /[<>:"/\\|?*]/gu;

/** `varchar(255)` is the column bound; bytes keep `Content-Disposition` sane. */
const MAX_FILENAME_BYTES = 255;

export interface SanitizedAttachmentFilename {
  readonly originalName: string;
  readonly filename: string;
}

export function canonicalDisplayExtension(sniffed: SniffedImageType): string {
  return DISPLAY_EXTENSION_BY_TYPE[sniffed];
}

/**
 * The lowercased, dot-prefixed extension an untrusted filename declares, or `""`.
 *
 * Part 44. This is an ADMISSION INPUT, never a type and never part of a key. It
 * feeds exactly two closed-set lookups: the text allow-list
 * (`ATTACHMENT_TEXT_EXTENSIONS`) and the DOCX/XLSX-versus-plain-ZIP decision in
 * `sniffFileMediaType`. Because both consumers compare it against a closed set,
 * an attacker-chosen value can only ever fail to match — it cannot introduce a
 * new type, a new extension, or a new path segment.
 *
 * Path separators and control/bidi characters are stripped first, for the same
 * reason `sanitizeAttachmentFilename` strips them: a hidden separator or an
 * override could otherwise make `evil.exe` present itself as `.txt`. The result
 * is bounded to a short run of alphanumerics, so `".тхт"` or a 200-character
 * pseudo-extension simply yields `""`.
 */
export function declaredFileExtension(raw: string): string {
  const cleaned = stripUnsafeText(basename(raw).normalize("NFC")).split(/[/\\]/u).pop() ?? "";
  const match = /\.([A-Za-z0-9]{1,10})$/u.exec(cleaned);
  return match?.[1] === undefined ? "" : `.${match[1].toLowerCase()}`;
}

function basename(raw: string): string {
  const segments = raw.split(/[/\\]/u);
  return segments[segments.length - 1] ?? "";
}

function splitExtension(value: string): { readonly stem: string; readonly extension: string } {
  const dot = value.lastIndexOf(".");
  return dot <= 0
    ? { stem: value, extension: "" }
    : { stem: value.slice(0, dot), extension: value.slice(dot) };
}

/** Truncate to `limit` UTF-8 bytes without splitting a code point. */
function truncateBytes(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  let result = "";
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > limit) break;
    result += character;
    used += size;
  }
  return result;
}

function boundName(stem: string, extension: string, fallbackStem: string): string {
  const extensionBytes = Buffer.byteLength(extension, "utf8");
  const room = Math.max(0, MAX_FILENAME_BYTES - extensionBytes);
  const truncated = truncateBytes(stem, room).replace(/[\s.]+$/u, "");
  const safeStem = truncated === "" ? fallbackStem : truncated;
  return truncateBytes(`${safeStem}${extension}`, MAX_FILENAME_BYTES);
}

/**
 * Reduce an untrusted upload filename to a safe display name pair.
 *
 * Order matters: path stripping runs before control/bidi removal so a hidden
 * separator cannot reintroduce traversal, and the extension is forced last so
 * nothing earlier can put it back.
 */
export function sanitizeAttachmentFilename(
  raw: string,
  sniffed: SniffedImageType,
): SanitizedAttachmentFilename {
  return sanitizeUploadFilename(raw, canonicalDisplayExtension(sniffed), "image");
}

/**
 * The general form, shared by images (Part 40) and generic files (Part 44).
 *
 * `canonicalExtension` is always supplied by the caller from a CLOSED set that
 * the *bytes* selected — the sniffed image type, the sniffed file type, or (for
 * text) the allow-listed extension the file already carried. It is never taken
 * from the user's filename directly. Forcing it is what kills
 * `invoice.pdf.exe`: the stem is preserved verbatim, but the extension a
 * download will carry is the one the content actually is.
 *
 * `fallbackStem` is used only when sanitization consumes the whole name (`"..."`,
 * a name made entirely of control characters, an empty part filename).
 */
export function sanitizeUploadFilename(
  raw: string,
  canonicalExtension: string,
  fallbackStem: string,
): SanitizedAttachmentFilename {
  const canonical = canonicalExtension;
  const cleaned = stripUnsafeText(basename(raw).normalize("NFC"))
    // Re-split after control removal: a stripped control could expose a separator.
    .split(/[/\\]/u)
    .pop()
    ?.replace(/^\.+/u, "")
    .replace(WINDOWS_ILLEGAL, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[\s.]+$/u, "");

  const safe = cleaned === undefined || cleaned === "" ? "" : cleaned;
  const { stem, extension } = splitExtension(safe);
  const reserved = RESERVED_DEVICE_NAMES.has(stem.toLowerCase());
  const guardedStem = reserved ? `_${stem}` : stem;

  return Object.freeze({
    originalName: boundName(guardedStem, extension === "" ? canonical : extension, fallbackStem),
    filename: boundName(guardedStem, canonical, fallbackStem),
  });
}
