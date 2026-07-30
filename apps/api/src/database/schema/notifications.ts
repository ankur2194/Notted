import { relations, sql } from "drizzle-orm";
import { index, pgEnum, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { users } from "./users";
import { workspaces } from "./workspaces";

export const notificationKindEnum = pgEnum("notification_kind", [
  "system",
  "workspace",
  "mention",
  "comment",
  "export",
]);

export const notificationTargetTypeEnum = pgEnum("notification_target_type", [
  "workspace",
  "note",
  "comment",
  "export",
  "settings",
]);

/**
 * Safe notification metadata only. Content bodies, rendered HTML, tokens,
 * signed URLs, editor JSON, and provider payloads have no columns here.
 * Part 60 may produce mention/comment rows through the same table and service.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    recipientUserId: uuid("recipient_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    kind: notificationKindEnum("kind").notNull(),
    targetType: notificationTargetTypeEnum("target_type"),
    targetId: uuid("target_id"),
    summary: varchar("summary", { length: 160 }).notNull(),
    targetLabel: varchar("target_label", { length: 120 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    index("notifications_recipient_recent_idx").on(
      t.recipientUserId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index("notifications_recipient_workspace_recent_idx").on(
      t.recipientUserId,
      t.workspaceId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index("notifications_workspace_recent_idx").on(t.workspaceId, t.createdAt.desc()),
    index("notifications_recipient_workspace_unread_idx")
      .on(t.recipientUserId, t.workspaceId, t.createdAt.desc())
      .where(sql`${t.readAt} is null`),
  ],
);

export const notificationsRelations = relations(notifications, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [notifications.workspaceId],
    references: [workspaces.id],
  }),
  recipient: one(users, {
    fields: [notifications.recipientUserId],
    references: [users.id],
    relationName: "notificationRecipient",
  }),
  actor: one(users, {
    fields: [notifications.actorUserId],
    references: [users.id],
    relationName: "notificationActor",
  }),
}));
