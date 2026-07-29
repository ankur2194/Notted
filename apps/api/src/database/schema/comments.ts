// Part 16: comments — threaded note comments with selection anchors.
//
// Per Plan Part 16 ("comment selection anchors for inline comments") and ADR
// 0004: comments are PostgreSQL entities anchored to STABLE document-relative
// positions. Comments are NOT embedded as the sole copy in Yjs — Yjs is the
// collaborative document source of truth, but comments live in PostgreSQL so
// they survive CRDT merges, compaction, and schema migrations independently
// of the document binary.
//
// ANCHOR CONTRACT (ADR 0004): inline comments carry an anchor payload that
// identifies the document selection they are attached to:
//   - `anchor_key`: a ProseMirror/relative-position key identifying the
//     document position/element the comment is anchored to.
//   - `anchor_from`/`anchor_to`: integer offset hints (e.g. character offsets
//     within a text node) capturing the selection range at creation time.
//   - `anchor_metadata`: a jsonb bag of remapping hints (e.g. Yjs relative
//     position encodings, node path, revision id at creation).
// ALL anchor columns are NULLABLE so a comment can be a WHOLE-NOTE comment
// (no selection). The DB only PERSISTS the anchor payload; REMAPPING ANCHORS
// THROUGH EDITS is editor/service logic (Part 60) — when the document
// changes, the editor reconciles anchors via the Yjs relative-position
// machinery and updates these columns or marks the comment as orphaned. This
// table does not validate anchor consistency with the current document.
//
// THREADING: `parent_id` is a self-reference (CASCADE) so a comment can have
// replies and deleting a PARENT comment cascades to its REPLIES. A top-level
// comment has `parent_id` NULL. The self-FK plus the `notes` FK together
// implement the threaded cascade:
//   - Deleting a NOTE removes all of its comments (note_id FK CASCADE).
//   - Deleting a PARENT COMMENT removes its replies (parent_id self-FK
//     CASCADE). This is verified in the live test.
//
// CONTENT FORMAT: `content` is TEXT (markdown/plain), NOT TipTap JSON. A
// lightweight text format is deliberate: comment bodies are short, primarily
// textual, and rendering them through the full document schema is overkill.
// If rich comment formatting is needed later, a dedicated mini-schema (or
// TipTap JSON) can be introduced via migration; the column type is the
// contract.
//
// RESOLUTION: `is_resolved`/`resolved_at`/`resolved_by_id` track the resolve
// lifecycle. `resolved_by_id` is nullable and uses SET NULL so deleting the
// resolver preserves the comment and its resolved state (only the resolver id
// is cleared), mirroring `notes.updated_by_id`.
//
// `created_by_id` uses RESTRICT, matching the Part 14/15 convention for
// authored shared-tenant content (notes, projects, folders): deleting the
// commenter must not silently drop the comment or its audit; the service
// (Part 26) reassigns or removes comments before the account can be removed.
//
// Conventions (copied from Part 13/14/15): see `projects.ts` module comment.

import { relations } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { notes } from "./notes";
import { users } from "./users";

// --------------------------------------------------------------------------- //
// comments
// --------------------------------------------------------------------------- //

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id")
      .references(() => notes.id, { onDelete: "cascade" })
      .notNull(),
    // Self-reference for threading. NULL = top-level comment. CASCADE: deleting
    // a parent comment removes its replies.
    parentId: uuid("parent_id").references((): AnyPgColumn => comments.id, {
      onDelete: "cascade",
    }),
    // Markdown/plain text body (NOT TipTap JSON). See module comment.
    content: text("content").notNull(),
    createdById: uuid("created_by_id")
      .references(() => users.id, { onDelete: "restrict" })
      .notNull(),
    isResolved: boolean("is_resolved").default(false).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // Resolver. Nullable + SET NULL: deleting the resolver preserves the
    // comment and its resolved state (only the resolver id is cleared).
    resolvedById: uuid("resolved_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // ---- Selection anchor (ADR 0004). All nullable; NULL = whole-note ---- //
    // ProseMirror/relative-position key identifying the anchored element.
    anchorKey: text("anchor_key"),
    // Offset hints for the selection range at creation time.
    anchorFrom: integer("anchor_from"),
    anchorTo: integer("anchor_to"),
    // Remapping hints (Yjs relative-position encoding, node path, revision
    // id at creation). Default empty object.
    anchorMetadata: jsonb("anchor_metadata").default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // "Comments on note X" lookup.
    index("comments_note_id_idx").on(t.noteId),
    // "Open vs resolved comments on note X" filtered list.
    index("comments_note_resolved_idx").on(t.noteId, t.isResolved),
    // Thread lookup: "replies of parent comment X".
    index("comments_parent_id_idx").on(t.parentId),
    // "Comments by user X" admin/authoring view.
    index("comments_created_by_id_idx").on(t.createdById),
  ],
);

// --------------------------------------------------------------------------- //
// Relations
// --------------------------------------------------------------------------- //
// Forward relations only; `notesRelations` and `usersRelations` are not
// extended here. `relationName` disambiguates the self-reference (parent vs
// children) and the two distinct `users` references (createdBy vs resolvedBy).

export const commentsRelations = relations(comments, ({ one, many }) => ({
  note: one(notes, {
    fields: [comments.noteId],
    references: [notes.id],
  }),
  // Self-relation for the reply thread.
  parent: one(comments, {
    fields: [comments.parentId],
    references: [comments.id],
    relationName: "comments_parent",
  }),
  children: many(comments, { relationName: "comments_parent" }),
  createdBy: one(users, {
    fields: [comments.createdById],
    references: [users.id],
    relationName: "comments_createdBy",
  }),
  resolvedBy: one(users, {
    fields: [comments.resolvedById],
    references: [users.id],
    relationName: "comments_resolvedBy",
  }),
}));
