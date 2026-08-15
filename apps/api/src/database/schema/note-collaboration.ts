// Part 58: note_collaboration_states + note_collaboration_updates — the durable
// Yjs log behind live collaborative editing.
//
// WHY TWO TABLES. A Yjs room is an append-only stream of binary updates plus a
// periodically rewritten snapshot. Splitting the two concerns keeps every write
// on the hot path a single small INSERT:
//   - `note_collaboration_states` is ONE row per note: the room's authoritative
//     cursor (epoch, last accepted revision, last projected revision, the
//     `notes.version` that projection produced, and the encoded size of the
//     current durable state). Loading a room reads exactly one row.
//   - `note_collaboration_updates` is the append log: one row per accepted
//     client update, plus periodic `snapshot` rows written by compaction. A
//     room rehydrates by reading the newest `snapshot` for the current epoch
//     and replaying the `update` rows after it.
//
// `kind` distinguishes the two record shapes in one table rather than in two,
// because the reader always wants them in a single revision-ordered scan; a
// second table would force a merge join on the load path for no benefit.
//
// EPOCH is the "throw the log away" generation counter. Compaction and version
// restore both need to invalidate every prior update without deleting rows in
// the same transaction that must stay fast, and a client that reconnects with
// a stale epoch must be told to reload rather than allowed to replay updates
// against a document that no longer exists. Bumping `epoch` does that with one
// integer compare; the superseded rows are reaped afterwards.
//
// REVISION is a per-note monotonic sequence, NOT a global one. The unique index
// on (note_id, revision) is the concurrency control: two servers accepting the
// same revision for one note is a unique-violation, not a silent interleave.
//
// PROJECTION vs. the Yjs state. `projected_revision` / `projected_note_version`
// record how far the Yjs log has been projected into `notes.content` (the
// TipTap JSON of ADR 0004) and which `notes.version` that projection wrote.
// Projection is debounced (see `note-collaboration.policy.ts`) so a note under
// live editing does not rewrite its JSON projection per keystroke, and durable
// history checkpoints stay governed by `note-version-checkpoint.policy.ts`.
//
// `schema_version` mirrors `NOTE_DOCUMENT_SCHEMA_VERSION`: a stored Yjs state
// is only interpretable against the document schema that produced it, so a
// future document migration can detect and rebuild stale rooms instead of
// decoding a shape that no longer exists.
//
// PAYLOAD IS `bytea`, NOT `jsonb` AND NOT base64. A Yjs update is an opaque
// binary encoding; base64 costs 33% on every row and every read, and jsonb
// would force a lossy text round trip. drizzle-orm 0.45.2's pg-core ships no
// built-in `bytea`, so the column is declared with `customType` below — the
// same mechanism drizzle documents for it.
//
// `created_by_id` DELIBERATELY DEVIATES from `note_versions`' RESTRICT and is
// NULLABLE with ON DELETE SET NULL. `note_versions` rows are the durable audit
// trail and must never lose their author; these rows are EPHEMERAL — every one
// of them is deleted by compaction once its content is folded into a snapshot,
// so blocking an account deletion on a row that a background job is about to
// remove would be a deadlock between two correctness rules. Durable authorship
// stays in `note_versions`; when a checkpoint reads an update row whose author
// has since been deleted it falls back to `notes.updated_by_id`.
//
// NO `workspace_id` ON EITHER TABLE, matching `note_versions`. Both tables hang
// off `notes`, which is workspace-scoped, and tenant safety is enforced exactly
// as `NoteVersionsService.recordAcceptedState` enforces it: the caller runs
// `assertActiveWorkspace(...)` and proves the parent note belongs to the active
// workspace inside the SAME transaction before touching these rows. Duplicating
// `workspace_id` here would add a denormalized column that can disagree with
// `notes.workspace_id` — a second source of truth for the tenant boundary is a
// liability, not a defence.
//
// Conventions (copied from Part 13/14/15): see `projects.ts` module comment.

import { relations } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { notes } from "./notes";
import { users } from "./users";

