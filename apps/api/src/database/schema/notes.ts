// Part 15: notes — the core content entity — plus note sharing grants.
//
// Notes are workspace-scoped documents. Per ADR 0004, Yjs is the
// collaborative source of truth; this table stores the deterministic TipTap
// JSON PROJECTION for reads/search/export, an extracted plain-text
// projection, and a monotonically increasing `version` for optimistic
// concurrency. The Yjs binary state itself is persisted in a later part
// (Part 58, per ADR 0004); this table is the read/search projection and the relational
// anchor for hierarchy, ordering, sharing, tags, attachments, comments,
// versions, etc.
//
// Per ADR 0007:
// - Note ordering: explicit stable sibling ordering via `sort_order`, scoped
//   by workspace plus parent context. New notes append (max+1, computed by
//   the service); reorder is transactional and rejects cross-container or
//   cross-workspace identifiers. The schema provides a NON-UNIQUE composite
//   index `(workspace_id, parent_id, sort_order)` for the sibling lookup;
//   uniqueness within a sibling group is enforced transactionally by the
//   service (Part 31) because PostgreSQL NULL distinctness would make a
//   UNIQUE composite index inconsistent between root notes (parent_id NULL,
//   multiple rows tolerated) and child notes (parent_id NOT NULL, enforced).
//   The presence of `workspace_id` on every row lets reorder reject
//   cross-workspace IDs at the service layer.
// - Note sharing: explicit grants via `note_shares` for workspace users with
//   `view`, `comment`, or `edit`. NO public-link columns by default (public
//   sharing, if later authorized, uses revocable hashed tokens in a separate
//   table). A grant cannot exceed the actor's delegation rights or bypass
//   project restrictions; that is enforced in service/policy logic
//   (Part 24/32).
//
// Cross-tenant integrity (composite FKs — the "where feasible, composite
// constraints" the Plan calls for):
// - `notes(workspace_id, project_id) -> projects(workspace_id, id)` ensures a
//   note cannot reference another workspace's project. ON DELETE NO ACTION:
//   project deletion is mediated by the service (Part 29), which nullifies
//   `notes.project_id` for the project's notes in the same transaction
//   before deleting the project. This is a security-first deviation from
//   Notted.md's literal `onDelete: "set null"`; the observable behavior
//   ("project deletion keeps notes alive as standalone") is preserved
//   through service coordination.
// - `notes(workspace_id, folder_id) -> folders(workspace_id, id)` ensures a
//   note cannot reference another workspace's folder. Same NO ACTION +
//   service-nullification contract (Part 31).
// - `notes.parent_id -> notes.id` simple self-FK ON DELETE CASCADE deletes
//   children when a parent note is deleted (matching Notted.md's note-
//   hierarchy cascade). A composite self-FK was considered to enforce
//   same-workspace parents at the DB layer but is intentionally NOT used:
//   the simple self-FK is the well-supported Drizzle pattern, the
//   cross-workspace parent invariant is enforced by the service (Part 31)
//   alongside cycle prevention, and the parent's `workspace_id` is already
//   constrained by this table's own `workspace_id` FK.
// Cycle prevention in the parent chain is NOT expressible as a SQL CHECK and
// is enforced in service logic (Part 31).
//
// Conventions (copied from Part 13/14): see `projects.ts` module comment.

import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { folders } from "./folders";
import { projects } from "./projects";
import { users } from "./users";
import { workspaces } from "./workspaces";

// --------------------------------------------------------------------------- //
// Enums
// --------------------------------------------------------------------------- //
// Document subtype. `document` is the default free-form TipTap document.
// `task` notes surface in aggregate task progress (Part 17 owns the
// standalone task data; this column only tags the note for list/view
// filtering and dashboard roll-ups).
export const noteTypeEnum = pgEnum("note_type", ["document", "task"]);

// Permission granted by a `note_shares` row. Ordered view < comment < edit.
// Delegation-cap enforcement ("a grant cannot exceed the actor's rights")
// lives in the policy layer (Part 24/32).
export const noteSharePermissionEnum = pgEnum("note_share_permission", ["view", "comment", "edit"]);

// --------------------------------------------------------------------------- //
// notes
// --------------------------------------------------------------------------- //

