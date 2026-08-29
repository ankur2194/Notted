import { z } from "zod";

import {
  isoTimestampSchema,
  paginationQuerySchema,
  sortDirectionSchema,
  uuidSchema,
} from "./common.schema";

export const attachmentStatusSchema = z.enum(["pending", "processing", "ready", "failed"]);
export const attachmentSortFieldSchema = z.enum(["displayName", "sizeBytes", "createdAt"]);
export const attachmentMediaTypeSchema = z.enum(["image", "file"]);

/**
 * The only sniffed image types the upload pipeline accepts. The server derives
 * the persisted MIME type from the file's magic bytes and compares it against
 * this list; the browser imports the same constant for its pre-flight check so
 * client and server bounds cannot drift.
 */
export const ATTACHMENT_IMAGE_MIME_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/heic",
] as const);

/**
 * The subset that can be streamed inline to a browser without rasterization.
 * SVG (active content) and HEIC (no browser decoder) are excluded and are
 * served only through a derived raster variant.
 */
export const ATTACHMENT_INLINE_MIME_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const);

/**
 * Signature-verified generic file types (Part 44).
 *
 * Every member of this list is admitted **only** when the server's hand-written
 * magic-byte sniffer (`apps/api/src/attachments/file-signature.ts`) recognises
 * the payload. The declared `Content-Type` and the filename extension are never
 * trusted; the extension is consulted for exactly one thing — telling the two
 * OOXML members apart from a plain ZIP, because DOCX and XLSX *are* ZIP
 * containers and share its magic bytes.
 *
 * `Notted.md` §6 names the supported set: PDF, DOCX, RTF (documents), XLSX
 * (spreadsheets), and ZIP/RAR/7Z/TAR (archives). GZIP is included because a
 * `.tar.gz` is the ordinary way a TAR arrives.
 */
export const ATTACHMENT_FILE_MIME_TYPES = Object.freeze([
  "application/pdf",
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.rar",
  "application/x-7z-compressed",
  "application/x-tar",
  "application/gzip",
  "application/rtf",
] as const);

/**
 * The single MIME type every admitted text or code file is stored as.
 *
 * `Notted.md` §6 lists TXT/MD/CSV/JSON/XML/JS/TS/HTML/CSS/PY. None of them has
 * a magic-byte signature, so they are admitted by an **extension allow-list plus
 * a UTF-8/NUL content scan** rather than by sniffing — and the stored type is
 * normalized to `text/plain` regardless of what the client declared. That
 * normalization is what makes an uploaded `.html` safe: the row can never claim
 * `text/html`, so no code path anywhere can be talked into rendering it. It is
 * additionally always served with `Content-Disposition: attachment` and
 * `X-Content-Type-Options: nosniff` (ADR 0005: "untrusted active content is not
 * served inline").
 */
export const ATTACHMENT_TEXT_MIME_TYPE = "text/plain" as const;

/** Canonical extensions for {@link ATTACHMENT_FILE_MIME_TYPES}, same order. */
export const ATTACHMENT_FILE_EXTENSIONS = Object.freeze([
  ".pdf",
  ".zip",
  ".docx",
  ".xlsx",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".rtf",
] as const);

/**
 * The closed extension allow-list for text and code uploads.
 *
 * This list is a *gate*, not a type: passing it only earns the file a UTF-8/NUL
 * scan, after which it is stored as {@link ATTACHMENT_TEXT_MIME_TYPE}. It is
 * also the only extension set that survives sanitization verbatim, because
 * every member is inert as a download and the extension is what makes a `.py`
 * or a `.csv` useful on the reader's machine.
 */
export const ATTACHMENT_TEXT_EXTENSIONS = Object.freeze([
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".xml",
  ".js",
  ".ts",
  ".html",
  ".htm",
  ".css",
  ".py",
] as const);

/**
 * The `accept` value for the generic-attachment file picker.
 *
 * Extensions rather than MIME types on purpose: browsers disagree wildly about
 * the type they report for `.md`, `.py`, `.ts`, and `.csv` (frequently the empty
 * string), so a MIME-based `accept` would hide legitimate files from the picker.
 * It is a courtesy filter only — the server re-derives the type from the bytes.
 */
export const ATTACHMENT_UPLOAD_ACCEPT = [
  ...ATTACHMENT_FILE_EXTENSIONS,
  ...ATTACHMENT_TEXT_EXTENSIONS,
].join(",");

export const attachmentFileMimeTypeSchema = z.enum(ATTACHMENT_FILE_MIME_TYPES);

/** Per-file image ceiling. Deliberately far below `MAX_ATTACHMENT_UPLOAD_BYTES`
 * because image ingestion decodes the whole buffer in-process. */
export const MAX_IMAGE_UPLOAD_BYTES = 15 * 1_024 * 1_024;

/**
 * Per-file generic-attachment ceiling (`Notted.md` §6: "Max file size: 50MB per
 * file"). It mirrors the API's default `MAX_UPLOAD_SIZE_BYTES`; an operator may
 * only *lower* the effective bound, never raise it past this constant.
 */
export const MAX_ATTACHMENT_UPLOAD_BYTES = 50 * 1_024 * 1_024;

export const attachmentImageMimeTypeSchema = z.enum(ATTACHMENT_IMAGE_MIME_TYPES);
export const attachmentInlineMimeTypeSchema = z.enum(ATTACHMENT_INLINE_MIME_TYPES);

