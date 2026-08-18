import { z } from "zod";

import {
  explicitBooleanQuerySchema,
  isoTimestampSchema,
  paginationQuerySchema,
  uuidSchema,
} from "./common.schema";
import { workspaceRoleSchema } from "./workspace.schema";

export const shellBootstrapQuerySchema = z.object({ workspaceId: uuidSchema.optional() }).strict();

export const notificationKindSchema = z.enum([
  "system",
  "workspace",
  "mention",
  "comment",
  "export",
]);

export const notificationTargetTypeSchema = z.enum([
  "workspace",
  "note",
  "comment",
  "export",
  "settings",
]);

export const notificationListQuerySchema = paginationQuerySchema
  .extend({ unreadOnly: explicitBooleanQuerySchema.optional().default(false) })
  .strict()
  .refine(({ page }) => page <= 10_000, { path: ["page"], message: "page must be at most 10000" });

export const notificationReadStateSchema = z.object({ isRead: z.boolean() }).strict();

export const notificationEmailPreferenceSchema = z.object({ mentionEmail: z.boolean() }).strict();

export const workspaceSelectorSchema = z.object({ workspaceId: uuidSchema }).strict();

export const shellWorkspaceMembershipSchema = z
  .object({
    workspaceId: uuidSchema,
    name: z.string().min(1).max(255),
    slug: z.string().min(1).max(255),
    role: workspaceRoleSchema,
  })
  .strict();

export const shellBootstrapSchema = z
  .object({
    user: z
      .object({
        id: uuidSchema,
        name: z.string().min(1).max(255),
        email: z.string().email().max(255),
      })
      .strict(),
    workspaces: z.array(shellWorkspaceMembershipSchema),
    currentWorkspace: shellWorkspaceMembershipSchema.nullable(),
    permissions: z
      .object({
        canViewSettings: z.boolean(),
        canManageWorkspace: z.boolean(),
        canManageMembers: z.boolean(),
        canCreateContent: z.boolean(),
      })
      .strict(),
    notificationUnreadCount: z.number().int().min(0),
  })
  .strict();

export const notificationSummarySchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    kind: notificationKindSchema,
    actorId: uuidSchema.nullable(),
    targetType: notificationTargetTypeSchema.nullable(),
    targetId: uuidSchema.nullable(),
    summary: z.string().min(1).max(160),
    targetLabel: z.string().min(1).max(120).nullable(),
    createdAt: isoTimestampSchema,
    readAt: isoTimestampSchema.nullable(),
  })
  .strict();

export const notificationPageSchema = z
  .object({
    items: z.array(notificationSummarySchema),
    page: z.number().int().min(1),
    limit: z.number().int().min(1).max(100),
    hasMore: z.boolean(),
    unreadCount: z.number().int().min(0),
  })
  .strict();

export const notificationReadResultSchema = z
  .object({ notification: notificationSummarySchema, unreadCount: z.number().int().min(0) })
  .strict();

export const notificationsMarkAllResultSchema = z
  .object({ updatedCount: z.number().int().min(0), unreadCount: z.literal(0) })
  .strict();

export type ShellBootstrapQueryInput = z.input<typeof shellBootstrapQuerySchema>;
export type NotificationListQueryInput = z.input<typeof notificationListQuerySchema>;
export type NotificationReadStateInput = z.input<typeof notificationReadStateSchema>;
export type NotificationEmailPreferenceInput = z.input<typeof notificationEmailPreferenceSchema>;
export type WorkspaceSelectorInput = z.input<typeof workspaceSelectorSchema>;
