// Part 26: durable identifier-only workspace deletion tombstones.
//
// This table deliberately has no workspace or user foreign keys, so deleting a
// workspace (or later deleting the actor) cannot erase the deletion evidence.
// It stores opaque identifiers and a correlation ID only—never workspace names,
// slugs, descriptions, email addresses, or content. Part 71 owns the unified
// audit read surface and retention policy; no application API exposes this table.

import { index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

export const workspaceDeletionAudits = pgTable(
  "workspace_deletion_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deletedWorkspaceId: uuid("deleted_workspace_id").notNull(),
    actorId: uuid("actor_id"),
    requestId: uuid("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("workspace_deletion_audits_workspace_created_idx").on(t.deletedWorkspaceId, t.createdAt),
    index("workspace_deletion_audits_request_id_idx").on(t.requestId),
  ],
);
