// Part 64 — the `zip` bundle renderer.
//
// This is the only export format that is not a pure function of the note body:
// it packages the document plus whatever attachments, comments and version
// snapshots the requester asked for. Everything it packages was already loaded
// through ONE authorized read (`NoteExportSourceService.load`); this file adds
// no authority of its own and never touches the database or a policy. It takes
// rows and a byte reader, and produces bytes.
//
// THE GOVERNING RULE: A PARTIAL ARCHIVE BEATS NO ARCHIVE. Every bound below —
// entry count, total bytes, per-attachment bytes, version and comment counts,
// and cancellation — SKIPS the offending item and records WHY in
// `manifest.json`. None of them throws. A user who exports a note with one
// 4 GiB attachment should get their note, their other attachments, and a line
// saying which file was too large; they should not get a failed job, and they
// should certainly never get a half-written zip that a decompressor rejects.
// That is why the manifest is a first-class part of the format rather than a
// nicety: the archive is required to be honest about what it left out.
//
// UNTRUSTED INPUT: `source.content` and every version's `content` are persisted
// TipTap JSON handed to `documentToMarkdown`/`JSON.stringify`, neither of which
// evaluates it. `attachment.filename` is untrusted user text and is reduced to a
// safe entry name by `sanitizeUploadFilename` — the SAME sanitizer the upload
// path uses, not a second one that would eventually disagree with it.

import { zipSync, strToU8 } from "fflate";

import { declaredFileExtension, sanitizeUploadFilename } from "../../attachments/filename";
import { EXPORT_FORMAT_MEDIA } from "../export-renderers";

import { documentToMarkdown } from "./markdown";

import type { ExportArtifact, ExportSourceDocument } from "../export-renderers";
import type { ExportBundle, ExportBundleAttachment } from "../note-export-source.service";

/** CLOSED set. A reason that is not one of these is a reason nobody can act on. */
export type ZipSkipReason =
  "oversized" | "unreadable" | "entry_limit" | "total_limit" | "count_limit" | "aborted";

type ZipEntryKind = "manifest" | "document" | "attachment" | "comments" | "versions";

interface ZipManifestEntry {
  readonly path: string;
  readonly kind: ZipEntryKind;
  readonly bytes: number;
  readonly attachmentId?: string;
}

interface ZipManifestSkip {
  readonly kind: "attachment" | "version" | "comment";
  readonly id: string;
  readonly name: string;
  readonly reason: ZipSkipReason;
}

export interface ZipBounds {
  /** Hard cap on archive entries, including `manifest.json` and `note.md`. */
  readonly maxEntries: number;
  /** Cumulative UNCOMPRESSED byte cap. The stored artefact can only be smaller. */
  readonly maxTotalBytes: number;
  /** Per-attachment cap, so one large file cannot starve the rest of the note. */
  readonly maxAttachmentBytes: number;
  readonly maxVersions: number;
  readonly maxComments: number;
}

export const DEFAULT_ZIP_BOUNDS: ZipBounds = Object.freeze({
  // A backstop, not the working limit: `NoteExportSourceService` already caps
  // the attachment row read at 200, so a normal note never reaches this. It
  // exists so a future caller handing in a longer list still cannot make the
  // central directory unbounded.
  maxEntries: 256,
  // 25 MiB — the default of `EXPORT_MAX_ARTIFACT_BYTES`, which the caller passes
  // in. Measured UNCOMPRESSED, so honouring it here guarantees the compressed
  // artefact honours it too.
  maxTotalBytes: 26_214_400,
  // 10 MiB — roughly 40% of the archive budget. One attachment may be large;
  // one attachment may not be the entire archive.
  maxAttachmentBytes: 10_485_760,
  // A history file, not the history. 50 snapshots of TipTap JSON is already a
  // multi-megabyte document, and the newest ones are the ones anyone reads.
  maxVersions: 50,
  // Comment bodies are short text; 500 threads is far beyond any real note and
  // still a bounded JSON file.
  maxComments: 500,
});

const MANIFEST_PATH = "manifest.json";
const DOCUMENT_PATH = "note.md";
const COMMENTS_PATH = "comments.json";
const VERSIONS_PATH = "versions.json";
const ATTACHMENT_PREFIX = "attachments/";