/**
 * PostgreSQL `bytea`. drizzle-orm 0.45.2 has no built-in binary column, so the
 * driver mapping is declared once here: `Buffer` on the wire (what `pg` gives
 * and takes), `Uint8Array` in application code (what `Y.encodeStateAsUpdate`
 * returns and `Y.applyUpdate` consumes), so no call site converts by hand.
 */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
});

// --------------------------------------------------------------------------- //
// note_collaboration_states
// --------------------------------------------------------------------------- //

export const noteCollaborationStates = pgTable("note_collaboration_states", {
  // One row per note, so the note id IS the primary key: there is nothing to
  // disambiguate and a surrogate key would only permit a second, contradictory
  // room state for the same note.
  noteId: uuid("note_id")
    .primaryKey()
    .references(() => notes.id, { onDelete: "cascade" }),
  // Generation counter. Bumped by compaction and by version restore; a client
  // holding an older epoch must reload rather than replay (see module comment).
  epoch: integer("epoch").default(1).notNull(),
  // Highest accepted per-note revision. 0 means "no update accepted yet".
  lastRevision: integer("last_revision").default(0).notNull(),
  // Highest revision already folded into `notes.content`.
  projectedRevision: integer("projected_revision").default(0).notNull(),
  // The `notes.version` value the last projection wrote. No default: the row is
  // created alongside a known note version, and defaulting it to 0 would let a
  // stale-write check compare against a version that never existed.
  projectedNoteVersion: integer("projected_note_version").notNull(),
  // `NOTE_DOCUMENT_SCHEMA_VERSION` the stored state was encoded against.
  schemaVersion: integer("schema_version").default(1).notNull(),
  // Encoded size of the current durable state; the compaction policy reads it
  // without decoding the payload.
  stateBytes: integer("state_bytes").default(0).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// --------------------------------------------------------------------------- //
// note_collaboration_updates
// --------------------------------------------------------------------------- //

/** `snapshot` is a compacted full state; `update` is one accepted client delta. */
export const noteCollaborationRecordKind = pgEnum("note_collaboration_record", [
  "snapshot",
  "update",
]);

export const noteCollaborationUpdates = pgTable(
  "note_collaboration_updates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id")
      .references(() => notes.id, { onDelete: "cascade" })
      .notNull(),
    // Denormalized from `note_collaboration_states.epoch` at write time so a
    // superseded generation can be scanned and reaped without a join.
    epoch: integer("epoch").notNull(),
    // Per-note monotonic sequence; see the unique index below.
    revision: integer("revision").notNull(),
    kind: noteCollaborationRecordKind("kind").notNull(),
    // Raw Yjs binary. Never base64, never jsonb (see module comment).
    payload: bytea("payload").notNull(),
    // Encoded length of `payload`, so the compaction policy can sum pending
    // bytes without reading the payloads themselves.
    payloadBytes: integer("payload_bytes").notNull(),
    // Nullable ON DELETE SET NULL, deliberately unlike `note_versions` (see
    // module comment): these rows are ephemeral, and the checkpoint falls back
    // to `notes.updated_by_id` when the author is gone.
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // The concurrency control: two writers cannot claim the same revision for
    // one note. A conflicting write fails loudly instead of interleaving.
    uniqueIndex("note_collaboration_updates_note_revision_unique").on(t.noteId, t.revision),
    // The load path: newest snapshot then the updates after it, within the
    // current epoch. Also the reap path for a superseded epoch.
    index("note_collaboration_updates_note_epoch_revision_idx").on(t.noteId, t.epoch, t.revision),
  ],
);

// --------------------------------------------------------------------------- //
// Relations
// --------------------------------------------------------------------------- //
// Forward relations only; `notesRelations` and `usersRelations` are not
// extended here.

export const noteCollaborationStatesRelations = relations(noteCollaborationStates, ({ one }) => ({
  note: one(notes, {
    fields: [noteCollaborationStates.noteId],
    references: [notes.id],
  }),
}));

export const noteCollaborationUpdatesRelations = relations(noteCollaborationUpdates, ({ one }) => ({
  note: one(notes, {
    fields: [noteCollaborationUpdates.noteId],
    references: [notes.id],
  }),
  createdBy: one(users, {
    fields: [noteCollaborationUpdates.createdById],
    references: [users.id],
    relationName: "note_collaboration_updates_createdBy",
  }),
}));
