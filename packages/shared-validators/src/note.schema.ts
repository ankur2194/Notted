import { z } from "zod";

import {
  explicitBooleanQuerySchema,
  paginationQuerySchema,
  sortDirectionSchema,
  uuidSchema,
} from "./common.schema";

export const noteTypeSchema = z.enum(["document", "task-list"]);
export const pageSizeSchema = z.enum(["a4", "letter"]);
export const noteSortFieldSchema = z.enum(["title", "createdAt", "updatedAt"]);

const titleSchema = z.string().trim().min(1).max(500);

/**
 * Note metadata only. The versioned editor/Yjs document is intentionally not
 * accepted until Plan Part 33 establishes its schema and migration policy.
 */
export const createNoteMetadataSchema = z
  .object({
    projectId: uuidSchema.nullable().optional(),
    parentId: uuidSchema.nullable().optional(),
    title: titleSchema,
    type: noteTypeSchema.optional(),
    pageSize: pageSizeSchema.optional(),
    isTemplate: z.boolean().optional(),
    tagIds: z.array(uuidSchema).max(50).optional(),
  })
  .strict();
export type CreateNoteMetadataInput = z.infer<typeof createNoteMetadataSchema>;

export const updateNoteMetadataSchema = z
  .object({
    projectId: uuidSchema.nullable().optional(),
    parentId: uuidSchema.nullable().optional(),
    title: titleSchema.optional(),
    type: noteTypeSchema.optional(),
    pageSize: pageSizeSchema.optional(),
    isTemplate: z.boolean().optional(),
    isPinned: z.boolean().optional(),
    isArchived: z.boolean().optional(),
    tagIds: z.array(uuidSchema).max(50).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "At least one note metadata field is required",
  });
export type UpdateNoteMetadataInput = z.infer<typeof updateNoteMetadataSchema>;

export const noteMetadataFilterSchema = z
  .object({
    workspaceId: uuidSchema,
    projectId: uuidSchema.nullable().optional(),
    parentId: uuidSchema.nullable().optional(),
    type: noteTypeSchema.optional(),
    tagId: uuidSchema.optional(),
    isTemplate: explicitBooleanQuerySchema.optional(),
    isPinned: explicitBooleanQuerySchema.optional(),
    isArchived: explicitBooleanQuerySchema.optional(),
    page: paginationQuerySchema.shape.page,
    limit: paginationQuerySchema.shape.limit,
    sortBy: noteSortFieldSchema.default("updatedAt"),
    sortDirection: sortDirectionSchema.default("desc"),
  })
  .strict();
export type NoteMetadataFilterInput = z.input<typeof noteMetadataFilterSchema>;
