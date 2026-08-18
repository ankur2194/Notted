// Part 62 — export job lifecycle contracts shared by `apps/api` and `apps/web`.
//
// The wire shape deliberately omits `objectKey` and every signed URL. The object
// key is a storage address, never authority (ADR 0005), and a signed URL is a
// bearer secret that must not travel in a JSON body a client may cache or log.
// `downloadPath` is the login-gated API route; the caller sends credentials and
// the server re-authorizes on every byte.

import type { IsoTimestamp, UserId, WorkspaceId } from "./common";
import type { PageMargins } from "./page-geometry";

export const EXPORT_API_PATHS = Object.freeze({
  collection: (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/exports`,
  detail: (workspaceId: string, exportId: string) =>
    `/api/v1/workspaces/${workspaceId}/exports/${exportId}`,
  cancel: (workspaceId: string, exportId: string) =>
    `/api/v1/workspaces/${workspaceId}/exports/${exportId}/cancel`,
  download: (workspaceId: string, exportId: string) =>
    `/api/v1/workspaces/${workspaceId}/exports/${exportId}/download`,
} as const);

/** Mirrors the `export_format` PostgreSQL enum. */
export type ExportFormat = "pdf" | "html" | "markdown" | "txt" | "docx" | "zip";

/** Mirrors the `export_status` PostgreSQL enum. */
export type ExportStatus = "queued" | "processing" | "ready" | "failed" | "expired" | "cancelled";

/** Mirrors the service-validated `exports.source_type` value set. */
export type ExportSource = "note" | "project" | "workspace";

/**
 * Formats the generator can actually produce today.
 *
 * Part 62 shipped `txt` end to end, Part 63 added `html`/`pdf`, and Part 64
 * added `markdown`/`docx`/`zip` — so this is now every member of `ExportFormat`.
 * It stays a separate array rather than collapsing into the type: it is the
 * CAPABILITY gate `ExportService.create` reads to refuse a format before a row
 * exists, and a deployment that loses a renderer (there is precedent — `pdf`
 * needs Chromium) shortens this list without touching the database enum.
 */
export const SUPPORTED_EXPORT_FORMATS: readonly ExportFormat[] = Object.freeze([
  "txt",
  "html",
  "pdf",
  "markdown",
  "docx",
  "zip",
]);

/** Source scopes the service accepts today. `project`/`workspace` are refused. */
export const SUPPORTED_EXPORT_SOURCES: readonly ExportSource[] = Object.freeze(["note"]);

/** The `exports.options` jsonb contract. Normalized server-side before storage. */
export interface ExportOptions {
  readonly includeAttachments: boolean;
  readonly includeComments: boolean;
  readonly includeVersionHistory: boolean;
  readonly headerText: string | null;
  readonly footerText: string | null;
  /**
   * Page margins for the paginated formats (`pdf`, `html`), in millimetres.
   *
   * `null` means "use `DEFAULT_PAGE_MARGINS`" and is the normal case: margins
   * are a per-browser viewing preference the editor keeps in `localStorage`
   * (they are NOT note state), so a client that has never changed them sends
   * nothing. Encoding the default as `null` rather than restating 20/25 here
   * keeps `page-geometry.ts` the single source of that number.
   *
   * ALWAYS UNTRUSTED. It arrives from client storage, so the server clamps it
   * with `clampMargins` before it reaches a stylesheet. The page SIZE is not
   * here on purpose: that is note state, read from `notes.page_size`.
   */
  readonly margins: PageMargins | null;
}

export interface ExportJob {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly requestedById: UserId;
  readonly format: ExportFormat;
  readonly status: ExportStatus;
  readonly sourceType: ExportSource;
  readonly sourceId: string | null;
  readonly options: ExportOptions;
  /** Machine-readable terminal failure reason; `null` unless `status` is `failed`. */
  readonly errorCode: string | null;
  /** Safe, already-redacted failure text. Never raw exception output. */
  readonly errorMessage: string | null;
  readonly createdAt: IsoTimestamp;
  readonly completedAt: IsoTimestamp | null;
  /** Outer download-grant ceiling (`signed_url_expires_at`). */
  readonly downloadExpiresAt: IsoTimestamp | null;
  /**
   * Login-gated API path for the bytes, or `null` when the job is not `ready`.
   * NEVER a presigned URL: downloads stream through the authorized route.
   */
  readonly downloadPath: string | null;
}

export interface ExportPage {
  readonly items: readonly ExportJob[];
  readonly page: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

export interface ExportCancelResult {
  readonly job: ExportJob;
}
