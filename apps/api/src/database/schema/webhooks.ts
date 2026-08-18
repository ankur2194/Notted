// Part 18: webhooks and webhook deliveries (outbound event delivery).
//
// Per Plan Part 18: "Create ... webhooks, webhook deliveries ... never store
// raw webhook signing secrets after initial presentation unless encrypted
// storage is required." Per ADR 0007 "Webhooks/deliveries": workspace-owned
// endpoints and immutable delivery attempts; endpoints start DISABLED until
// verified; secrets are encrypted and shown once; HTTPS is required outside
// development; deliveries are signed, idempotent, bounded, retried with
// backoff, and never include data outside the endpoint's scopes.
//
// SIGNING-SECRET MODEL (CRITICAL):
// - `webhooks.encrypted_secret` stores the HMAC-SHA256 signing secret
//   ENCRYPTED at the application layer using the master key from
//   `SECURITY_CONFIG` (`security.config.ts` exposes `DATA_ENCRYPTION_KEYS`,
//   a versioned `version:base64` 32-byte-key list). The webhook service
//   (Part 66) encrypts on create and re-encrypts on rotation; the schema only
//   persists the ciphertext blob and the `encryption_key_version` integer so
//   key rotation can find and re-encrypt old rows.
// - The RAW secret is generated server-side, returned to the admin EXACTLY
//   ONCE in the create response, and NEVER persisted in cleartext, never
//   logged, and never returned by any read path. This mirrors the API-key
//   raw-key model (Part 18 `api_keys`).
// - `encryption_key_version` is NOT NULL: every encrypted blob records which
//   key version produced it; rotation (Part 67) scans by version and re-
//   encrypts. The version maps to `EncryptionKey.version` in the security
//   config.
//
// ENDPOINT LIFECYCLE:
// - `is_enabled` defaults FALSE and `is_verified` defaults FALSE: a freshly
//   created endpoint is DISABLED until the admin completes the verification
//   challenge (Part 66 sends a signed probe; the endpoint must echo a token).
//   A disabled endpoint never receives event deliveries.
// - `url` is text (HTTPS required outside dev — service-validated Part 66;
//   the schema does not encode a CHECK because dev allows http://localhost).
//   SSRF prevention (rejecting private/link-local/metadata IPs) is service-
//   side (Part 66); it cannot be a DB CHECK.
// - `events` is a jsonb array of event-name strings the endpoint subscribes to
//   (e.g. ["note.created", "note.updated", "project.created", "member.joined"]
//   per Notted.md). The service validates against the allowed event catalog.
//   Defaults to `[]` and is NOT NULL so "no events" is explicit; the service
//   rejects creating a delivery for an event the endpoint did not subscribe to.
//
// DELIVERY ATTEMPTS (`webhook_deliveries`) are IMMUTABLE: each row is one
// attempt to deliver one event to one endpoint. There is NO `updated_at`; the
// `status`/`response_*`/`delivered_at` columns transition pending → success /
// failed / retrying exactly once as the dispatcher (Part 66) records the HTTP
// outcome. A new attempt is a NEW row (incremented `attempt`), never an
// overwrite of a prior attempt — so the full attempt history is queryable for
// the delivery logs Notted.md surfaces in workspace settings.
//
// EVENT IDENTITY (`event_id`, Part 66): delivery is AT-LEAST-ONCE, so the same
// event legitimately reaches a receiver more than once — every automatic retry
// of a failed attempt, and every manual admin replay, is another HTTP request
// carrying the SAME logical event. `event_id` is what stays stable across all
// of them: it is the value sent as `X-Notted-Event-Id` so a receiver can dedupe
// on its own side, and it is the grouping key that turns N attempt rows back
// into one event in the delivery log. See its column comment for why it carries
// no foreign key.
//
// PAYLOAD REDACTION: `payload_hash` stores a hash (sha256 hex) of the delivered
// payload body so attempts stay small and the dispatcher can dedupe identical
// redeliveries. The FULL PAYLOAD IS NOT PERSISTED LONG-TERM: webhook payloads
// may contain workspace content within the endpoint's scopes (ADR 0007:
// "never include data outside the endpoint's scopes"), so the schema stores
// only the hash plus a bounded `response_body_snippet` (the service truncates
// to a safe length, e.g. 500 chars, and redacts sensitive substrings). The
// payload body lives transiently in BullMQ for the bounded retry window
// (ADR 0006) and is not made durable in PostgreSQL.
//
// HMAC signing, idempotency headers, exponential backoff with jitter, capped
// attempts (Notted.md "max 5 attempts"), and SSRF prevention are all service/
// dispatcher logic (Part 66); this table only stores the model.
//
// Deletion model:
// - `webhooks.workspace_id` CASCADE: deleting a workspace removes its
//   endpoints (and cascades to their deliveries via the delivery FK).
// - `webhooks.created_by_id` RESTRICT (audit convention).
// - `webhook_deliveries.webhook_id` CASCADE: deleting an endpoint removes its
//   delivery history (the history is scoped to the endpoint).
//
// Conventions (copied from Part 13–17): see `note-embeddings.ts` module
// comment.

