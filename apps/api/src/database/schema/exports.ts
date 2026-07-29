// Part 18: export jobs (PDF/HTML/Markdown/DOCX/TXT/ZIP generation).
//
// Per Plan Part 18: "Create ... exports ...". Per ADR 0007 "Export records":
// workspace/user-owned export jobs with format, source scope, status,
// signed-link expiry, object-retention expiry, object key, and error code.
// Authorization is rechecked at creation AND download. Objects remain private;
// download grants expire after seven days. Object retention is a SEPARATE
// lifecycle policy: retain completed export objects for seven days by default,
// then delete asynchronously; failed/cancelled jobs cannot be downloaded and
// their partial objects are cleaned up promptly. Per ADR 0005: PostgreSQL is
// authoritative for export identity/ownership/state/metadata; MinIO stores
// only the private binary bytes; the object key is opaque and possession of a
// key never grants access.
//
// STATE MACHINE (export_status):
//   queued → processing → ready      (happy path; object upload completes)
//                       → failed     (generation/upload failed)
//   queued|processing → cancelled    (user/system cancellation)
//   ready → expired                   (download grant OR object retention
//                                      elapsed; the cleanup job flips ready
//                                      rows to expired after object deletion)
// Only `ready` rows are downloadable. `failed`, `cancelled`, and `expired`
// rows have no usable object; the service (Part 62) refuses download and the
// cleanup job deletes any partial object for failed/cancelled rows promptly.
//
// TWO TIMESTAMPS, TWO LIFECYCLES (deliberate split per ADR 0007):
// - `signed_url_expires_at` is the DOWNLOAD GRANT expiry: how long the
//   authorized streaming/signed-URL grant returned to the user remains valid.
//   Capped at 7 days (Notted.md "Download link expires after 7 days"). A
//   separate short-lived grant (SECURITY_CONFIG.signedUrlTtlSeconds, default
//   900s) is minted per-download; this column records the outer 7-day ceiling
//   after which no new per-download grant may be issued.
// - `object_expires_at` is the OBJECT RETENTION expiry: when the cleanup job
//   (Parts 45/62) should delete the MinIO object and flip the row to `expired`.
//   Defaults to 7 days after `ready` (ADR 0007). This is INDEPENDENT of the
//   download grant: an object may be retained briefly beyond grant expiry for
//   reconciliation, or deleted before grant expiry if cancelled. The partial
//   index below targets this column for the cleanup scan.
//
// AUTHORIZATION RECHECK (ADR 0007): the service (Part 62) rechecks workspace
// membership and source-scope access BOTH at creation (can this user export
// this note/project/workspace?) AND at download (is the requester still
// authorized?). Possession of an export id or object key never grants access;
// the row's `workspace_id` + `requested_by_id` + the source-scope policy are
// the authorization boundary, re-evaluated live.
//
// `object_key` is the opaque MinIO key (ADR 0005: server-generated,
// workspace-partitioned, normalized, immutable; NOT the raw filename). NULL
// until the upload completes (`status = ready`). Possession of the key is not
// authorization; the storage adapter (Part 63) authorizes via the DB row.
//
// `options` jsonb carries the export choices (include/exclude attachments,
// comments, version history; custom header/footer text — Notted.md "Export
// Options"). NOT NULL with default `{}` (Part 14 `settings` convention). The
// service validates the shape; the schema only stores it.
//
// `source_type` + `source_id` describe what is being exported:
// - source_type ∈ {"note", "project", "workspace"} (varchar; the service
//   validates against this set).
// - source_id is NULL when source_type = "workspace" (the workspace_id column
//   IS the source) and non-NULL for note/project exports. source_id is a
//   polymorphic uuid with NO foreign key (the export outlives note/project
//   deletion; the object remains downloadable within its retention window even
//   if the source is gone).
//
// `error_code` (machine-readable, e.g. "generation_failed",
// "quota_exceeded") and `error_message` (safe, localized-safe text) record the
// terminal failure reason. Both NULL for non-failed rows.
//
// Deletion model:
// - `workspace_id` CASCADE: deleting a workspace removes its export JOB records
//   (the MinIO objects are cleaned up asynchronously by the cleanup job,
//   ADR 0005 deletion flow).
// - `requested_by_id` RESTRICT: deleting the user who requested an export must
//   not silently drop the job record/audit; the service reassigns before
//   account deletion (Part 14/15/16/17 audit convention).
//
// Conventions (copied from Part 13–17): see `note-embeddings.ts` module
// comment. `sql` is imported from `"drizzle-orm"` for the partial index
// predicate (Part 13/15 convention: `sql` always from `drizzle-orm`, never
// `pg-core`).

