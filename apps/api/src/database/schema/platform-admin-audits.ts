// Part 50: append-only, platform-scoped Bull Board mutation evidence.
//
// This is intentionally not `audit_logs`: platform administration has no
// workspace boundary. Values are allow-listed and bounded by the only writer.
// There is no body, query, path, cookie, address, user-agent, payload, result,
// or error column. Operator IDs intentionally have no FK so account deletion
// cannot erase or null historical evidence.

import { index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const platformAdminAudits = pgTable(
  "platform_admin_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorUserId: uuid("operator_user_id").notNull(),
    action: varchar("action", { length: 40 }).notNull(),
    queueName: varchar("queue_name", { length: 64 }).notNull(),
    jobId: varchar("job_id", { length: 128 }),
    requestId: uuid("request_id").notNull(),
    phase: varchar("phase", { length: 16 }).default("attempt").notNull(),
    outcome: varchar("outcome", { length: 32 }).default("authorized").notNull(),
    relatedAuditId: uuid("related_audit_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("platform_admin_audits_operator_created_idx").on(t.operatorUserId, t.createdAt.desc()),
    index("platform_admin_audits_request_id_idx").on(t.requestId),
  ],
);
