// Durable replay protection for retryable HTTP/tRPC mutations.
// Raw idempotency keys and request bodies are never persisted: only hashes and
// the created resource UUID are retained for a bounded period.

import { index, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

import { users } from "./users";

export const apiIdempotencyRecords = pgTable(
  "api_idempotency_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    operation: varchar("operation", { length: 100 }).notNull(),
    keyHash: varchar("key_hash", { length: 64 }).notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    resourceId: uuid("resource_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("api_idempotency_actor_operation_key_unique").on(
      t.actorUserId,
      t.operation,
      t.keyHash,
    ),
    index("api_idempotency_expires_at_idx").on(t.expiresAt),
  ],
);
