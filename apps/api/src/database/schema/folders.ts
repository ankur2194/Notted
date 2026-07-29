// Part 15: folders — workspace-owned nesting containers, separate from notes.
//
// Per ADR 0007, folders are workspace-owned containers, NOT a note subtype. A
// note has at most one `folder_id` (declared on `notes`); folders may nest to
// a MAXIMUM DEPTH OF THREE levels. The depth limit AND cycle prevention are
// enforced in SERVICE logic (Part 31) — neither is expressible as a column
// CHECK. The schema provides only a self-referential foreign key so deleting
// a parent folder cascades to its subtree, and a workspace-scoped lookup
// index for tree reads. A cross-workspace self-FK is intentionally NOT added:
// the simple self-FK on `parent_id` is well-supported by Drizzle and the
// same-workspace invariant for folder parents is enforced by the service
// (Part 31) alongside the depth/cycle checks.
//
// Folder ordering within a parent is not specified by the brief or ADR 0007
// (only NOTE ordering is). A `sort_order` column is therefore omitted here;
// if folder ordering becomes a requirement, add it in a later part with a
// service-enforced unique-on-(workspace_id, parent_id) constraint.
//
// Folder deletion: `parent_id` uses `ON DELETE CASCADE` so deleting a folder
// also removes its descendant folders. Notes reference folders via a
// composite FK with `ON DELETE NO ACTION` (see `notes.ts`), so the service
// (Part 31) must first nullify `notes.folder_id` for every folder in the
// subtree before deleting the root folder. This contract is documented here
// so Part 31 implementers know the cascade behavior.
//
// Conventions (copied from Part 13/14): see `projects.ts` module comment.

import { relations } from "drizzle-orm";
import {
  type AnyPgColumn,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./users";
import { workspaces } from "./workspaces";

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    // Self-reference for nesting. NULL = root-level folder. The depth limit
    // (max 3) and cycle prevention are SERVICE logic (Part 31); the schema
    // only models the edge and the cascade behavior.
    parentId: uuid("parent_id").references((): AnyPgColumn => folders.id, {
      onDelete: "cascade",
    }),
    name: varchar("name", { length: 255 }).notNull(),
    // Original creator. RESTRICT, matching the projects/workspaces convention
    // for shared tenant entities; the service (Part 26) handles reassignment
    // before account deletion.
    createdById: uuid("created_by_id")
      .references(() => users.id, { onDelete: "restrict" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Composite FK target for `notes(workspace_id, folder_id)`. The pair is
    // already unique because `id` alone is the PK; this explicit unique index
    // exists solely so PostgreSQL accepts the composite FK in `notes.ts`.
    uniqueIndex("folders_workspace_id_id_unique").on(t.workspaceId, t.id),
    // Tree reads: "children of folder X in workspace W" and "root folders in
    // workspace W" (leftmost prefix on workspace_id covers both).
    index("folders_workspace_parent_idx").on(t.workspaceId, t.parentId),
  ],
);

// --------------------------------------------------------------------------- //
// Relations
// --------------------------------------------------------------------------- //

export const foldersRelations = relations(folders, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [folders.workspaceId],
    references: [workspaces.id],
  }),
  // Self-relation for the nesting tree. `relationName` disambiguates the
  // parent/children direction on the same table.
  parent: one(folders, {
    fields: [folders.parentId],
    references: [folders.id],
    relationName: "folders_parent",
  }),
  children: many(folders, { relationName: "folders_parent" }),
  createdBy: one(users, {
    fields: [folders.createdById],
    references: [users.id],
  }),
}));
