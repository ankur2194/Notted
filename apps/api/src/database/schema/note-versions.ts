// Part 16: note_versions — version snapshot rows for note history/restore.
//
// Per Plan Part 16 ("version metadata/title if restoration should reproduce
// the whole note"). `note_versions` stores POINT-IN-TIME SNAPSHOT rows of a
// note so the history/restore UI (Part 55+) can show prior states and roll a
// note back to a previous version. Each row is the accepted POST-SAVE state at
// version N; create/copy establish v1 and successful non-collaborative updates
// append their new state in the same transaction.
//
// DISTINCTION FROM `notes.version`: there are TWO distinct version concepts
// and they MUST NOT be confused:
//   - `notes.version` (Part 15) is a monotonically increasing OPTIMISTIC-
//     CONCURRENCY integer incremented on every content update and used by the
//     service (Part 31) to reject stale concurrent writes via
//     `WHERE version = $expected`. It is NOT a history record.
//   - `note_versions.version` (this table) is the SNAPSHOT of the
//     `notes.version` value at the moment this row was captured. It records
//     "this snapshot represents the note as it was at version N". The column
//     is informational metadata for the snapshot, not an independent counter.
// The snapshot cadence ("when to write a row") is owned by the projection/
// history pipeline (Part 55); this table only persists the snapshot.
//
// RESTORE REPRODUCES THE WHOLE NOTE: per Plan Part 16, `title` is captured at
// snapshot time (NOT NULL, varchar 500) so restoring a version reproduces both
// the title and the content. `content` is the TipTap JSON projection snapshot
// (ADR 0004) and `content_plain` is the extracted plain text at snapshot time
// (default empty string). Restoring a row therefore reproduces the full note
// state (title + content) without needing to join other tables. The Yjs
// binary state for the snapshot is a separate concern (Part 58); this row
// is the deterministic projection snapshot.
//
// RETENTION (Part 55) is plan-aware: finite free-plan windows are purged by a
// bounded global maintenance job while paid null windows are unlimited. The
// purge preserves each note's earliest, latest, and current-version checkpoint.
//
// `created_by_id` (the user whose edit produced the snapshotted state) uses
// RESTRICT, matching the Part 14/15 convention for audit trails: deleting the
// author must not silently drop version history; the service (Part 26)
// reassigns or removes history rows before the account can be removed.
//
// Conventions (copied from Part 13/14/15): see `projects.ts` module comment.

import { relations } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { notes } from "./notes";
import { users } from "./users";

// --------------------------------------------------------------------------- //
// note_versions
// --------------------------------------------------------------------------- //

export const noteVersions = pgTable(
  "note_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id")
      .references(() => notes.id, { onDelete: "cascade" })
      .notNull(),
    // The `notes.version` value this snapshot captures (see module comment:
    // NOT an independent counter; it is the snapshot of the optimistic-
    // concurrency field at capture time).
    version: integer("version").notNull(),
    // Title at snapshot time so restore reproduces the whole note.
    title: varchar("title", { length: 500 }).notNull(),
    // TipTap JSON projection snapshot (ADR 0004).
    content: jsonb("content").notNull(),
    // Extracted plain text at snapshot time. Default empty string.
    contentPlain: text("content_plain").default(""),
    // User whose edit produced the snapshotted state. RESTRICT (audit).
    createdById: uuid("created_by_id")
      .references(() => users.id, { onDelete: "restrict" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Ordered version retrieval: newest-first history of a note. A btree
    // index on (note_id, created_at) supports a reverse (DESC) scan for
    // "newest first" without a per-column `.desc()` modifier, matching the
    // Part 15 index style.
    index("note_versions_note_created_idx").on(t.noteId, t.createdAt),
    // One immutable snapshot per optimistic-concurrency version of a note.
    // This unique index is also the restore-by-version lookup path.
    uniqueIndex("note_versions_note_version_unique").on(t.noteId, t.version),
    // "Snapshots produced by user X" admin/authoring view.
    index("note_versions_created_by_id_idx").on(t.createdById),
    // Global retention sweep orders eligible rows by (created_at,id). This
    // avoids a full-table sort while the per-note history indexes remain tuned
    // for interactive reads.
    index("note_versions_retention_scan_idx").on(t.createdAt, t.id),
  ],
);

// --------------------------------------------------------------------------- //
// Relations
// --------------------------------------------------------------------------- //
// Forward relations only; `notesRelations` and `usersRelations` are not
// extended here.

export const noteVersionsRelations = relations(noteVersions, ({ one }) => ({
  note: one(notes, {
    fields: [noteVersions.noteId],
    references: [notes.id],
  }),
  createdBy: one(users, {
    fields: [noteVersions.createdById],
    references: [users.id],
    relationName: "note_versions_createdBy",
  }),
}));
