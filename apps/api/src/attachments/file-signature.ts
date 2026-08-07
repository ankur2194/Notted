// Part 44: first-party magic-byte sniffing for generic (non-image) uploads.
//
// The sibling of `image-signature.ts`, written in the same hand-rolled style and
// for the same reason: `file-type@21.x` and its `strtok3`/`token-types`
// dependencies are ESM-only with an exports map, while `apps/api` compiles with
// `module: CommonJS` + `moduleResolution: Node10`, so TypeScript cannot resolve
// them and a dynamic `import()` downlevels to `require()` (ADR 0008). The
// supported surface is nine container formats, so a reviewed table beats an ESM
// boundary.
//
// TRUST RULE (ADR 0005): the value returned here is authoritative and is what
// lands in `attachments.mime_type`. The multipart part's `Content-Type` header is
// NEVER consulted. The filename extension is consulted for exactly ONE purpose —
// telling DOCX and XLSX apart from a plain ZIP, because both *are* ZIP
// containers and share its magic bytes byte for byte — and even then only after
// the ZIP signature has already been proven and the OOXML marker found. An
// extension can therefore never *admit* a file; it can only narrow a type that
// the bytes already established.

import { ATTACHMENT_FILE_EXTENSIONS, ATTACHMENT_FILE_MIME_TYPES } from "@notted/shared-validators";

export type SniffedFileType = (typeof ATTACHMENT_FILE_MIME_TYPES)[number];
export type SniffedFileExtension = (typeof ATTACHMENT_FILE_EXTENSIONS)[number];

/**
 * Bytes of the head that are examined.
 *
 * The binding constraint is TAR, whose `ustar` magic lives at offset 257 inside
 * the first 512-byte header block. A kibibyte covers it with room to spare and
 * matches `IMAGE_SIGNATURE_HEAD_BYTES`, so both sniffers can share one slice.
 */
export const FILE_SIGNATURE_HEAD_BYTES = 1_024;

/** Canonical display/download extension for each sniffed type. */
const EXTENSION_BY_TYPE: Readonly<Record<SniffedFileType, SniffedFileExtension>> = Object.freeze({
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.rar": ".rar",
  "application/x-7z-compressed": ".7z",
  "application/x-tar": ".tar",
  "application/gzip": ".gz",
  "application/rtf": ".rtf",
});

export function canonicalFileExtension(type: SniffedFileType): SniffedFileExtension {
  return EXTENSION_BY_TYPE[type];
}

const PDF_SIGNATURE = Buffer.from("%PDF-", "latin1");
const RTF_SIGNATURE = Buffer.from("{\\rtf", "latin1");
const SEVEN_ZIP_SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const RAR4_SIGNATURE = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
const RAR5_SIGNATURE = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
const GZIP_SIGNATURE = Buffer.from([0x1f, 0x8b]);

/**
 * ZIP local-file-header, end-of-central-directory (an empty archive), and
 * spanned-archive markers. All three begin `PK`; the two trailing bytes are what
 * distinguish a real archive from any other file that happens to start with the
 * initials of Phil Katz.
 */
const ZIP_SIGNATURES: readonly Buffer[] = Object.freeze([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08]),
]);

/**
 * Every OOXML package stores `[Content_Types].xml` as its **first** entry, by
 * requirement of ECMA-376 Part 2 (the OPC "Physical Package" clause), so the
 * name appears inside the first local file header — within 60 bytes of offset 0.
 * A plain ZIP produced by any archiver has no such requirement, so its presence
 * near the head is a reliable OOXML signal.
 */
const OOXML_MARKER = Buffer.from("[Content_Types].xml", "latin1");
/** How far in the marker is looked for. Generous, still bounded. */
const OOXML_MARKER_WINDOW = 256;

const TAR_MAGIC_OFFSET = 257;
/** POSIX `ustar\0` plus GNU's `ustar  ` (two spaces then NUL). */
const TAR_MAGICS: readonly Buffer[] = Object.freeze([
  Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72, 0x00]),
  Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72, 0x20, 0x20, 0x00]),
]);

function startsWith(head: Buffer, signature: Buffer): boolean {
  return head.length >= signature.length && head.subarray(0, signature.length).equals(signature);
}

function isZipContainer(head: Buffer): boolean {
  return ZIP_SIGNATURES.some((signature) => startsWith(head, signature));
}

function hasOoxmlMarker(head: Buffer): boolean {
  return head.subarray(0, OOXML_MARKER_WINDOW).includes(OOXML_MARKER);
}

/**
 * A TAR carries no leading magic at all — its identity lives at offset 257 — so
 * it is checked last, after every format that *does* start with a signature.
 */
function isTarArchive(head: Buffer): boolean {
  if (head.length < TAR_MAGIC_OFFSET + 6) return false;
  return TAR_MAGICS.some((magic) => {
    const end = TAR_MAGIC_OFFSET + magic.length;
    return head.length >= end && head.subarray(TAR_MAGIC_OFFSET, end).equals(magic);
  });
}

/**
 * Identify a generic file from its leading bytes.
 *
 * `declaredExtension` is a already-lowercased, dot-prefixed extension taken from
 * the untrusted filename. It participates in **one** decision and one only:
 * whether a proven OOXML ZIP is a DOCX or an XLSX. Everything else ignores it,
 * and an OOXML package with neither extension degrades to `application/zip`
 * rather than guessing — a ZIP is exactly what it is.
 *
 * Returns `null` for anything unrecognised, including truncated heads.
 */
export function sniffFileMediaType(
  head: Buffer,
  declaredExtension: string,
): SniffedFileType | null {
  // Strict offset 0. Every producer in practice writes `%PDF-` first; tolerating
  // leading junk (as some readers do) would let a file be simultaneously a valid
  // something-else and a valid PDF, which is exactly the polyglot case a sniffer
  // exists to prevent.
  if (startsWith(head, PDF_SIGNATURE)) return "application/pdf";
  if (startsWith(head, RTF_SIGNATURE)) return "application/rtf";
  if (startsWith(head, SEVEN_ZIP_SIGNATURE)) return "application/x-7z-compressed";
  // RAR 5 first: its signature is RAR 4's plus one byte, so testing the shorter
  // one first would classify every RAR 5 archive as RAR 4.
  if (startsWith(head, RAR5_SIGNATURE) || startsWith(head, RAR4_SIGNATURE)) {
    return "application/vnd.rar";
  }
  if (startsWith(head, GZIP_SIGNATURE)) return "application/gzip";

  if (isZipContainer(head)) {
    if (hasOoxmlMarker(head)) {
      if (declaredExtension === ".docx") {
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      }
      if (declaredExtension === ".xlsx") {
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      }
    }
    return "application/zip";
  }

  return isTarArchive(head) ? "application/x-tar" : null;
}