export const notes = pgTable(
  "notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    // Project container. NULL = standalone note (workspace root, a folder,
    // or a child of another standalone note). Composite FK below ensures
    // same-workspace; service-mediated nullification on project delete.
    projectId: uuid("project_id"),
    // Folder container. NULL = unfiled. Composite FK below ensures
    // same-workspace; service-mediated nullification on folder delete.
    folderId: uuid("folder_id"),
    // Parent note for hierarchy. NULL = top-level within its container.
    // Simple self-FK CASCADE: deleting a parent note deletes its subtree.
    parentId: uuid("parent_id").references((): AnyPgColumn => notes.id, {
      onDelete: "cascade",
    }),
    title: varchar("title", { length: 500 }).notNull(),
    // TipTap JSON projection (ADR 0004). Default empty document. The Yjs
    // binary state is persisted separately (Part 58); this column is the
    // deterministic read/search/export projection, kept in sync by the
    // projection pipeline (Parts 33/39).
    content: jsonb("content").default({ type: "doc", content: [] }).notNull(),
    // Extracted plain text for search indexing and list previews. Updated
    // by the projection pipeline; empty string by default.
    contentPlain: text("content_plain").default(""),
    noteType: noteTypeEnum("note_type").default("document").notNull(),
    isTemplate: boolean("is_template").default(false).notNull(),
    isPinned: boolean("is_pinned").default(false).notNull(),
    isArchived: boolean("is_archived").default(false).notNull(),
    // Soft delete. `deleted_at` records when the row entered the trash; the
    // row is retained for trash/restore and the Part 19 retention policy.
    // Hard delete is a separate service-initiated permanent removal.
    isDeleted: boolean("is_deleted").default(false).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // One soft-delete operation assigns one UUID to only the active subtree
    // rows it changes. Restore uses this opaque server-only batch identity so
    // independently deleted descendants are never revived accidentally.
    deletionBatchId: uuid("deletion_batch_id"),
    // Monotonically increasing optimistic-concurrency field. The service
    // (Part 31) increments it on every content update and rejects stale
    // writes via `WHERE version = $expected`; the column default of 1 is
    // only the insert fallback.
    version: integer("version").default(1).notNull(),
    // Page size for print/export. "a4" or "letter"; the service validates.
    pageSize: varchar("page_size", { length: 10 }).default("a4").notNull(),
    // Stable sibling ordering (ADR 0007). Double precision so the service
    // can insert between siblings via midpoint without rewriting the whole
    // list; periodic re-normalization is service-side. The column default
    // of 0 is the fallback; the service computes `max(sort_order) + 1` at
    // insert time so new notes append. See module comment for why the
    // sibling uniqueness is service-enforced rather than a UNIQUE index.
    sortOrder: doublePrecision("sort_order").default(0).notNull(),
    // Original creator. RESTRICT, matching the projects/workspaces
    // convention for shared tenant entities.
    createdById: uuid("created_by_id")
      .references(() => users.id, { onDelete: "restrict" })
      .notNull(),
    // Last editor. Nullable; SET NULL preserves the note when the last
    // editor's account is removed (the creator audit remains).
    updatedById: uuid("updated_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Sibling lookup: notes that share (workspace_id, parent_id) clustered
    // together, ordered by sort_order. NON-UNIQUE: PostgreSQL NULL
    // distinctness would let multiple root notes share a sort_order under a
    // UNIQUE index while still constraining child notes, which is
    // inconsistent. Uniqueness within a sibling group is enforced
    // transactionally by the service (Part 31).
    index("notes_sibling_order_idx").on(t.workspaceId, t.parentId, t.sortOrder),
    // "List notes in project" hot path. Leftmost prefix on workspace_id
    // also covers "list notes in workspace".
    index("notes_workspace_project_idx").on(t.workspaceId, t.projectId),
    // Exact destination sibling groups used by transactional project and
    // folder append/reorder operations. The existing workspace+parent index
    // cannot distinguish equal parent contexts across these containers.
    index("notes_workspace_project_parent_order_idx").on(
      t.workspaceId,
      t.projectId,
      t.parentId,
      t.sortOrder,
    ),
    index("notes_workspace_folder_parent_order_idx").on(
      t.workspaceId,
      t.folderId,
      t.parentId,
      t.sortOrder,
    ),
    // "Recent ACTIVE notes in workspace" — partial index excludes
    // soft-deleted rows so the hot path stays small. The predicate must
    // match the planner's exactly; the service uses `is_deleted = false`.
    index("notes_workspace_active_updated_idx")
      .on(t.workspaceId, t.updatedAt)
      .where(sql`notes.is_deleted = false`),
    // "Templates in workspace" gallery.
    index("notes_workspace_template_idx").on(t.workspaceId, t.isTemplate),
    index("notes_workspace_template_updated_idx")
      .on(t.workspaceId, t.isTemplate, t.updatedAt)
      .where(sql`notes.is_deleted = false`),
    // Trash and pinned/archive views introduced by Part 31. Recent normal
    // lists continue to use notes_workspace_active_updated_idx above.
    index("notes_workspace_trash_deleted_idx").on(t.workspaceId, t.isDeleted, t.deletedAt),
    index("notes_workspace_pinned_archive_updated_idx")
      .on(t.workspaceId, t.isPinned, t.isArchived, t.updatedAt)
      .where(sql`notes.is_deleted = false`),
    index("notes_workspace_archive_updated_idx")
      .on(t.workspaceId, t.isArchived, t.updatedAt)
      .where(sql`notes.is_deleted = false`),
    // "Notes created by user" admin/authoring view.
    index("notes_created_by_id_idx").on(t.createdById),
    // Cross-tenant composite FKs (see module comment). `onDelete("no action")`
    // is chained explicitly because the `foreignKey({...})` config does not
    // accept `onDelete` directly; `no action` is also the Drizzle default, but
    // stating it makes the deliberate NO-ACTION-vs-SET-NULL tradeoff visible.
    foreignKey({
      name: "notes_workspace_project_fk",
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }).onDelete("no action"),
    foreignKey({
      name: "notes_workspace_folder_fk",
      columns: [t.workspaceId, t.folderId],
      foreignColumns: [folders.workspaceId, folders.id],
    }).onDelete("no action"),
  ],
);

