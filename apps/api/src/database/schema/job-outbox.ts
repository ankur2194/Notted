// Part 18: durable side-effect intent, separate from worker replay protection.
//
// TRANSACTION INVARIANT (ADR 0006): application services insert a job_outbox
// intent in the SAME PostgreSQL transaction as the business mutation. Only
// after that transaction commits may a dispatcher publish the intent to
// BullMQ. Dispatcher retries are safe because idempotency_key is unique.
// `job_idempotency` remains a separate, independently expiring worker-side
// replay-protection record; it is not the durable intent queue.
//
// Payloads are minimal, typed, and versioned. They contain identifiers and an
// action only—never note/comment bodies, credentials, tokens, provider secrets,
// signed URLs, reusable sessions, or other user content.

import { relations } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { workspaces } from "./workspaces";

export const jobOutboxStatusEnum = pgEnum("job_outbox_status", [
  "pending",
  "dispatching",
  "dispatched",
  "completed",
  "failed",
  "cancelled",
]);

/** Identifier-only payload persisted with a durable outbox intent. */
export interface JobOutboxPayload {
  readonly action: string;
  readonly intentId: string;
  readonly workspaceId?: string;
  readonly resourceIds?: readonly string[];
  readonly actorId?: string;
}

export const jobOutbox = pgTable(
  "job_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // SET NULL preserves platform/operator visibility of an intent after a
    // workspace deletion without retaining tenant content in the payload.
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    queueName: varchar("queue_name", { length: 100 }).notNull(),
    jobType: varchar("job_type", { length: 100 }).notNull(),
    payloadVersion: integer("payload_version").default(1).notNull(),
    payload: jsonb("payload").$type<JobOutboxPayload>().notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    status: jobOutboxStatusEnum("status").default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    correlationId: uuid("correlation_id"),
    lastErrorCode: varchar("last_error_code", { length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("job_outbox_idempotency_key_unique").on(t.idempotencyKey),
    index("job_outbox_workspace_created_idx").on(t.workspaceId, t.createdAt),
    index("job_outbox_dispatcher_idx").on(t.status, t.availableAt),
    index("job_outbox_correlation_id_idx").on(t.correlationId),
  ],
);

export const jobOutboxRelations = relations(jobOutbox, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [jobOutbox.workspaceId],
    references: [workspaces.id],
  }),
}));
