// Part 18: email delivery records (transactional email outbox status).
//
// Per Plan Part 18: "Create ... email delivery records ...". Per ADR 0007
// "Email delivery status": an email intent/delivery record with template key,
// safe recipient reference, status, attempts, provider message ID, and
// timestamps. Queueing is transactional/outbox-backed and idempotent; logs and
// records OMIT rendered bodies, tokens, and magic links.
//
// CONTENT REDACTION (CRITICAL):
// - This table records DELIVERY STATUS, not email content. There are NO
//   columns for the rendered HTML/text body, the verification/magic-link
//   token, the download link, or any personal data beyond the recipient
//   address. `recipient` is the email address (needed for delivery and for
//   "did this address get suppressed?" lookups); it is NOT a token and carries
//   no credential.
// - The rendered body and any tokenized links are produced at send time by the
//   email service (Part 65) from the template + context, dispatched through
//   BullMQ (ADR 0006), and never persisted to PostgreSQL. The template KEY
//   (`template_key`) identifies which template was used; the arguments/context
//   are NOT stored.
//
// OUTBOX + IDEMPOTENCY: the email service records `job_outbox` in the same
// transaction as this delivery/business state, then dispatches only after
// commit. `job_idempotency` is separate worker replay protection after publish.
// The `email_deliveries` row records per-message delivery outcome; all three
// records have distinct responsibilities (ADR 0006).
//
// WORKSPACE-LESS EMAILS: `workspace_id` is NULLABLE. System emails (email
// verification, magic link, password reset) are sent BEFORE the user has a
// workspace context or OUTSIDE any workspace; such rows have workspace_id =
// NULL. Workspace-scoped emails (invitation, mention, export-ready) carry the
// workspace id. CASCADE so a workspace delete removes its scoped email records
// (system rows are unaffected).
//
// STATUS LIFECYCLE (email_status):
//   queued → sent        (provider accepted; provider_message_id set)
//         → failed       (attempts exhausted or hard bounce)
//   queued|sent → suppressed  (recipient hit a permanent suppress list, e.g.
//                              hard bounce/complaint; the service (Part 65)
//                              short-circuits future sends to this recipient)
//
// `attempts` counts delivery attempts (default 0; incremented by the worker).
// `provider_message_id` is the upstream provider's message id (NULL until the
// provider accepts). `error_message` is a safe, localized-safe failure reason
// (redacted by the service). `related_entity_type`/`related_entity_id`
// optionally link the email to a workspace entity (e.g. "invitation" + id) for
// correlation — polymorphic, NO foreign key (the email outlives entity delete
// within its retention window).
//
// Deletion model: only `workspace_id` CASCADE; there is no user FK (the
// recipient is an email string, not a user id, per ADR 0007's "safe recipient
// reference"). Retention/purge is owned by Part 19.
//
// Conventions (copied from Part 13–17): see `note-embeddings.ts` module
// comment.

import { relations } from "drizzle-orm";
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { workspaces } from "./workspaces";

// --------------------------------------------------------------------------- //
// Enums
// --------------------------------------------------------------------------- //
// Delivery status. `suppressed` short-circuits future sends to a recipient on
// a permanent suppress list (hard bounce/complaint).
export const emailStatusEnum = pgEnum("email_status", ["queued", "sent", "failed", "suppressed"]);

// --------------------------------------------------------------------------- //
// email_deliveries
// --------------------------------------------------------------------------- //

export const emailDeliveries = pgTable(
  "email_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // NULLABLE: system emails (verification, magic link, password reset) have
    // no workspace context. CASCADE on workspace delete for scoped rows.
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    // Recipient email address. NOT a token; carries no credential. Needed for
    // delivery and for suppress-list lookups.
    recipient: varchar("recipient", { length: 255 }).notNull(),
    // Template key (e.g. "welcome", "verification", "invitation",
    // "magic_link", "export_ready", "mention"). Identifies which React Email
    // template was rendered; the rendered body and args are NOT stored.
    templateKey: varchar("template_key", { length: 100 }).notNull(),
    status: emailStatusEnum("status").default("queued").notNull(),
    // Delivery attempt count (incremented by the worker; default 0).
    attempts: integer("attempts").default(0).notNull(),
    // Upstream provider message id (NULL until the provider accepts).
    providerMessageId: varchar("provider_message_id", { length: 255 }),
    // Safe, redacted failure reason. NULL for non-failed rows.
    errorMessage: text("error_message"),
    // Optional polymorphic link to a workspace entity (e.g. "invitation" +
    // id). NO foreign key: the email outlives entity delete within retention.
    relatedEntityType: varchar("related_entity_type", { length: 50 }),
    relatedEntityId: uuid("related_entity_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // When the provider accepted the message (NULL while queued/failed).
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    // "Queued/failed emails to retry" dispatcher scan.
    index("email_deliveries_status_idx").on(t.status),
    // "Recent emails for workspace X" admin view (NULL workspace_id rows are
    // simply absent from this index's common scan).
    index("email_deliveries_workspace_created_idx").on(t.workspaceId, t.createdAt),
    // "Did this address get sent/suppressed?" lookup.
    index("email_deliveries_recipient_idx").on(t.recipient),
  ],
);

// --------------------------------------------------------------------------- //
// Relations
// --------------------------------------------------------------------------- //
// Forward relation only; `workspacesRelations` is not extended, to keep
// earlier parts immutable per the handoff rules.

export const emailDeliveriesRelations = relations(emailDeliveries, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [emailDeliveries.workspaceId],
    references: [workspaces.id],
  }),
}));
