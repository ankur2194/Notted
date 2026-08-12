// Part 18: job idempotency records (durable cross-restart dedup surface).
//
// Per Plan Part 18: "Create ... any job idempotency records." Per ADR 0006
// "Use durable job intent with idempotent BullMQ workers". This table is the
// independently expiring WORKER replay-protection surface: it records that a
// published job (keyed by a stable idempotency key) has been processed, with a
// small safe result, so duplicate delivery cannot double-execute side effects.
// It is deliberately separate from `job_outbox`, which is the durable intent
// inserted atomically with business state and dispatched only after commit.
//
// DEDUP CONTRACT:
// - `key` is the stable idempotency key derived from the intent (e.g.
//   `email:invitation:<invitation_id>`, `export:<export_id>`,
//   `webhook:<webhook_id>:<event_id>`). UNIQUE so the second enqueue of the
//   same delivered job finds the existing row rather than creating a duplicate.
// - `payload_hash` is a hash of the job payload (NOT the payload itself). The
//   full payload is NOT stored here: ADR 0006 mandates payloads never contain
//   document bodies, credentials, signed URLs, provider secrets, or reusable
//   user sessions. The hash lets the dispatcher detect "same intent, same
//   payload" for safe skip-vs-replay decisions without persisting anything
//   sensitive.
// - `result` is a SMALL, SAFE jsonb result (e.g.
//   `{ "outcome": "sent", "messageId": "..." }` for an email). It is NOT a
//   dumping ground for payloads or outputs; the service (Part 50/51) writes
//   only the minimal outcome downstream replays need.
//
// STATUS LIFECYCLE (job_status):
//   pending → completed   (side effect recorded; `result` set)
//          → failed       (permanent failure; `error_message` set; the
//                           dispatcher moves the BullMQ job to a dead-letter
//                           state alongside this row)
// A `completed` row with the same key short-circuits all future enqueues.
//
// TTL / RETENTION: `expires_at` is NOT NULL — every row has a finite lifetime
// so the table does not grow unbounded. The maintenance worker (Part 50) deletes rows
// past `expires_at` under the partial-friendly `(expires_at)` index. The TTL
// is set by the dispatcher based on the intent type (e.g. 30 days for export
// idempotency, 7 days for email idempotency). Rows are also safe to delete on
// a Redis flush because they are an optimization surface, not the business
// record (the business record is the export/email/usage row itself).
//
// NO FOREIGN KEYS: this table is intentionally standalone. It references no
// workspace/user/resource by FK because (a) the same key space spans many
// intent types, (b) the row must outlive the referenced resource's deletion
// within its TTL (e.g. an export job's idempotency row outlives the export
// object cleanup), and (c) the `key` encodes the intent identity. The service
// (Part 50/51) is the sole reader/writer.
//
// Conventions (copied from Part 13–17): see `note-embeddings.ts` module
// comment.

import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// --------------------------------------------------------------------------- //
// Enums
// --------------------------------------------------------------------------- //
// Idempotency record status. `pending` = intent recorded/dispatched, outcome
// not yet known; `completed` = side effect recorded (result set); `failed` =
// permanent failure (error_message set).
export const jobStatusEnum = pgEnum("job_status", [
  "pending",
  "processing",
  "completed",
  "failed",
  "reconciliation_required",
]);

// --------------------------------------------------------------------------- //
// job_idempotency
// --------------------------------------------------------------------------- //

export const jobIdempotency = pgTable(
  "job_idempotency",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Stable idempotency key derived from the intent. UNIQUE so a duplicate
    // enqueue finds the existing row.
    key: varchar("key", { length: 255 }).notNull(),
    // Queue/intent name (e.g. "email", "export", "webhook", "indexing",
    // "embeddings", "cleanup"). Scans by (queue, status) power the dispatcher.
    queueName: varchar("queue_name", { length: 100 }).notNull(),
    status: jobStatusEnum("status").default("pending").notNull(),
    // Hash of the job payload (NOT the payload). Lets the dispatcher detect
    // "same intent, same payload" without persisting sensitive payloads.
    payloadHash: varchar("payload_hash", { length: 64 }),
    // SMALL, SAFE result jsonb (e.g. `{ "outcome": "sent" }`). NOT a payload
    // store. Nullable because failed/pending rows have no result.
    result: jsonb("result"),
    // Safe failure reason for `failed` rows.
    errorMessage: text("error_message"),
    // TTL. NOT NULL — every row has a finite lifetime; the cleanup job deletes
    // past-expiry rows under the index below.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // updated_at tracks status transitions (pending → completed/failed).
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
  },
  (t) => [
    // UNIQUE key: dedup + single-row lookup. The lookup path uses this.
    uniqueIndex("job_idempotency_key_unique").on(t.key),
    // "Pending jobs to dispatch/verify" + "failed jobs to surface" per queue.
    index("job_idempotency_queue_status_idx").on(t.queueName, t.status),
    // Cleanup scan: rows past expiry. A partial index (where expires_at is not
    // null) is unnecessary because expires_at is NOT NULL — every row is
    // indexed, which is the correct shape for a TTL cleanup scan.
    index("job_idempotency_expires_at_idx").on(t.expiresAt),
  ],
);

// --------------------------------------------------------------------------- //
// Relations
// --------------------------------------------------------------------------- //
// Standalone table — no foreign keys, no relations. See module comment.
