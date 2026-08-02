import { z } from "zod";

import {
  isoTimestampSchema,
  paginationQuerySchema,
  sortDirectionSchema,
  uuidSchema,
} from "./common.schema";

export const workspacePlanSchema = z.enum(["free", "pro", "enterprise"]);
export const workspaceRoleSchema = z.enum(["owner", "admin", "editor", "viewer"]);
export const workspaceSettingsSchema = z
  .object({ defaultPageSize: z.enum(["a4", "letter"]) })
  .strict();

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
    settings: workspaceSettingsSchema.optional(),
  })
  .strict();
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const updateWorkspaceSchema = z
  .object({
    name: workspaceNameSchema.optional(),
    slug: workspaceSlugSchema.optional(),
    description: workspaceDescriptionSchema.optional(),
    domain: workspaceDomainSchema.optional(),
    settings: workspaceSettingsSchema.optional(),
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

// --------------------------------------------------------------------------- //
// Part 26 — workspace lifecycle I/O contracts.
//
// The list endpoint crosses the authenticated user's memberships (it is NOT
// workspace-scoped), so the query filter mirrors the shell/notification page
// shape: bounded pagination + optional name/plan/currentUserRole filters and a
// stable sort field/direction. Response shapes conceal all database-only and
// secret-bearing columns; `logoUrl` is exposed because it is public workspace
// branding. Detail responses expose the validated page default and the real
// nullable storage override without inventing quota usage.
// --------------------------------------------------------------------------- //

export const workspaceSortFieldSchema = z.enum(["name", "createdAt", "updatedAt"]);

export const workspaceListQuerySchema = paginationQuerySchema
  .extend({
    name: z.string().trim().min(1).max(255).optional(),
    plan: workspacePlanSchema.optional(),
    currentUserRole: workspaceRoleSchema.optional(),
    sortBy: workspaceSortFieldSchema.default("updatedAt"),
    sortDirection: sortDirectionSchema.default("desc"),
  })
  .strict()
  .refine(({ page }) => page <= 10_000, { path: ["page"], message: "page must be at most 10000" });
export type WorkspaceListQueryInput = z.input<typeof workspaceListQuerySchema>;

export const workspaceSummarySchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(255),
    slug: z.string().min(1).max(255),
    description: z.string().max(2_000).nullable(),
    plan: workspacePlanSchema,
    currentUserRole: workspaceRoleSchema,
    logoUrl: z.string().nullable(),
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const workspaceDetailSchema = workspaceSummarySchema
  .extend({
    domain: z.string().max(253).nullable(),
    settings: workspaceSettingsSchema,
    storageLimitBytes: z.number().int().nonnegative().safe().nullable(),
    createdById: uuidSchema,
    createdAt: isoTimestampSchema,
  })
  .strict();

export const workspacePageSchema = z
  .object({
    items: z.array(workspaceSummarySchema).readonly(),
    page: z.number().int().min(1),
    limit: z.number().int().min(1).max(100),
    hasMore: z.boolean(),
  })
  .strict();

export const workspaceCreateResultSchema = z
  .object({
    workspace: workspaceDetailSchema,
    // The final slug after collision-safe resolution; may include a short
    // numeric suffix appended by the service. Bounded by the DB column width.
    slug: z.string().min(2).max(255),
  })
  .strict();

export const workspaceUpdateResultSchema = z.object({ workspace: workspaceDetailSchema }).strict();

export const workspaceDeleteResultSchema = z
  .object({ id: uuidSchema, deleted: z.literal(true) })
  .strict();

// Safe destructive-action confirmation. `confirm: true` is the required literal
// gate; `expectedName` is an optional defense-in-depth cross-check the service
// compares against the persisted workspace name before deleting.
export const workspaceDeleteSchema = z
  .object({
    confirm: z.literal(true),
    expectedName: z.string().trim().min(1).max(255).optional(),
  })
  .strict();
export type WorkspaceDeleteInput = z.infer<typeof workspaceDeleteSchema>;

// --------------------------------------------------------------------------- //
// Part 28 — membership and invitation contracts.
// --------------------------------------------------------------------------- //

export const membershipEmailSchema = z
  .string()
  .trim()
  .email()
  .max(255)
  .transform((value) => value.toLowerCase());

export const invitationTokenSchema = z
  .string()
  .min(43)
  .max(43)
  .regex(/^[A-Za-z0-9_-]{43}$/u, "Expected an invitation token");

export const membershipListQuerySchema = paginationQuerySchema
  .strict()
  .refine(({ page }) => page <= 10_000, { path: ["page"], message: "page must be at most 10000" });

export const invitationStatusSchema = z.enum(["pending", "accepted", "revoked", "expired"]);

export const invitationListQuerySchema = paginationQuerySchema
  .extend({ status: invitationStatusSchema.optional() })
  .strict()
  .refine(({ page }) => page <= 10_000, { path: ["page"], message: "page must be at most 10000" });

export const workspaceMemberSummarySchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    userId: uuidSchema,
    name: z.string().min(1).max(255),
    email: z.string().email().max(255),
    role: workspaceRoleSchema,
    joinedAt: isoTimestampSchema,
  })
  .strict();

export const workspaceInvitationSummarySchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    email: z.string().email().max(255),
    role: workspaceRoleSchema,
    status: invitationStatusSchema,
    invitedById: uuidSchema,
    acceptedById: uuidSchema.nullable(),
    expiresAt: isoTimestampSchema,
    acceptedAt: isoTimestampSchema.nullable(),
    revokedAt: isoTimestampSchema.nullable(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const workspaceMemberPageSchema = z
  .object({
    items: z.array(workspaceMemberSummarySchema).readonly(),
    page: z.number().int().min(1).max(10_000),
    limit: z.number().int().min(1).max(100),
    hasMore: z.boolean(),
  })
  .strict();

export const workspaceInvitationPageSchema = z
  .object({
    items: z.array(workspaceInvitationSummarySchema).readonly(),
    page: z.number().int().min(1).max(10_000),
    limit: z.number().int().min(1).max(100),
    hasMore: z.boolean(),
  })
  .strict();

export const inviteWorkspaceMemberSchema = z
  .object({
    email: membershipEmailSchema,
    role: workspaceRoleSchema.default("viewer"),
  })
  .strict();

export const acceptWorkspaceInvitationSchema = z.object({ token: invitationTokenSchema }).strict();
export const changeWorkspaceMemberRoleSchema = z.object({ role: workspaceRoleSchema }).strict();

export const workspaceInviteResultSchema = z
  .object({
    invitation: workspaceInvitationSummarySchema,
  })
  .strict();
export const workspaceInvitationAcceptResultSchema = z
  .object({
    membership: workspaceMemberSummarySchema,
    joined: z.boolean(),
  })
  .strict();
export const workspaceMemberRoleChangeResultSchema = z
  .object({
    membership: workspaceMemberSummarySchema,
    previousRole: workspaceRoleSchema,
  })
  .strict();
export const workspaceInvitationResendResultSchema = z
  .object({
    revokedInvitationId: uuidSchema,
    invitation: workspaceInvitationSummarySchema,
  })
  .strict();
export const workspaceInvitationRevokeResultSchema = z
  .object({
    invitationId: uuidSchema,
    revoked: z.literal(true),
  })
  .strict();
export const workspaceMemberLeaveResultSchema = z
  .object({ memberId: uuidSchema, left: z.literal(true) })
  .strict();
export const workspaceMemberRemoveResultSchema = z
  .object({ memberId: uuidSchema, removed: z.literal(true) })
  .strict();

export type MembershipListQueryInput = z.input<typeof membershipListQuerySchema>;
export type InvitationListQueryInput = z.input<typeof invitationListQuerySchema>;
export type InviteWorkspaceMemberInput = z.input<typeof inviteWorkspaceMemberSchema>;
export type AcceptWorkspaceInvitationInput = z.infer<typeof acceptWorkspaceInvitationSchema>;
export type ChangeWorkspaceMemberRoleInput = z.infer<typeof changeWorkspaceMemberRoleSchema>;
