import { z } from "zod";

import { paginationQuerySchema, sortDirectionSchema, uuidSchema } from "./common.schema";

export const attachmentStatusSchema = z.enum(["pending", "processing", "ready", "failed"]);
export const attachmentSortFieldSchema = z.enum(["displayName", "sizeBytes", "createdAt"]);

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
