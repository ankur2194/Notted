import { relations } from "drizzle-orm";
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { emailDeliveries } from "./email-deliveries";

export const authEmailPurposeEnum = pgEnum("auth_email_purpose", [
  "registration_verification",
  "verification_resend",
  "magic_link",
  "password_reset_request",
  "password_reset_confirmation",
]);

export const authEmailIntentStatusEnum = pgEnum("auth_email_intent_status", [
  "pending",
  "processing",
  "sent",
  "failed",
  "expired",
  "cancelled",
]);

/**
 * Narrow Part 21 bridge for token-bearing authentication email context.
 * Ciphertext, nonce and tag are deliberately separate and authenticated with
 * immutable row metadata. Plain tokens, tokenized URLs and rendered bodies are
 * never columns in this or any outbox/queue table.
 */
export const authEmailIntents = pgTable(
  "auth_email_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliveryId: uuid("delivery_id")
      .references(() => emailDeliveries.id, { onDelete: "cascade" })
      .notNull(),
    purpose: authEmailPurposeEnum("purpose").notNull(),
    encryptedContext: text("encrypted_context").notNull(),
    encryptionKeyVersion: integer("encryption_key_version").notNull(),
    nonce: varchar("nonce", { length: 24 }).notNull(),
    authenticationTag: varchar("authentication_tag", { length: 24 }).notNull(),
    status: authEmailIntentStatusEnum("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("auth_email_intents_delivery_id_unique").on(t.deliveryId),
    index("auth_email_intents_dispatch_idx").on(t.status, t.expiresAt),
  ],
);

export const authEmailIntentsRelations = relations(authEmailIntents, ({ one }) => ({
  delivery: one(emailDeliveries, {
    fields: [authEmailIntents.deliveryId],
    references: [emailDeliveries.id],
  }),
}));

export type AuthEmailPurpose = (typeof authEmailPurposeEnum.enumValues)[number];