export const attachmentVariantNameSchema = z.enum(["original", "full", "medium", "thumbnail"]);
export const attachmentServableVariantSchema = z.enum(["full", "medium", "thumbnail"]);

const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[/\\\0]/.test(value), "Filename must not contain path separators");
const mimeTypeSchema = z
  .string()
  .trim()
  .min(3)
  .max(100)
  .regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/i, "Expected a MIME type");

const pixelSchema = z.number().int().positive().max(100_000);

/**
 * Public variant projection. `key` is intentionally absent and `.strict()`
 * makes an accidental server-side leak of it a schema failure rather than a
 * silent disclosure.
 */
export const attachmentVariantProjectionSchema = z
  .object({
    width: pixelSchema.nullable(),
    height: pixelSchema.nullable(),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    mimeType: mimeTypeSchema,
  })
  .strict();

/**
 * Hard ceiling for the inline blur placeholder, mirrored by
 * `MAX_BLUR_DATA_URI_BYTES` in `apps/api/src/attachments/image-variants.ts` and
 * enforced at generation time as well.
 *
 * A 16 px WebP measures 150–400 bytes in practice. The bound is a *containment*
 * control, not a tuning knob: a hostile or corrupt row must not be able to
 * inject a megabyte string into every `AttachmentSummary` a note listing
 * returns. Base64 is ASCII, so the character count is the byte count.
 */
export const MAX_BLUR_DATA_URI_BYTES = 2_048;

/**
 * Tiny inline preview for blur-up rendering. It travels with the attachment
 * metadata the editor already fetches, so it costs no extra request and no extra
 * authorization check — and it NEVER enters the note document, because
 * `sanitizeDocumentUrl` rejects `data:` URLs and the image node has no attribute
 * that could hold one.
 */
export const attachmentBlurPlaceholderSchema = z
  .object({
    dataUri: z.string().min(1).max(MAX_BLUR_DATA_URI_BYTES).startsWith("data:image/"),
    width: pixelSchema,
    height: pixelSchema,
  })
  .strict();

export const attachmentVariantSetSchema = z
  .object({
    original: attachmentVariantProjectionSchema.optional(),
    full: attachmentVariantProjectionSchema.optional(),
    medium: attachmentVariantProjectionSchema.optional(),
    thumbnail: attachmentVariantProjectionSchema.optional(),
    blur: attachmentBlurPlaceholderSchema.optional(),
  })
  .strict();

export const attachmentSummarySchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    noteId: uuidSchema,
    displayName: displayNameSchema,
    mimeType: mimeTypeSchema,
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    status: attachmentStatusSchema,
    width: pixelSchema.nullable(),
    height: pixelSchema.nullable(),
    createdAt: isoTimestampSchema,
  })
  .strict();

export const attachmentDetailSchema = attachmentSummarySchema
  .extend({ createdById: uuidSchema })
  .strict();

export const attachmentMediaSchema = attachmentSummarySchema
  .extend({
    mediaType: attachmentMediaTypeSchema,
    variants: attachmentVariantSetSchema,
    contentPath: z.string().min(1).startsWith("/api/v1/"),
  })
  .strict();

export const attachmentUploadResultSchema = z
  .object({ attachment: attachmentMediaSchema })
  .strict();

export const attachmentListResultSchema = z
  .object({
    items: z.array(attachmentMediaSchema),
    limit: z.number().int().positive(),
    returned: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const attachmentDeleteResultSchema = z
  .object({ id: uuidSchema, deleted: z.literal(true) })
  .strict();

export const attachmentPageSchema = z
  .object({
    items: z.array(attachmentMediaSchema),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    hasMore: z.boolean(),
  })
  .strict();

/** Query contract for the streamed content endpoint. */
export const attachmentContentQuerySchema = z
  .object({ variant: attachmentServableVariantSchema.default("full") })
  .strict();
export type AttachmentContentQueryInput = z.input<typeof attachmentContentQuerySchema>;

/**
 * Declares upload intent metadata only. Browser File/Blob objects, bytes,
 * bucket names, object keys, and signed URLs stay outside the shared contract.
 */
export const createAttachmentIntentSchema = z
  .object({
    noteId: uuidSchema,
    displayName: displayNameSchema,
    mimeType: mimeTypeSchema,
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type CreateAttachmentIntentInput = z.infer<typeof createAttachmentIntentSchema>;

export const updateAttachmentIntentSchema = z
  .object({
    displayName: displayNameSchema.optional(),
  })
  .strict()
  .refine(({ displayName }) => displayName !== undefined, {
    message: "At least one attachment metadata field is required",
  });
export type UpdateAttachmentIntentInput = z.infer<typeof updateAttachmentIntentSchema>;

export const attachmentFilterSchema = z
  .object({
    workspaceId: uuidSchema,
    noteId: uuidSchema.optional(),
    status: attachmentStatusSchema.optional(),
    mimeType: mimeTypeSchema.optional(),
    page: paginationQuerySchema.shape.page,
    limit: paginationQuerySchema.shape.limit,
    sortBy: attachmentSortFieldSchema.default("createdAt"),
    sortDirection: sortDirectionSchema.default("desc"),
  })
  .strict();
export type AttachmentFilterInput = z.input<typeof attachmentFilterSchema>;
