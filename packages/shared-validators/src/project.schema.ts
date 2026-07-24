import { z } from "zod";

import {
  dateRangeQuerySchema,
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

export const createProjectSchema = z
  .object({
    name: projectNameSchema,
    description: projectDescriptionSchema.optional(),
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
    color: projectColorSchema.optional(),
    status: projectStatusSchema.optional(),
    dueAt: isoTimestampSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "At least one project field is required",
  });
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const projectFilterSchema = z
  .object({
    workspaceId: uuidSchema,
    status: projectStatusSchema.optional(),
    isArchived: explicitBooleanQuerySchema.optional(),
    dueFrom: dateRangeQuerySchema.shape.from,
    dueTo: dateRangeQuerySchema.shape.to,
    page: paginationQuerySchema.shape.page,
    limit: paginationQuerySchema.shape.limit,
    sortBy: projectSortFieldSchema.default("updatedAt"),
    sortDirection: sortDirectionSchema.default("desc"),
  })
  .strict()
  .refine(
    ({ dueFrom, dueTo }) =>
      dueFrom === undefined || dueTo === undefined || Date.parse(dueFrom) <= Date.parse(dueTo),
    {
      message: "dueFrom must be earlier than or equal to dueTo",
      path: ["dueTo"],
    },
  );
export type ProjectFilterInput = z.input<typeof projectFilterSchema>;
