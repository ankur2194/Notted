import type { AttachmentId, IsoTimestamp, NoteId, UserId, WorkspaceId } from "./common";

export type AttachmentStatus = "pending" | "processing" | "ready" | "failed";

export type AttachmentMediaType = "image" | "file";

/**
 * Every variant an attachment may materialize. `original` is the sniffed,
 * byte-identical upload; the remaining three are derived renditions produced by
 * the image pipeline. The vocabulary is fixed so an object key can never carry
 * an unbounded variant segment.
 */
export type AttachmentVariantName = "original" | "full" | "medium" | "thumbnail";

/**
 * The variants a client may request from the content endpoint. `original` is
 * deliberately absent: it may hold un-rasterized active content (SVG) or a
 * format the browser cannot decode (HEIC), so it is never addressable.
 */
export type AttachmentServableVariant = "full" | "medium" | "thumbnail";

/**
 * Canonical REST surface for attachments. Part 42's browser client builds every
 * request from these builders so the client and the NestJS controller cannot
 * drift apart.
 */
export const ATTACHMENT_API_PATHS = Object.freeze({
  /**
   * Upload (POST) and list (GET). The note is a route segment so the server can
   * authorize the target note before reading a single body byte.
   */
  noteCollection: (workspaceId: string, noteId: string) =>
    `/api/v1/workspaces/${workspaceId}/notes/${noteId}/attachments`,
  /** Delete (DELETE). */
  detail: (workspaceId: string, attachmentId: string) =>
    `/api/v1/workspaces/${workspaceId}/attachments/${attachmentId}`,
  /** Authorized streamed bytes (GET). Never a storage or signed URL. */
  content: (workspaceId: string, attachmentId: string, variant?: AttachmentServableVariant) =>
    variant === undefined
      ? `/api/v1/workspaces/${workspaceId}/attachments/${attachmentId}/content`
      : `/api/v1/workspaces/${workspaceId}/attachments/${attachmentId}/content?variant=${variant}`,
} as const);

/**
 * Public projection of one stored variant. The server-side record additionally
 * carries the opaque object key; ADR 0005 forbids that key from reaching any
 * client, so it is stripped before this shape is built.
 */
export interface AttachmentVariantProjection {
  /**
   * Measured by the Part 41 pipeline from the encoder's own output, so it can
   * never disagree with the stored bytes. `null` only for a row written before
   * that pipeline existed, or one still `pending`/`processing`.
   */
  readonly width: number | null;
  readonly height: number | null;
  readonly bytes: number;
  /** Always a browser-decodable raster type: jpeg, png, gif, or webp. */
  readonly mimeType: string;
}

/**
 * Tiny inline preview used for blur-up rendering while a variant loads.
 *
 * A `data:image/webp;base64,…` string bounded to `MAX_BLUR_DATA_URI_BYTES`
 * (2 KiB) by `@notted/shared-validators`. It is carried in the attachment
 * metadata rather than stored as an object, so painting a placeholder costs no
 * extra request and no extra authorization check. It is absent when the encoder
 * exceeded the bound — a missing placeholder is never an error.
 *
 * It must never be written into the note document: `sanitizeDocumentUrl` rejects
 * `data:` URLs, and the image node stores `{ attachmentId, alt, width, height }`
 * with no `src`.
 */
export interface AttachmentBlurPlaceholder {
  readonly dataUri: string;
  readonly width: number;
  readonly height: number;
}

export interface AttachmentVariantSet {
  readonly original?: AttachmentVariantProjection;
  readonly full?: AttachmentVariantProjection;
  readonly medium?: AttachmentVariantProjection;
  readonly thumbnail?: AttachmentVariantProjection;
  readonly blur?: AttachmentBlurPlaceholder;
}

/**
 * Safe attachment metadata. Object keys, bucket names, infrastructure
 * endpoints, signed URLs and binary payloads never enter this contract.
 */
export interface AttachmentSummary {
  id: AttachmentId;
  workspaceId: WorkspaceId;
  noteId: NoteId;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  status: AttachmentStatus;
  width: number | null;
  height: number | null;
  createdAt: IsoTimestamp;
}

export interface AttachmentDetail extends AttachmentSummary {
  createdById: UserId;
}

/**
 * Attachment metadata plus the derived-variant projection the editor needs to
 * reserve layout space and paint a blur placeholder. `contentPath` is an
 * app-relative, authorization-checked API path — never a storage URL.
 */
export interface AttachmentMedia extends AttachmentSummary {
  readonly mediaType: AttachmentMediaType;
  readonly variants: AttachmentVariantSet;
  readonly contentPath: string;
}

export interface AttachmentUploadResult {
  readonly attachment: AttachmentMedia;
}

export interface AttachmentListResult {
  readonly items: readonly AttachmentMedia[];
}

export interface AttachmentDeleteResult {
  readonly id: AttachmentId;
  readonly deleted: true;
}