import { relations, sql } from "drizzle-orm";
import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { users } from "./users";
import { workspaces } from "./workspaces";

// --------------------------------------------------------------------------- //
// Enums
// --------------------------------------------------------------------------- //
// Export formats. `zip` carries a bundle (e.g. note + attachments, or a whole
// project). Notted.md lists PDF/Markdown/HTML/DOCX/TXT; zip is added per
// ADR 0007 ("include/exclude attachments as separate files in ZIP").
export const exportFormatEnum = pgEnum("export_format", [
  "pdf",
  "html",
  "markdown",
  "txt",
  "docx",
  "zip",
]);

// Export job lifecycle (see state-machine comment above).
export const exportStatusEnum = pgEnum("export_status", [
  "queued",
  "processing",
  "ready",
  "failed",
  "expired",
  "cancelled",
]);

// --------------------------------------------------------------------------- //
// exports
// --------------------------------------------------------------------------- //

export const exportJobs = pgTable(
  "exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    // User who requested the export. RESTRICT (audit convention); the service
    // reassigns before account deletion.
    requestedById: uuid("requested_by_id")
      .references(() => users.id, { onDelete: "restrict" })
      .notNull(),
    format: exportFormatEnum("format").notNull(),
    // Export options (include/exclude attachments/comments/versions, header/
    // footer text). NOT NULL with default `{}` (Part 14 `settings` convention).
    options: jsonb("options").default({}).notNull(),
    status: exportStatusEnum("status").default("queued").notNull(),
    // Source scope. "note" | "project" | "workspace" (service-validated).
    sourceType: varchar("source_type", { length: 50 }).notNull(),
    // Source id. NULL for workspace-wide exports (workspace_id is the source);
    // non-NULL for note/project exports. NO foreign key: the export outlives
    // note/project deletion within its retention window.
    sourceId: uuid("source_id"),
    // Opaque MinIO object key (ADR 0005). NULL until upload completes
    // (status = ready). Possession of the key is not authorization.
    objectKey: text("object_key"),
    // Object RETENTION expiry (7 days after ready per ADR 0007). The cleanup
    // job deletes the object and flips the row to `expired` after this time.
    objectExpiresAt: timestamp("object_expires_at", { withTimezone: true }),
    // DOWNLOAD GRANT ceiling (7 days per Notted.md). After this, no new
    // per-download signed URL/streaming grant may be issued even if the object
    // still exists. Independent of object_expires_at.
    signedUrlExpiresAt: timestamp("signed_url_expires_at", { withTimezone: true }),
    // Terminal failure reason (machine-readable). NULL for non-failed rows.
    errorCode: text("error_code"),
    // Safe, localized-safe failure message. NULL for non-failed rows.
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // When the job reached a terminal state (ready/failed/expired/cancelled).
    // NULL while queued/processing.
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    // "Exports in workspace X, newest first" admin/history view.
    index("exports_workspace_created_idx").on(t.workspaceId, t.createdAt),
    // "Exports requested by user X" admin/authoring view.
    index("exports_requested_by_id_idx").on(t.requestedById),
    // "Queued/processing jobs to run" + "ready jobs to surface" dispatcher/
    // UI scan. Also serves the cleanup flip of ready → expired.
    index("exports_status_idx").on(t.status),
    // PARTIAL index for the object-retention cleanup job: only rows that HAVE
    // an object expiry are indexed, keeping the scan tight. The cleanup job
    // (Parts 45/62) scan `object_expires_at <= now()` under this index.
    index("exports_object_expires_at_idx")
      .on(t.objectExpiresAt)
      .where(sql`exports.object_expires_at is not null`),
  ],
);

// --------------------------------------------------------------------------- //
// Relations
// --------------------------------------------------------------------------- //
// Forward relations only; `workspacesRelations` and `usersRelations` are not
// extended, to keep earlier parts immutable per the handoff rules.

export const exportJobsRelations = relations(exportJobs, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [exportJobs.workspaceId],
    references: [workspaces.id],
  }),
  requestedBy: one(users, {
    fields: [exportJobs.requestedById],
    references: [users.id],
    relationName: "exports_requestedBy",
  }),
}));