/** Bounded de-duplication search. Beyond this the attachment id is the name. */
const MAX_DEDUPLICATION_ATTEMPTS = 100;

/**
 * Reduce an untrusted display filename to a safe, unique archive entry name.
 *
 * `sanitizeUploadFilename` does the actual work — it is the sanitizer the upload
 * path already trusts: it strips path separators, control and bidi characters
 * and Windows-illegal characters, guards reserved device names, and bounds the
 * length in bytes. The extension it forces is the one the ROW already carries
 * (`declaredFileExtension` reads it back off the same sanitized column), so
 * nothing here can introduce an extension the stored file does not have.
 *
 * The final guard is fail-closed rather than a second sanitizer: if anything
 * that could still read as a path survives, the attachment id becomes the name.
 */
function entryName(attachment: ExportBundleAttachment, used: Set<string>): string {
  const sanitized = sanitizeUploadFilename(
    attachment.filename,
    declaredFileExtension(attachment.filename),
    "attachment",
  ).filename;
  const base =
    sanitized === "" || sanitized === "." || sanitized === ".." || /[/\\]/u.test(sanitized)
      ? attachment.attachmentId
      : sanitized;

  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  // De-duplicate on the FINAL sanitized name, because two different raw
  // filenames can sanitize to the same thing, and a zip holding two identical
  // paths is a zip whose contents depend on which decompressor opened it.
  const dot = base.lastIndexOf(".");
  const stem = dot <= 0 ? base : base.slice(0, dot);
  const extension = dot <= 0 ? "" : base.slice(dot);
  for (let index = 2; index <= MAX_DEDUPLICATION_ATTEMPTS; index += 1) {
    const candidate = `${stem} (${index})${extension}`;
    if (used.has(candidate)) continue;
    used.add(candidate);
    return candidate;
  }
  // ponytail: linear probe with a hard ceiling. The attachment id is unique by
  // construction, so the fallback always terminates. Ceiling: a note carrying
  // more than 100 identically named files loses the readable names. Upgrade
  // path: none needed while the source row cap is 200.
  used.add(attachment.attachmentId);
  return attachment.attachmentId;
}

/** One line, always. A newline in a title would silently end the `#` heading. */
function headingFor(title: string): string {
  const single = title.replace(/\s+/gu, " ").trim();
  return single === "" ? "# Untitled" : `# ${single}`;
}

function jsonBytes(value: unknown): Uint8Array {
  return strToU8(`${JSON.stringify(value, null, 2)}\n`);
}

