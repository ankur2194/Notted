// Part 18: audit logs (append-only workspace activity trail).
//
// Per Plan Part 18: "Create ... audit logs ...". Per Notted.md "Audit Logs
// Table": a workspace-scoped, immutable record of security-relevant actions
// (create/update/delete/export/share/...) with the acting user, the affected
// entity (polymorphic type + id), and safe request context (IP, user agent,
// request id).
//
// APPEND-ONLY: there is NO `updated_at` column. Immutability (no UPDATE, no
// DELETE except via the workspace cascade) is enforced by the audit service
// (Part 71); PostgreSQL has no per-row "INSERT only" permission, so the schema
// signals intent (no updatedAt) and the service policy makes it binding.
// Retention/purge of old audit rows is owned by Part 19.
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
