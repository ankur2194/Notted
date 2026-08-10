import { z } from "zod";

import {
  isoTimestampSchema,
  paginationQuerySchema,
  sortDirectionSchema,
  uuidSchema,
} from "./common.schema";

/** Neutral gray; mirrors the `tags.color` column default. */
export const TAG_DEFAULT_COLOR = "#6b7280";
export const TAG_COLOR_PATTERN = /^#[0-9a-f]{6}$/u;

/**
 * `.toLowerCase()` is load-bearing, not cosmetic: without it `#FFF000` and
 * `#fff000` persist as two distinct values under case-sensitive comparison and
 * the UI shows duplicate swatches. Normalize before the pattern check.
 */
export const tagColorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(TAG_COLOR_PATTERN, "Use a six-digit hex color such as #6b7280");

/** Matches `varchar(50)` in `apps/api/src/database/schema/tags.ts`. */
export const tagNameSchema = z.string().trim().min(1).max(50);

export const tagSortFieldSchema = z.enum(["name", "usage", "createdAt"]);

export const createTagSchema = z
  .object({
    name: tagNameSchema,
    color: tagColorSchema.default(TAG_DEFAULT_COLOR),
  })
  .strict();
export type CreateTagInput = z.input<typeof createTagSchema>;

export const updateTagSchema = z
  .object({
    name: tagNameSchema.optional(),
    color: tagColorSchema.optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.color !== undefined, {
    message: "At least one tag field is required",
  });
export type UpdateTagInput = z.input<typeof updateTagSchema>;

export const tagListQuerySchema = z
  .object({
    page: paginationQuerySchema.shape.page,
    limit: paginationQuerySchema.shape.limit,
    name: tagNameSchema.optional(),
    sortBy: tagSortFieldSchema.default("name"),
    sortDirection: sortDirectionSchema.default("asc"),
  })
  .strict();
export type TagListQueryInput = z.input<typeof tagListQuerySchema>;

export const tagSummarySchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    name: tagNameSchema,
    color: tagColorSchema,
    noteCount: z.number().int().min(0),
    taskCount: z.number().int().min(0),
    createdAt: isoTimestampSchema,
  })
  .strict();

export const tagPageSchema = z
  .object({
    items: z.array(tagSummarySchema).max(100).readonly(),
    page: z.number().int().min(1),
    limit: z.number().int().min(1).max(100),
    hasMore: z.boolean(),
  })
  .strict();

export const tagCreateResultSchema = z.object({ tag: tagSummarySchema }).strict();
export const tagUpdateResultSchema = z.object({ tag: tagSummarySchema }).strict();

// Note and task detachments stay separate so a delete confirmation can state
// both; blending them into one usage count hides task data loss.
export const tagDeleteResultSchema = z
  .object({
    tagId: uuidSchema,
    deleted: z.literal(true),
    removedNoteAssignments: z.number().int().min(0),
    removedTaskAssignments: z.number().int().min(0),
  })
  .strict();