// --------------------------------------------------------------------------- //
// note_shares
// --------------------------------------------------------------------------- //
// Per ADR 0007, explicit per-user grants. NO public-link columns by default.
// A grant cannot exceed the actor's delegation rights or bypass project
// restrictions; that is service/policy logic (Part 24/32). This table is
// workspace-free at the column level (`note_id` reaches `workspace_id`
// transitively); cross-workspace validation (the grantee must be an active
// member of the note's workspace, and the actor's delegation cap) is
// enforced by the service, not by a DB constraint.

export const noteShares = pgTable(
  "note_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id")
      .references(() => notes.id, { onDelete: "cascade" })
      .notNull(),
    // Grantee. CASCADE: deleting a user removes shares granted TO them
    // (shares are personal access grants and do not survive the account).
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    permission: noteSharePermissionEnum("permission").default("view").notNull(),
    // Grantor (audit). RESTRICT: deleting the grantor must not silently drop
    // the audit trail; the service (Part 26) reassigns or removes shares
    // before the grantor account can be removed.
    createdById: uuid("created_by_id")
      .references(() => users.id, { onDelete: "restrict" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // One grant per (note, user). Leftmost prefix also serves "list shares
    // for note X".
    uniqueIndex("note_shares_note_user_unique").on(t.noteId, t.userId),
    // "Notes shared with user X" lookup.
    index("note_shares_user_id_idx").on(t.userId),
  ],
);

// --------------------------------------------------------------------------- //
// Relations
// --------------------------------------------------------------------------- //
// Forward relations only; earlier parts' relation files are not modified.
// Relations use single-column field/reference metadata for the query builder
// even where the underlying DB constraint is a composite FK (composite FKs
// enforce cross-tenant integrity at the DB layer and are declared separately
// above). `relationName` disambiguates the multiple `users` references and
// the `notes` self-reference.

export const notesRelations = relations(notes, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [notes.workspaceId],
    references: [workspaces.id],
  }),
  project: one(projects, {
    fields: [notes.projectId],
    references: [projects.id],
    relationName: "notes_project",
  }),
  folder: one(folders, {
    fields: [notes.folderId],
    references: [folders.id],
    relationName: "notes_folder",
  }),
  // Self-relation for the note hierarchy tree.
  parent: one(notes, {
    fields: [notes.parentId],
    references: [notes.id],
    relationName: "notes_parent",
  }),
  children: many(notes, { relationName: "notes_parent" }),
  createdBy: one(users, {
    fields: [notes.createdById],
    references: [users.id],
    relationName: "notes_createdBy",
  }),
  updatedBy: one(users, {
    fields: [notes.updatedById],
    references: [users.id],
    relationName: "notes_updatedBy",
  }),
  shares: many(noteShares),
}));

export const noteSharesRelations = relations(noteShares, ({ one }) => ({
  note: one(notes, {
    fields: [noteShares.noteId],
    references: [notes.id],
  }),
  user: one(users, {
    fields: [noteShares.userId],
    references: [users.id],
    relationName: "note_shares_user",
  }),
  createdBy: one(users, {
    fields: [noteShares.createdById],
    references: [users.id],
    relationName: "note_shares_createdBy",
  }),
}));
