// Part 62/63 — the PURE, synchronous export renderers.
//
// These are plain module functions on purpose. There is no `ExportRenderer`
// interface, no registry and no per-format DI token, because an interface with
// one implementation is a factory for a single product wearing a nicer hat.
//
// WHERE THE FORMAT SWITCH LIVES. Part 62 froze a single synchronous
// `renderExportArtifact(format, source)` here; Part 63 REMOVED it. `pdf` cannot
// honour that signature: it needs an injected Chromium, so it is asynchronous
// and has a dependency. Rather than smuggle a service locator into a pure
// module, the switch moved up one level into `ExportGenerationService.render`
// (`export-generation.service.ts`), which is async and can inject
// `PdfExportService`. This file kept everything genuinely pure — the media map,
// the failure type, and the `txt`/`html` renderers it delegates to.
//
// The extension property held through Part 64: a new format is ONE arm in that
// one switch plus an entry in `SUPPORTED_EXPORT_FORMATS`. Add pure renderers
// here; add anything needing a browser, a database or storage to the service.
//
// Renderers treat `source.content` as UNTRUSTED `unknown`. It is persisted
// TipTap JSON that may predate any current schema version, so it is only ever
// handed to `extractNoteContentPlain` / `renderDocumentHtml`, both of which
// walk it defensively and never evaluate it.

import { clampMargins, DEFAULT_PAGE_MARGINS } from "@notted/shared-types";
import { extractNoteContentPlain } from "@notted/shared-validators";

import { buildStandaloneHtml } from "./export-html";

import type { ExportFormat, ExportOptions, PageMargins, PageSize } from "@notted/shared-types";

/**
 * Part 64 — IDENTIFIERS ONLY, never content and never authority.
 *
 * `zip` is the one format that is not a pure function of the note body: it
 * bundles attachments, comments and versions, each of which has to be loaded
 * through its own authorized read. Those reads need to know *which* note, in
 * *which* workspace, on behalf of *which* user — and none of that is derivable
 * from the title and the document JSON.
 *
 * These four fields are the same values the worker already re-read from
 * PostgreSQL before calling the renderer (ADR 0006: the queue payload carries
 * identifiers, the worker loads the facts). They are handles for a later
 * authorized read, NOT a grant: `NoteExportSourceService` re-authorizes
 * `note.read` for `requestedById` before it returns a single row.
 *
 * The single-file formats (`txt`, `markdown`, `html`, `pdf`, `docx`) ignore this
 * entirely, which is why it is one extra field rather than a second source type.
 */
export interface ExportSourceSubject {
  readonly workspaceId: string;
  readonly noteId: string;
  /** The requester the worker already re-authorized against the live note. */
  readonly requestedById: string;
  readonly correlationId: string | null;
}

export interface ExportSourceDocument {
  readonly title: string;
  /** Persisted TipTap JSON. Treated as untrusted `unknown` by the renderers. */
  readonly content: unknown;
  readonly options: ExportOptions;
  /**
   * The sheet, read from `notes.page_size` by the worker. AUTHORITATIVE SERVER
   * STATE, never client input — unlike `options.margins`, which is a browser
   * preference and is clamped before use.
   */
  readonly pageSize: PageSize;
  /** Identifiers the `zip` bundle re-reads through authorized services. */
  readonly subject: ExportSourceSubject;
}

/**
 * The margins a paginated renderer may actually use.
 *
 * `null` means the client never expressed a preference. Everything else came
 * out of someone's `localStorage`, so it is clamped to a pair that still
 * leaves a content column on the narrowest supported sheet.
 */
export function resolveExportMargins(options: ExportOptions): PageMargins {
  return clampMargins(options.margins ?? DEFAULT_PAGE_MARGINS);
}

export interface ExportArtifact {
  readonly body: Buffer;
  readonly mimeType: string;
  readonly fileExtension: string;
}

/**
 * The ONE closed map of format -> media facts, shared by the renderer and the
 * download path. Two independent maps would eventually disagree, and the
 * failure mode of that disagreement is a browser saving a `.txt` labelled
 * `application/pdf` — so they are the same map.
 *
 * Every format is listed even though only `txt` is producible today: the
 * `Record<ExportFormat, …>` makes the compiler the reminder when the enum
 * grows, and the media facts are the same regardless of which part implements
 * the bytes.
 */
export const EXPORT_FORMAT_MEDIA: Readonly<
  Record<ExportFormat, { readonly mimeType: string; readonly fileExtension: string }>
> = Object.freeze({
  txt: { mimeType: "text/plain; charset=utf-8", fileExtension: "txt" },
  markdown: { mimeType: "text/markdown; charset=utf-8", fileExtension: "md" },
  html: { mimeType: "text/html; charset=utf-8", fileExtension: "html" },
  pdf: { mimeType: "application/pdf", fileExtension: "pdf" },
  docx: {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fileExtension: "docx",
  },
  zip: { mimeType: "application/zip", fileExtension: "zip" },
});

/** Thrown for a format no renderer implements yet. Callers map it to a clean job failure. */
export class UnsupportedExportFormatError extends Error {
  constructor(readonly format: ExportFormat) {
    super(`No renderer is implemented for export format "${format}".`);
    this.name = "UnsupportedExportFormatError";
  }
}

/**
 * The standalone `.html` artefact.
 *
 * The string it produces is byte-for-byte the string `PdfExportService` feeds
 * to Chromium, which is the whole reason the two formats cannot drift: there
 * is one document builder, not one per format.
 */
export function renderStandaloneHtml(source: ExportSourceDocument): ExportArtifact {
  const html = buildStandaloneHtml({
    title: source.title,
    document: source.content,
    pageSize: source.pageSize,
    margins: resolveExportMargins(source.options),
  });
  return Object.freeze({
    body: Buffer.from(html, "utf8"),
    ...EXPORT_FORMAT_MEDIA.html,
  });
}

export function renderPlainText(source: ExportSourceDocument): ExportArtifact {
  // ponytail: `includeAttachments`/`includeComments`/`includeVersionHistory`
  // are stored and echoed back but do nothing in plain text — attachments are
  // binaries with no textual representation, and comments/versions want a
  // structure `.txt` does not have. Ceiling: a `txt` export is body text only.
  // Upgrade path: Part 64's `zip` renderer is where attachments belong, and
  // `markdown`/`html` are where comment and version sections become expressible.
  //
  // Blank-line separated blocks: optional header, the title, the body, optional
  // footer. `headerText`/`footerText` are already length-capped and trimmed by
  // `exportOptionsSchema`, so they are written verbatim.
  const blocks = [
    source.options.headerText,
    source.title,
    extractNoteContentPlain(source.content),
    source.options.footerText,
  ].filter((block): block is string => block !== null && block !== "");
  return Object.freeze({
    body: Buffer.from(`${blocks.join("\n\n")}\n`, "utf8"),
    ...EXPORT_FORMAT_MEDIA.txt,
  });
}
