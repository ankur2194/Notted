import { z } from "zod";

import {
  explicitBooleanQuerySchema,
  isoTimestampSchema,
  paginationQuerySchema,
  sortDirectionSchema,
  uuidSchema,
} from "./common.schema";

export const projectStatusSchema = z.enum(["active", "archived", "completed"]);
export const projectSortFieldSchema = z.enum(["name", "createdAt", "updatedAt", "dueAt"]);

const projectNameSchema = z.string().trim().min(1).max(255);
const projectDescriptionSchema = z.string().trim().max(5_000).nullable();
const projectColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, "Expected a six-digit hex color");

/**
 * Part 29 stores one canonical app-relative attachment reference. The service
 * separately proves that the UUID belongs to a ready attachment in the active
 * workspace. Restricting the entire string to this shape rejects external
 * URLs, schemes, query credentials, fragments, and control characters without
 * relying on the DOM `URL` global.
 */
export const projectCoverImageUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => {
    const prefix = "/api/v1/attachments/";
    return value.startsWith(prefix) && uuidSchema.safeParse(value.slice(prefix.length)).success;
  }, "Expected a canonical app-relative attachment reference");

export const createProjectSchema = z
  .object({
    name: projectNameSchema,
    description: projectDescriptionSchema.optional(),
    coverImageUrl: projectCoverImageUrlSchema.nullable().optional(),
    color: projectColorSchema.optional(),
    status: projectStatusSchema.optional(),
    dueAt: isoTimestampSchema.nullable().optional(),
  })
  .strict();
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    name: projectNameSchema.optional(),
    description: projectDescriptionSchema.optional(),
    coverImageUrl: projectCoverImageUrlSchema.nullable().optional(),
    color: projectColorSchema.optional(),
    status: projectStatusSchema.optional(),
    dueAt: isoTimestampSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "At least one project field is required",
  });
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

/** Route-scoped query: workspaceId is supplied only by the route selector. */
export const projectListQuerySchema = paginationQuerySchema
  .extend({
    status: projectStatusSchema.optional(),
    archived: explicitBooleanQuerySchema.optional(),
    dueFrom: isoTimestampSchema.optional(),
    dueTo: isoTimestampSchema.optional(),
    name: z.string().trim().min(1).max(255).optional(),
    sortBy: projectSortFieldSchema.default("updatedAt"),
    sortDirection: sortDirectionSchema.default("desc"),
  })
  .strict()
  .refine(({ page }) => page <= 10_000, { path: ["page"], message: "page must be at most 10000" })
  .refine(
    ({ dueFrom, dueTo }) =>
      dueFrom === undefined || dueTo === undefined || Date.parse(dueFrom) <= Date.parse(dueTo),
    { message: "dueFrom must be earlier than or equal to dueTo", path: ["dueTo"] },
  );
export type ProjectListQueryInput = z.input<typeof projectListQuerySchema>;

/**
 * Framework-neutral legacy filter retained for non-route consumers from Part
 * 6. REST must use projectListQuerySchema so a duplicated query workspaceId is
 * rejected rather than trusted.
 */
export const projectFilterSchema = paginationQuerySchema
  .extend({
    workspaceId: uuidSchema,
    status: projectStatusSchema.optional(),
    isArchived: explicitBooleanQuerySchema.optional(),
    dueFrom: isoTimestampSchema.optional(),
    dueTo: isoTimestampSchema.optional(),
    sortBy: projectSortFieldSchema.default("updatedAt"),
    sortDirection: sortDirectionSchema.default("desc"),
  })
  .strict()
  .refine(
    ({ dueFrom, dueTo }) =>
      dueFrom === undefined || dueTo === undefined || Date.parse(dueFrom) <= Date.parse(dueTo),
    { message: "dueFrom must be earlier than or equal to dueTo", path: ["dueTo"] },
  );
export type ProjectFilterInput = z.input<typeof projectFilterSchema>;

export const projectSummarySchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    name: z.string().min(1).max(255),
    description: z.string().max(5_000).nullable(),
    coverImageUrl: projectCoverImageUrlSchema.nullable(),
    color: projectColorSchema,
    status: projectStatusSchema,
    isArchived: z.boolean(),
    dueAt: isoTimestampSchema.nullable(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict()
  .refine((project) => project.isArchived === (project.status === "archived"), {
    path: ["isArchived"],
    message: "isArchived must mirror archived status",
  });

export const projectDetailSchema = projectSummarySchema
  .safeExtend({ createdById: uuidSchema })
  .strict();

export const projectPageSchema = z
  .object({
    items: z.array(projectSummarySchema),
    page: z.number().int().min(1).max(10_000),
    limit: z.number().int().min(1).max(100),
    hasMore: z.boolean(),
  })
  .strict();

export const projectCreateResultSchema = z.object({ project: projectDetailSchema }).strict();
export const projectUpdateResultSchema = z.object({ project: projectDetailSchema }).strict();
export const projectStatusResultSchema = z.object({ project: projectDetailSchema }).strict();
export const projectDeleteResultSchema = z
  .object({ id: uuidSchema, deleted: z.literal(true) })
  .strict();