import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./users";
import { workspaces } from "./workspaces";

// --------------------------------------------------------------------------- //
// Enums
// --------------------------------------------------------------------------- //
// Delivery attempt status. `pending` = queued for the dispatcher; `success` =
// endpoint returned 2xx; `failed` = terminal failure (attempts exhausted or
// hard 4xx); `retrying` = failed this attempt, will retry with backoff.
export const webhookDeliveryStatusEnum = pgEnum("webhook_delivery_status", [
  "pending",
  "success",
  "failed",
  "retrying",
]);

// --------------------------------------------------------------------------- //
// webhooks
// --------------------------------------------------------------------------- //

export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    // Admin who created the endpoint. RESTRICT (audit convention).
    createdById: uuid("created_by_id")
      .references(() => users.id, { onDelete: "restrict" })
      .notNull(),
    // Endpoint URL. HTTPS required outside dev (service-validated Part 66;
    // no DB CHECK because dev permits http://localhost). SSRF prevention is
    // service-side.
    url: text("url").notNull(),
    // ENCRYPTED HMAC-SHA256 signing secret (ciphertext blob). The raw secret
    // is shown once on create and never returned. Encrypted with the master
    // key from SECURITY_CONFIG; see module comment.
    encryptedSecret: text("encrypted_secret").notNull(),
    // Key version that produced `encrypted_secret`. Maps to
    // `EncryptionKey.version`; rotation (Part 67) scans by version. NOT NULL
    // because every ciphertext records its version.
    encryptionKeyVersion: integer("encryption_key_version").notNull(),
    // Subscribed event names (jsonb array of strings). Defaults to `[]`; the
    // service validates names against the event catalog and rejects delivering
    // an unsubscribed event. NOT NULL so "no events" is explicit.
    //
    // `$type<string[]>()` is a COMPILE-TIME narrowing only — it emits no SQL and
    // changes no stored value, it just stops every reader having to re-widen
    // `unknown` before it can iterate. It deliberately narrows to `string[]`
    // and not `WebhookEvent[]`: the database cannot enforce the catalog, so
    // claiming the stricter type here would be a lie a stale row could break.
    // Runtime validation stays where it can actually hold — the service checks
    // names against `WEBHOOK_EVENTS`.
    events: jsonb("events").$type<string[]>().default([]).notNull(),
    // Disabled until the verification challenge completes (Part 66). A disabled
    // endpoint never receives deliveries.
    isEnabled: boolean("is_enabled").default(false).notNull(),
    // Set TRUE once the verification probe is echoed back (Part 66).
    isVerified: boolean("is_verified").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // "List webhooks for workspace X" admin view.
    index("webhooks_workspace_id_idx").on(t.workspaceId),
  ],
);

