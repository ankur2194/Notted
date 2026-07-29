// Part 16: attachments — file/upload metadata with processing state + variants.
//
// Per ADR 0005: PostgreSQL is authoritative for attachment identity,
// ownership, workspace scope, object state, metadata, quota accounting, and
// retention intent. MinIO stores binary bytes ONLY. Buckets are private; no
// anonymous object URL is persisted as application data. Possession of an
// object key is NEVER sufficient for access — authorization always re-checks
// the database record within its workspace.
//
// Byte/key split (ADR 0005): `storage_key` is an OPAQUE, SERVER-GENERATED,
// normalized, immutable key. It includes a workspace partition for operations
// but is NEVER derived from the raw user filename and NEVER used as an
// authorization boundary. `original_name`/`filename` are SANITIZED DISPLAY
// metadata only (used for the download Content-Disposition). The raw user
// filename never reaches object storage as a key.
//
// Processing state model (Plan Part 16: "attachment processing status/
// variants"): the `processing_status` enum records the cross-system workflow
// from ADR 0005:
//   pending    -> quota reserved, DB record created, object not yet uploaded
//                  / not yet validated.
//   processing -> upload received; validation/transform (variants) in flight.
//   ready      -> validated; variants materialized; quota committed.
//   failed     -> upload/processing failed; reservation released and
//                  idempotent object cleanup enqueued after commit.
// `processing_error` records a human/operator-facing error code/message for
// the failed state (no raw bytes, no signed URLs, no secrets).
//
// Deletion is ASYNCHRONOUS with explicit state transitions (ADR 0005): the
// service first marks the DB record unavailable and records deletion intent
// transactionally, then performs idempotent object deletion after commit.
// Reconciliation detects orphaned/abandoned objects without treating object-
// store listings as authorization data. The DB row is therefore the durable
// record of "what should exist"; the object store follows.
//
// `variants` is a jsonb metadata bag (default `{}`) storing variant-key
// references and dimensions for processed image variants (e.g.
// `{ "thumbnail": { "key": "...", "width": 128, "height": 128 }, ... }`).
// Top-level `width`/`height` describe the PRIMARY (original) image and are
// NULL for non-image attachments or pre-metadata-extraction states. The exact
// variant shape is owned by the processing pipeline (Part 40+); this table
// only persists the variant map so reads, downloads, and cleanup can locate
// every derived object without re-listing the bucket.
//
// `media_type` is an OPTIONAL category enum ("image" vs "file") chosen here
// to let the processing pipeline (Part 40+) decide whether to generate image
// variants at all; generic files default to "file" and may receive a preview
// thumbnail out-of-band. Documented choice per the Part 16 task brief
// ("Optional mediaType enum or category — document choice if added").
//
// `size_bytes` uses `bigint` with `mode: "number"` (matches the Part 14
// `workspaces.storage_limit_bytes` convention). The DB column is bigint so
// files larger than 2 GiB are representable; the JS layer reads a Number,
// which is safe because per-workspace upload limits (Part 45) are far below
// Number.MAX_SAFE_INTEGER (~9 PiB).
//
// Conventions (copied from Part 13/14/15): see `projects.ts` module comment.

import { relations } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { notes } from "./notes";
import { users } from "./users";
import { workspaces } from "./workspaces";

// --------------------------------------------------------------------------- //
// Enums
// --------------------------------------------------------------------------- //
// Processing-state lifecycle (ADR 0005 cross-system workflow). Ordered
// pending -> processing -> ready; `failed` is the terminal error state.
export const attachmentStatusEnum = pgEnum("attachment_status", [
  "pending",
  "processing",
  "ready",
  "failed",
]);

// Optional media category. `image` attachments trigger variant generation;
// `file` attachments default to plain storage with optional preview.
export const attachmentMediaTypeEnum = pgEnum("attachment_media_type", ["image", "file"]);

// --------------------------------------------------------------------------- //
// attachments
// --------------------------------------------------------------------------- //

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id")
      .references(() => notes.id, { onDelete: "cascade" })
      .notNull(),
    // Workspace scope. Denormalized from `notes.workspace_id` for direct
    // quota/cleanup queries without a join; the service keeps it in sync and
    // the composite consistency is enforced at insert (same workspace as the
    // note). CASCADE on workspace delete removes all attachment metadata
    // (object cleanup is the asynchronous follow-up per ADR 0005).
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    // Original user-supplied filename (sanitized for display only). NOT the
    // object key. The service (Part 40+) sanitizes path separators and
    // controls encoding.
    originalName: varchar("original_name", { length: 255 }).notNull(),
    // Sanitized display filename used for the download Content-Disposition.
    // May differ from original_name after sanitization.
    filename: varchar("filename", { length: 255 }).notNull(),
    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    // File size in bytes. bigint (mode number) so values > 2 GiB are
    // representable; see module comment.
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    // Opaque server-generated object key (ADR 0005). NEVER the raw user
    // filename; NEVER an authorization boundary.
    storageKey: text("storage_key").notNull(),
    // Optional media category (see module comment).
    mediaType: attachmentMediaTypeEnum("media_type").default("file").notNull(),
    processingStatus: attachmentStatusEnum("processing_status").default("pending").notNull(),
    // Operator/user-facing error for the `failed` state. No raw bytes, no
    // signed URLs, no secrets.
    processingError: text("processing_error"),
    // Variant-key references + dimensions (thumbnail/medium/full...). Default
    // empty object; shape owned by the processing pipeline (Part 40+).
    variants: jsonb("variants").default({}),
    // Primary (original) image dimensions. NULL for non-images or before
    // metadata extraction.
    width: integer("width"),
    height: integer("height"),
    // Original uploader. RESTRICT, matching the Part 14/15 convention for
    // shared tenant entities and audit trails: deleting the uploader must not
    // silently drop attachment metadata or its audit; the service (Part 26)
    // reassigns or removes attachment rows before the account can be removed.
    createdById: uuid("created_by_id")
      .references(() => users.id, { onDelete: "restrict" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // "Attachments for note X" lookup.
    index("attachments_note_id_idx").on(t.noteId),
    // Workspace usage/quota accounting.
    index("attachments_workspace_id_idx").on(t.workspaceId),
    // Orphan/cleanup lookup by status within a workspace (reconciliation and
    // retention queries: pending/failed rows needing object cleanup).
    index("attachments_workspace_status_idx").on(t.workspaceId, t.processingStatus),
    // "Attachments uploaded by user X" admin view.
    index("attachments_created_by_id_idx").on(t.createdById),
  ],
);

// --------------------------------------------------------------------------- //
// Relations
// --------------------------------------------------------------------------- //
// Forward relations only; `notesRelations`, `workspacesRelations`, and
// `usersRelations` are not extended here, to keep prior parts immutable.

export const attachmentsRelations = relations(attachments, ({ one }) => ({
  note: one(notes, {
    fields: [attachments.noteId],
    references: [notes.id],
  }),
  workspace: one(workspaces, {
    fields: [attachments.workspaceId],
    references: [workspaces.id],
  }),
  createdBy: one(users, {
    fields: [attachments.createdById],
    references: [users.id],
    relationName: "attachments_createdBy",
  }),
}));