export async function renderZipArchive(input: {
  readonly source: ExportSourceDocument;
  readonly bundle: ExportBundle;
  readonly readAttachment: (objectKey: string, maxBytes: number) => Promise<Buffer | null>;
  readonly signal: AbortSignal;
  readonly bounds?: ZipBounds;
}): Promise<ExportArtifact> {
  const { source, bundle, readAttachment, signal } = input;
  const bounds = input.bounds ?? DEFAULT_ZIP_BOUNDS;
  const options = source.options;

  const files: Record<string, Uint8Array> = {};
  // `manifest.json` is listed FIRST and with `bytes: 0`, deliberately: it is the
  // complete index of the archive, so omitting itself would make the index
  // incomplete, and it cannot state its own serialized length without a
  // fixed-point solve. Zero here means "not applicable", never "empty file".
  const entries: ZipManifestEntry[] = [{ path: MANIFEST_PATH, kind: "manifest", bytes: 0 }];
  const skipped: ZipManifestSkip[] = [];
  const usedNames = new Set<string>();
  let totalBytes = 0;
  // Latches: once cancelled, every remaining item is recorded as `aborted`
  // rather than re-testing a signal that can only stay set.
  let aborted = false;

  const add = (
    path: string,
    kind: ZipEntryKind,
    bytes: Uint8Array,
    attachmentId?: string,
  ): void => {
    files[path] = bytes;
    entries.push(
      attachmentId === undefined
        ? { path, kind, bytes: bytes.byteLength }
        : { path, kind, bytes: bytes.byteLength, attachmentId },
    );
    totalBytes += bytes.byteLength;
  };

  const addJson = (
    path: string,
    entryKind: ZipEntryKind,
    skipKind: "comment" | "version",
    value: unknown,
  ): void => {
    const note = (reason: ZipSkipReason): void => {
      skipped.push({ kind: skipKind, id: entryKind, name: path, reason });
    };
    if (aborted || signal.aborted) {
      aborted = true;
      note("aborted");
      return;
    }
    if (entries.length >= bounds.maxEntries) {
      note("entry_limit");
      return;
    }
    const bytes = jsonBytes(value);
    if (totalBytes + bytes.byteLength > bounds.maxTotalBytes) {
      note("total_limit");
      return;
    }
    add(path, entryKind, bytes);
  };

  // The document is UNCONDITIONAL and is written before any bound is consulted.
  // An archive without the note it is an archive of is not a smaller archive,
  // it is the wrong file.
  add(
    DOCUMENT_PATH,
    "document",
    strToU8(`${headingFor(source.title)}\n\n${documentToMarkdown(source.content)}\n`),
  );

  if (options.includeAttachments) {
    for (const attachment of bundle.attachments) {
      const note = (reason: ZipSkipReason): void => {
        skipped.push({
          kind: "attachment",
          id: attachment.attachmentId,
          name: attachment.filename,
          reason,
        });
      };
      // Cancellation is checked BETWEEN entries, never inside one: a half-written
      // entry is the outcome a decompressor cannot recover from, so the remainder
      // is recorded as skipped and the archive is still sealed below.
      if (aborted || signal.aborted) {
        aborted = true;
        note("aborted");
        continue;
      }
      if (entries.length >= bounds.maxEntries) {
        note("entry_limit");
        continue;
      }
      if (attachment.objectKey === null) {
        note("unreadable");
        continue;
      }
      if (attachment.sizeBytes > bounds.maxAttachmentBytes) {
        note("oversized");
        continue;
      }
      const budget = bounds.maxTotalBytes - totalBytes;
      if (attachment.sizeBytes > budget) {
        // Not fatal and not the end of the loop: a later, smaller attachment can
        // still fit, and dropping it too would punish it for its neighbour.
        note("total_limit");
        continue;
      }
      const bytes = await readAttachment(
        attachment.objectKey,
        Math.min(bounds.maxAttachmentBytes, budget),
      );
      // `null` covers absent, storage-disabled AND "the object was bigger than
      // the row claimed". The reader cannot tell us which, and guessing would
      // put a wrong reason into the one file that exists to be trusted.
      if (bytes === null) {
        note("unreadable");
        continue;
      }
      add(
        `${ATTACHMENT_PREFIX}${entryName(attachment, usedNames)}`,
        "attachment",
        new Uint8Array(bytes),
        attachment.attachmentId,
      );
    }
  }

  if (options.includeComments) {
    const kept = bundle.comments.slice(0, bounds.maxComments);
    if (bundle.comments.length > kept.length) {
      // ONE aggregate row, not one per dropped comment: a manifest that grew
      // with the thing it is bounding would defeat the bound.
      skipped.push({
        kind: "comment",
        id: "comments",
        name: COMMENTS_PATH,
        reason: "count_limit",
      });
    }
    addJson(COMMENTS_PATH, "comments", "comment", kept);
  }

  if (options.includeVersionHistory) {
    const kept = bundle.versions.slice(0, bounds.maxVersions);
    if (bundle.versions.length > kept.length) {
      skipped.push({
        kind: "version",
        id: "versions",
        name: VERSIONS_PATH,
        reason: "count_limit",
      });
    }
    addJson(VERSIONS_PATH, "versions", "version", kept);
  }

  files[MANIFEST_PATH] = jsonBytes({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    note: {
      noteId: source.subject.noteId,
      workspaceId: source.subject.workspaceId,
      title: source.title,
      pageSize: source.pageSize,
    },
    // Echoed from the stored options so one look at the manifest answers "did
    // this archive contain exactly what was asked for?".
    options: {
      includeAttachments: options.includeAttachments,
      includeComments: options.includeComments,
      includeVersionHistory: options.includeVersionHistory,
    },
    entries,
    skipped,
  });

  return Object.freeze({
    body: Buffer.from(zipSync(files, { level: 6 })),
    ...EXPORT_FORMAT_MEDIA.zip,
  });
}
