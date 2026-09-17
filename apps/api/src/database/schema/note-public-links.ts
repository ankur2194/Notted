// Public share links: one revocable, unauthenticated read-only
// link per note. Anticipated by the `notes.ts` module comment ("public
// sharing, if later authorized, uses revocable hashed tokens in a separate
// table") since Part 15.
//
// WHY A SEPARATE TABLE FROM `note_shares`. `note_shares` grants a specific
// workspace member a permission; a public link has no target member and no
// permission tier — it is a single yes/no capability gate. Folding it into
// `note_shares` would mean a nullable `user_id` meaning two different things
// depending on which other columns are set.
//
// TOKEN_HASH proves an INCOMING token without ever reading the row: it is a
// peppered HMAC-SHA256 digest (`note-public-link-token.ts`), the same
// construction `api_keys` uses, and the public GET route's only query is
// `where token_hash = $1`. Unlike an API key, the link itself is meant to be
// re-displayed and re-copied by its owner at any time — it is a share link,
// not a rotated credential — so `encrypted_token`/`encryption_key_version`
// ALSO carry the raw token, reversibly, via AES-256-GCM
// (`note-public-link-token-encryption.ts`, same key-rotation-aware
// `SECURITY_CONFIG` infrastructure `webhook-secret.service.ts` uses). A
// database-only compromise still cannot use `token_hash` to forge or resolve
// a link; it can only recover a link's URL if it also holds
// `DATA_ENCRYPTION_KEYS`, which the database itself never stores.
//
// `encrypted_token`/`encryption_key_version` are NULLABLE, not `.notNull()`,
// for a reason that is not optional: a row written before this pair existed
// has no raw token anywhere to backfill it from — only its hash was ever
// stored, by design, before this change. `NOT NULL` would have made the
// migration that added these columns fail outright against any database that
// already held a link. `NotePublicLinksService#status` treats a `NULL` pair
// exactly like a decrypt failure: "enabled", but `url: null`, prompting a
// regenerate rather than crashing or silently exposing a token it does not
// have.
//
// ONE LINK PER NOTE (`note_id` UNIQUE). v1 is a toggle, not a list:
// regenerating deletes the existing row and inserts a fresh one in the same
// transaction, which is also how revoke-then-recreate behaves. No
// `is_revoked` flag and no history — revoke is a row delete.
//
// `workspace_id` IS DENORMALIZED, matching `notes.project_id` /
// `notes.folder_id`: it lets the composite FK below prove a link can only
// ever point at a note in the SAME workspace it claims, and lets the
// (unauthenticated) public lookup avoid a second join to prove tenancy.
//
// Deletion model:
// - `note_id` CASCADE — a hard-deleted note takes its link with it. A
//   soft-deleted (trashed) note does NOT delete the row: the public GET
//   endpoint 404s while `notes.is_deleted = true` and the same link starts
//   working again the moment the note is restored, with no re-share step.
// - `created_by_id` SET NULL — matches `workspace_domains.created_by_id`; a
//   departed creator must not block the link or the note. "Who created this
//   link" lives in the audit trail (`note.publicLink.created`), not this FK.

import { relations } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { notes } from "./notes";
import { users } from "./users";
import { workspaces } from "./workspaces";

export const notePublicLinks = pgTable(
  "note_public_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id")
      .references(() => notes.id, { onDelete: "cascade" })
      .notNull()
      .unique("note_public_links_note_id_unique"),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    // Hex HMAC-SHA256 digest, 64 characters. See module comment.
    tokenHash: varchar("token_hash", { length: 64 })
      .notNull()
      .unique("note_public_links_token_hash_unique"),
    // Base64 AES-256-GCM blob (nonce + auth tag + ciphertext), see module
    // comment. Reversible so the owner can re-copy the link at any time.
    // Nullable: see module comment.
    encryptedToken: text("encrypted_token"),
    // Names the key `encryptedToken` was written with, so a `DATA_ENCRYPTION_KEYS`
    // rotation keeps every existing row decryptable. Same convention as
    // `webhooks.encryption_key_version`. Nullable: see module comment.
    encryptionKeyVersion: integer("encryption_key_version"),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // Present per project convention; never actually mutated — revoke
    // deletes the row instead of flipping a flag, and regenerate deletes
    // and re-inserts rather than updating in place.
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // The public lookup's ONLY query: `where token_hash = $1`. The UNIQUE
    // constraint above already serves this as an index; no separate index
    // needed.
    index("note_public_links_created_by_id_idx").on(t.createdById),
    // Cross-tenant integrity, same pattern as `notes.project_id` /
    // `notes.folder_id`: a link's `(workspace_id, note_id)` must resolve to
    // a note in that same workspace.
    foreignKey({
      name: "note_public_links_workspace_note_fk",
      columns: [t.workspaceId, t.noteId],
      foreignColumns: [notes.workspaceId, notes.id],
    }).onDelete("cascade"),
  ],
);

export const notePublicLinksRelations = relations(notePublicLinks, ({ one }) => ({
  note: one(notes, {
    fields: [notePublicLinks.noteId],
    references: [notes.id],
  }),
  workspace: one(workspaces, {
    fields: [notePublicLinks.workspaceId],
    references: [workspaces.id],
  }),
  createdBy: one(users, {
    fields: [notePublicLinks.createdById],
    references: [users.id],
  }),
}));