// --------------------------------------------------------------------------- //
// webhook_deliveries (immutable attempts)
// --------------------------------------------------------------------------- //

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookId: uuid("webhook_id")
      .references(() => webhooks.id, { onDelete: "cascade" })
      .notNull(),
    // Logical event identity, STABLE across every retry attempt of this event
    // AND across a manual admin replay of it. Three things depend on that:
    //   1. It is the value sent as `X-Notted-Event-Id`, so a receiver that sees
    //      the same delivery twice can dedupe without parsing the body.
    //   2. It groups the N attempt rows of one event back together in the
    //      delivery log (`webhook_deliveries_webhook_event_idx`).
    //   3. A manual retry rebuilds the AUTHORITATIVE body by re-reading
    //      `job_outbox WHERE id = delivery.event_id` rather than trusting a
    //      stored copy — which is why no payload body is durable here.
    //
    // There is deliberately NO foreign key to `job_outbox`. Outbox rows are
    // PRUNABLE (the queue-maintenance sweep reclaims settled intents) and a FK
    // would make the delivery log pin them forever, turning a log table into a
    // retention leak. A pruned intent is a normal, expected state: the replay
    // path finds nothing and answers a clean 409 instead of inventing a body.
    eventId: uuid("event_id").notNull(),
    // Event name delivered (e.g. "note.created"). varchar(100) fits the event
    // catalog names.
    event: varchar("event", { length: 100 }).notNull(),
    // sha256 hex of the delivered payload body. Lets the dispatcher dedupe
    // identical redeliveries and keeps attempts small. The full payload is
    // NOT persisted here (see module comment): payloads may carry workspace
    // content within scope, so only the hash is durable.
    payloadHash: varchar("payload_hash", { length: 64 }),
    // Attempt status (see enum). Transitions pending → success/failed/retrying
    // exactly once as the dispatcher records the HTTP outcome.
    status: webhookDeliveryStatusEnum("status").default("pending").notNull(),
    // Attempt number (1-based). A retried delivery is a NEW row with an
    // incremented attempt, preserving full history.
    attempt: integer("attempt").notNull(),
    // HTTP status code returned by the endpoint (NULL until the request
    // completes).
    responseStatus: integer("response_status"),
    // Bounded, redacted snippet of the endpoint's response body (the service
    // truncates to a safe length and redacts sensitive substrings). NULL when
    // there was no body or the request never completed.
    responseBodySnippet: text("response_body_snippet"),
    // Safe error message (e.g. "connection reset", "dns lookup failed"). The
    // service redacts any sensitive detail before insert.
    errorMessage: text("error_message"),
    // When the HTTP request completed (NULL for pending attempts).
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    // NO updated_at — immutable attempt rows (see module comment).
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // "Delivery history for endpoint X, newest first" (Notted.md workspace
    // settings delivery logs).
    index("webhook_deliveries_webhook_created_idx").on(t.webhookId, t.createdAt),
    // "Every attempt of event E on endpoint X" — the retry/replay grouping the
    // delivery log and the manual-retry path both read.
    index("webhook_deliveries_webhook_event_idx").on(t.webhookId, t.eventId),
    // "Pending/retrying deliveries to resume" dispatcher scan.
    index("webhook_deliveries_status_idx").on(t.status),
  ],
);

// --------------------------------------------------------------------------- //
// Relations
// --------------------------------------------------------------------------- //
// Forward relations only; `workspacesRelations` and `usersRelations` are not
// extended, to keep earlier parts immutable per the handoff rules.

export const webhooksRelations = relations(webhooks, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [webhooks.workspaceId],
    references: [workspaces.id],
  }),
  createdBy: one(users, {
    fields: [webhooks.createdById],
    references: [users.id],
    relationName: "webhooks_createdBy",
  }),
  deliveries: many(webhookDeliveries),
}));

export const webhookDeliveriesRelations = relations(webhookDeliveries, ({ one }) => ({
  webhook: one(webhooks, {
    fields: [webhookDeliveries.webhookId],
    references: [webhooks.id],
  }),
}));
