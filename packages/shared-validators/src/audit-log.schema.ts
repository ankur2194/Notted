import { z } from "zod";

import {
  isoTimestampSchema,
  jsonValueSchema,
  paginationQuerySchema,
  uuidSchema,
} from "./common.schema";

/**
 * Part 71 — workspace audit trail contracts.
 *
 * The audit surface is READ-ONLY: there is no create/update/delete schema here
 * because `audit_logs` is append-only and is written by the server alone
 * (`apps/api/src/audit/audit-record.ts`). Only a query shape and a row shape are
 * committed.
 */

/**
 * Hard ceiling on one CSV export. An audit trail is unbounded by design, so the
 * export is a bounded WINDOW over it, not a dump: the caller narrows with
 * `from`/`to` and the filters. Without a cap a single request would stream a
 * workspace's entire history through one connection.
 */
export const AUDIT_LOG_EXPORT_MAX_ROWS = 10_000;

/** Matches `varchar(50)` on both columns in `database/schema/audit-logs.ts`. */
export const auditLogActionSchema = z.string().trim().min(1).max(50);
export const auditLogEntityTypeSchema = z.string().trim().min(1).max(50);

/**
 * The filters, shared by the list and the export so the CSV can never describe a
 * different slice than the table the admin was looking at.
 *
 * `from`/`to` bound `created_at`, which is what the
 * `(workspace_id, created_at DESC)` index serves.
 */
const auditLogFilterShape = {
  action: auditLogActionSchema.optional(),
  entityType: auditLogEntityTypeSchema.optional(),
  entityId: uuidSchema.optional(),
  userId: uuidSchema.optional(),
  from: isoTimestampSchema.optional(),
  to: isoTimestampSchema.optional(),
} as const;

const orderedRange = (value: { readonly from?: string; readonly to?: string }): boolean =>
  value.from === undefined ||
  value.to === undefined ||
  Date.parse(value.from) <= Date.parse(value.to);

const RANGE_MESSAGE = { message: "from must be earlier than or equal to to", path: ["to"] };

/** Route-scoped query: `workspaceId` comes only from the route selector. */
export const auditLogListQuerySchema = paginationQuerySchema
  .extend(auditLogFilterShape)
  .strict()
  .refine(orderedRange, RANGE_MESSAGE)
  // Same bound as `apiKeyListQuerySchema`: deep offsets are a scan, not a page.
  .refine(({ page }) => page <= 10_000, { path: ["page"], message: "page must be at most 10000" });
export type AuditLogListQueryInput = z.input<typeof auditLogListQuerySchema>;

/** The export takes no pagination — the cap above is the only bound. */
export const auditLogExportQuerySchema = z
  .object(auditLogFilterShape)
  .strict()
  .refine(orderedRange, RANGE_MESSAGE);
export type AuditLogExportQueryInput = z.input<typeof auditLogExportQuerySchema>;

/**
 * One audit row as it reaches a transport.
 *
 * `userName` is the actor's display name, joined for legibility — a table of raw
 * UUIDs is a compliance artefact nobody can read. The actor's EMAIL is
 * deliberately absent: the members list already answers "who is this", and an
 * exportable CSV is the wrong place to duplicate personal data.
 *
 * `metadata` is `jsonValueSchema` rather than a closed union because it is
 * polymorphic by entity; the server redacts it before it is ever stored.
 */
export const auditLogEntrySchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    userId: uuidSchema.nullable(),
    userName: z.string().nullable(),
    action: auditLogActionSchema,
    entityType: auditLogEntityTypeSchema,
    entityId: uuidSchema,
    metadata: jsonValueSchema,
    ipAddress: z.string().max(45).nullable(),
    userAgent: z.string().nullable(),
    requestId: z.string().nullable(),
    createdAt: isoTimestampSchema,
  })
  .strict();

export const auditLogPageSchema = z
  .object({
    items: z.array(auditLogEntrySchema).max(100).readonly(),
    page: z.number().int().min(1),
    limit: z.number().int().min(1).max(100),
    hasMore: z.boolean(),
  })
  .strict();
