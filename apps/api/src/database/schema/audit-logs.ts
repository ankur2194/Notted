// Part 18: audit logs (append-only workspace activity trail).
//
// Per Plan Part 18: "Create ... audit logs ...". Per Notted.md "Audit Logs
// Table": a workspace-scoped, immutable record of security-relevant actions
// (create/update/delete/export/share/...) with the acting user, the affected
// entity (polymorphic type + id), and safe request context (IP, user agent,
// request id).
//
// APPEND-ONLY: there is NO `updated_at` column, and immutability is enforced
// in the DATABASE by the `audit_logs_append_only` trigger installed in
// migration 0021 (apps/api/src/database/migrations/0021_audit_logs_append_only.sql):
// UPDATE and DELETE both raise `insufficient_privilege`. There are exactly two
// exemptions: the referential-action path (`pg_trigger_depth() > 1`), which is
// how the `workspace_id` CASCADE delete and the `user_id` SET NULL below still
// go through, and a DELETE while `notted.audit_purge = 'on'` for the current
// transaction, which only the Part 71 retention purge
// (`AuditLogRetentionService`) and test fixtures set, via `allowAuditDelete()`
// in apps/api/src/audit/audit-record.ts. Retention/purge of old audit rows is
// owned by Part 71, not Part 19 (Part 19 only ships the retention-window
// config; see `retention.config.ts`).
//
// `entity_id` is a polymorphic uuid with NO foreign key: an audit row can
// reference any auditable entity (note, project, workspace, task, user, api
// key, webhook, ...). A FK cannot encode "one of many tables"; the service
// (Part 71) validates `entity_type` against an allow-list and treats
// `entity_id` as an opaque identifier for redaction/retention.
//
// `metadata` is jsonb for structured, query-safe details (e.g.
// `{ "from": "editor", "to": "admin" }` for a role change). Per ADR 0007 and
// the Part 71 audit-service contract, metadata MUST NOT carry document
// content, credentials, tokens, signed URLs, or personal data — only the
// minimal structured facts the audit surface needs. The schema cannot enforce
// "no secrets in jsonb"; the service redacts before insert. Defaults to `{}`
// and is NOT NULL so "no metadata" is an explicit empty object, mirroring the
// Part 14 `workspaces.settings` convention (a minor, documented deviation from
// the Notted.md sample which omits `.notNull()`).
//
// `user_id` is nullable + SET NULL: an audit event must persist even after the
// acting user is deleted (e.g. system events, or post-deletion forensics), so
// the row is preserved with a NULL actor rather than cascaded away.
//
// Deletion model:
// - `workspace_id` CASCADE: deleting a workspace removes its audit trail
//   (audit rows are tenant-scoped and do not survive the tenant).
// - `user_id` SET NULL: see above.
//
// Conventions (copied from Part 13–17): see `note-embeddings.ts` module
// comment.

import { relations } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { users } from "./users";
import { workspaces } from "./workspaces";

// --------------------------------------------------------------------------- //
// audit_logs
// --------------------------------------------------------------------------- //

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    // Acting user. Nullable + SET NULL so the event survives user deletion
    // (system events have no actor; forensics survive account removal).
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    // Action verb, e.g. "create", "update", "delete", "export", "share",
    // "member.role.change". The service (Part 71) validates against an
    // allow-list. varchar(50) matches the Notted.md sample.
    action: varchar("action", { length: 50 }).notNull(),
    // Polymorphic entity type, e.g. "note", "project", "workspace", "task",
    // "api_key", "webhook". The service validates against an allow-list.
    entityType: varchar("entity_type", { length: 50 }).notNull(),
    // Polymorphic entity id. NO foreign key — an audit row can reference any
    // auditable table. Treated as an opaque identifier by the service.
    entityId: uuid("entity_id").notNull(),
    // Structured, query-safe details. MUST NOT carry content/secrets/tokens/
    // signed URLs (service redaction — Part 71). NOT NULL with default `{}`
    // so "no metadata" is explicit (Part 14 `workspaces.settings` convention).
    metadata: jsonb("metadata").default({}).notNull(),
    // Safe request context. ipAddress is varchar(45) to fit both IPv4 and
    // full IPv6 (`::ffff:a.b.c.d` and 8-group addresses). userAgent and
    // requestId are bounded by the service; requestId correlates logs/traces.
    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
    // NO updated_at — append-only (immutability is service-enforced, Part 71).
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // "Recent activity in workspace X" hot path, newest first. DESC ordering
    // on created_at so the index can serve reverse scans without a sort.
    index("audit_logs_workspace_created_idx").on(t.workspaceId, t.createdAt.desc()),
    // "Audit history for entity Y in workspace X" lookup. Leftmost
    // workspace_id prefix also covers workspace-wide scans.
    index("audit_logs_workspace_entity_idx").on(t.workspaceId, t.entityType, t.entityId),
    // "Actions taken by user Z" cross-workspace admin/forensics lookup.
    index("audit_logs_user_id_idx").on(t.userId),
    // Part 71 retention sweep scans workspace-agnostically by
    // `created_at < cutoff` ordered by (created_at, id). None of the indexes
    // above serve that (all are workspace_id- or user_id-leading), so without
    // this the purge sequentially scans an ever-growing table. Mirrors the
    // Part 55 `note_versions_retention_scan_idx` (migration 0018).
    index("audit_logs_retention_scan_idx").on(t.createdAt, t.id),
  ],
);

// --------------------------------------------------------------------------- //
// Relations
// --------------------------------------------------------------------------- //
// Forward relations only; `workspacesRelations` and `usersRelations` are not
// extended, to keep earlier parts immutable per the handoff rules.

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [auditLogs.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [auditLogs.userId],
    references: [users.id],
    relationName: "audit_logs_user",
  }),
}));
