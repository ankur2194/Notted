// Part 44: admission for text and code uploads.
//
// `Notted.md` §6 requires TXT, MD, CSV, JSON, XML, JS, TS, HTML, CSS, and PY.
// None of them has a magic-byte signature — a `.py` file and a `.txt` file are
// indistinguishable as bytes — so they cannot be sniffed the way a PDF or a ZIP
// can. Two controls stand in for the signature, and both must pass:
//
//   1. a CLOSED EXTENSION ALLOW-LIST (`ATTACHMENT_TEXT_EXTENSIONS`), which is a
//      gate and never a type; and
//   2. a CONTENT SCAN that rejects NUL bytes and invalid UTF-8.
//
// On success the stored `mime_type` is normalized to `text/plain`, whatever the
// extension was and whatever the client declared. That normalization is the
// whole safety argument for accepting `.html`, `.js`, and `.xml` at all: the row
// can never claim to be active content, so no code path can be talked into
// rendering it, and the download route additionally forces
// `Content-Disposition: attachment` plus `X-Content-Type-Options: nosniff`
// (ADR 0005: "untrusted active content is not served inline").
//
// COST NOTE. The UTF-8 validation is bounded to a head window on purpose: fully
// decoding 50 MiB would allocate a ~100 MB JS string per request, which is a
// far worse denial-of-service surface than the one it closes. The NUL check is
// run over the WHOLE buffer, because `Buffer.indexOf(0)` is a single native
// memchr over memory the request is already holding — microseconds at 50 MiB —
// and it is the check that actually stops a binary payload being smuggled in
// past the head window under a `.txt` name.

import { ATTACHMENT_TEXT_EXTENSIONS } from "@notted/shared-validators";

/** How many leading bytes are UTF-8 validated. */
export const TEXT_SAFETY_SCAN_BYTES = 64 * 1_024;

const ALLOWED_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(ATTACHMENT_TEXT_EXTENSIONS);

export type TextRejectionReason = "extension" | "empty" | "nul_byte" | "invalid_utf8";

export type TextScanResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: TextRejectionReason };

/** Whether a lowercased, dot-prefixed extension is on the text allow-list. */
export function isAllowedTextExtension(extension: string): boolean {
  return ALLOWED_TEXT_EXTENSIONS.has(extension);
}

/**
 * Validate a byte window as UTF-8 without allocating a string.
 *
 * Rejects overlong encodings, UTF-16 surrogate halves (U+D800–U+DFFF, which are
 * not scalar values and are a classic filter-bypass trick), and code points
 * above U+10FFFF. A multi-byte sequence cut off by the end of the window is
 * accepted when `truncated` is true, because the window is a prefix of a larger
 * payload and the split is an artefact of the bound rather than a defect in the
 * file.
 */
function isValidUtf8(window: Buffer, truncated: boolean): boolean {
  let index = 0;
  while (index < window.length) {
    const byte = window[index] as number;

    if (byte < 0x80) {
      index += 1;
      continue;
    }

    let length: number;
    let codePoint: number;
    if (byte >= 0xc2 && byte <= 0xdf) {
      length = 2;
      codePoint = byte & 0x1f;
    } else if (byte >= 0xe0 && byte <= 0xef) {
      length = 3;
      codePoint = byte & 0x0f;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      length = 4;
      codePoint = byte & 0x07;
    } else {
      // 0x80–0xC1 (a stray continuation byte or an overlong two-byte lead) and
      // 0xF5–0xFF are never valid UTF-8 lead bytes.
      return false;
    }

    if (index + length > window.length) return truncated;

    for (let offset = 1; offset < length; offset += 1) {
      const continuation = window[index + offset] as number;
      if ((continuation & 0xc0) !== 0x80) return false;
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }

    if (length === 3 && codePoint < 0x800) return false;
    if (length === 4 && codePoint < 0x1_00_00) return false;
    if (codePoint >= 0xd8_00 && codePoint <= 0xdf_ff) return false;
    if (codePoint > 0x10_ff_ff) return false;

    index += length;
  }
  return true;
}

/**
 * Decide whether an upload may be admitted as text.
 *
 * The extension gate runs first so a binary named `.exe` is refused without any
 * scanning at all, then the empty check, then the whole-buffer NUL check, then
 * the bounded UTF-8 check. Ordering is deliberate: each step is cheaper than the
 * one after it, and the reasons are distinct so the caller can log which control
 * fired without logging a byte of content.
 */
export function scanTextUpload(buffer: Buffer, declaredExtension: string): TextScanResult {
  if (!isAllowedTextExtension(declaredExtension)) return { ok: false, reason: "extension" };
  if (buffer.byteLength === 0) return { ok: false, reason: "empty" };
  // A NUL byte anywhere means this is not text, whatever the extension claims.
  // Native memchr over the buffer the request already holds; see the file header.
  if (buffer.indexOf(0) !== -1) return { ok: false, reason: "nul_byte" };

  const truncated = buffer.byteLength > TEXT_SAFETY_SCAN_BYTES;
  const window = truncated ? buffer.subarray(0, TEXT_SAFETY_SCAN_BYTES) : buffer;
  return isValidUtf8(window, truncated) ? { ok: true } : { ok: false, reason: "invalid_utf8" };
}
