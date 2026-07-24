import { z } from "zod";

import { uuidSchema } from "./common.schema";

export const workspacePlanSchema = z.enum(["free", "pro", "enterprise"]);
export const workspaceRoleSchema = z.enum(["owner", "admin", "editor", "viewer"]);

const workspaceNameSchema = z.string().trim().min(1).max(255);
const workspaceSlugSchema = z
  .string()
  .trim()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lower-case letters, numbers, and single hyphens");
const workspaceDescriptionSchema = z.string().trim().max(2_000).nullable();
const workspaceDomainSchema = z
  .string()
  .trim()
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
    "Expected a domain name without a protocol or path",
  )
  .nullable();

export const createWorkspaceSchema = z
  .object({
    name: workspaceNameSchema,
    slug: workspaceSlugSchema,
    description: workspaceDescriptionSchema.optional(),
    domain: workspaceDomainSchema.optional(),
  })
  .strict();
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const updateWorkspaceSchema = z
  .object({
    name: workspaceNameSchema.optional(),
    slug: workspaceSlugSchema.optional(),
    description: workspaceDescriptionSchema.optional(),
    domain: workspaceDomainSchema.optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "At least one workspace field is required",
  });
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;

export const workspaceFilterSchema = z
  .object({
    id: uuidSchema.optional(),
    slug: workspaceSlugSchema.optional(),
    name: z.string().trim().min(1).max(255).optional(),
    plan: workspacePlanSchema.optional(),
    currentUserRole: workspaceRoleSchema.optional(),
  })
  .strict();
export type WorkspaceFilterInput = z.infer<typeof workspaceFilterSchema>;
