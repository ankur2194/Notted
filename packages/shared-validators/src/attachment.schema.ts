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

/** Per-file image ceiling. Deliberately far below `MAX_ATTACHMENT_UPLOAD_BYTES`
 * because image ingestion decodes the whole buffer in-process. */
export const MAX_IMAGE_UPLOAD_BYTES = 15 * 1_024 * 1_024;

/** Documented generic-attachment ceiling; mirrors the API's default
 * `MAX_UPLOAD_SIZE_BYTES`. Generic file uploads land in Part 44. */
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
  .object({ items: z.array(attachmentMediaSchema) })
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
