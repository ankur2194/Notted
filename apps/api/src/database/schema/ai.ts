// Part 18: AI provider configuration and append-only AI usage records.
//
// Per Plan Part 18: "Create ... AI provider configuration, AI usage ... encrypt
// provider credentials with an application master key ...". Per ADR 0007 "AI
// configuration/usage": workspace AI settings and append-only usage records; AI
// is DISABLED BY DEFAULT; provider secrets are encrypted and never returned or
// logged; only authorized admins configure providers; quotas fail closed;
// requests and output content are NOT retained in usage rows by default.
//
// CREDENTIAL ENCRYPTION (CRITICAL):
// - `ai_provider_config.encrypted_credentials` stores the provider API key/
//   secret material ENCRYPTED at the application layer using the master key
//   from `SECURITY_CONFIG` (`security.config.ts` exposes `DATA_ENCRYPTION_KEYS`,
//   a versioned `version:base64` 32-byte-key list). The AI service (Part 67)
//   encrypts on write and is the ONLY reader that decrypts. The plaintext
//   credential is NEVER persisted, NEVER logged, and NEVER returned by any
//   read path (admin config endpoints return at most a "configured" boolean).
// - `encryption_key_version` records which key version produced the ciphertext
//   so rotation (Part 67) can find and re-encrypt old rows. Nullable because a
//   `provider = "disabled"` config row has no credentials to encrypt.
// - The on-disk shape is a ciphertext text blob (or a small encrypted jsonb
//   envelope if multiple per-provider fields are needed); `text` is chosen
//   here for a single opaque blob, matching the webhook secret model.
//
// DEFAULTS (deny-by-default per ADR 0007):
// - `provider` defaults to `"disabled"` and `is_enabled` defaults to FALSE:
//   a workspace has NO AI until an admin explicitly configures and enables a
//   provider. There is no implicit "use platform default OpenAI key" path.
// - When quotas/rate limits fail to evaluate (e.g. config missing), the AI
//   service (Part 67) fails CLOSED: the request is rejected, not allowed.
//
// ONE CONFIG PER WORKSPACE: `workspace_id` is UNIQUE, so a workspace has
// exactly one current AI configuration row. The unique index also serves the
// per-workspace lookup path; no separate non-unique index is added (it would
// duplicate the unique index's coverage).
//
// `settings` jsonb carries quotas, rate limits, and per-workspace consent
// (e.g. `{ "dailyTokenQuota": 50000, "rateLimitPerMinute": 20, "contentConsent": true }`).
// NOT NULL with default `{}` (Part 14 `settings` convention). The service
// validates the shape; only admins (owner/admin role) may write it.
//
// `ai_usage` (append-only usage records):
// - APPEND-ONLY: there is NO `updated_at`. Each row is one AI request outcome.
//   Retention/purge is owned by Part 19.
// - CONTENT IS NOT RETAINED (CRITICAL, ADR 0007): there is NO column for the
//   request prompt, the input document excerpt, or the generated output. Only
//   token counts, cost, provider/model metadata, feature, and status are
//   recorded. This is a deliberate privacy default; if future debugging needs
//   require content capture, a separate opt-in, time-boxed, encrypted table
//   would be introduced by a later part — never by adding a content column
//   here.
// - `provider` and `model` are varchar (NOT the `ai_provider` enum) because
//   usage rows are historical and must outlive enum changes (e.g. a provider
//   removed from the enum must still appear in past usage). `status` is
//   likewise varchar for the same evolution reason.
// - `cost_micros` is a bigint tracking cost in micro-units (1/1,000,000 of the
//   workspace's billing currency) so fractional-cent aggregation is exact
//   across many small requests. `mode: "number"` keeps it JSON-safe.
// - `user_id` is nullable + SET NULL: a usage event survives user deletion
//   (forensics/billing must persist), with the actor cleared.
//
// Deletion model:
// - Both tables' `workspace_id` CASCADE: deleting a workspace removes its AI
//   config and usage rows (tenant-scoped).
// - `ai_provider_config.updated_by_id` SET NULL: deleting the admin who last
//   configured AI preserves the config row (the audit link clears).
// - `ai_usage.user_id` SET NULL: see above.
//
// Conventions (copied from Part 13–17): see `note-embeddings.ts` module
// comment.

import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./users";
import { workspaces } from "./workspaces";

// --------------------------------------------------------------------------- //
// Enums
// --------------------------------------------------------------------------- //
// Provider selection. "disabled" is the deny-by-default value: a workspace
// starts with no AI until an admin configures a provider. Matches Notted.md
// "Workspace admin selects default AI provider (OpenAI, Claude, or disabled)".
export const aiProviderEnum = pgEnum("ai_provider", ["openai", "anthropic", "disabled"]);

// --------------------------------------------------------------------------- //
// ai_provider_config (one per workspace)
// --------------------------------------------------------------------------- //

export const aiProviderConfig = pgTable(
  "ai_provider_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // ONE config row per workspace. CASCADE on workspace delete. The unique
    // index below also serves the per-workspace lookup path.
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    // Active provider. Defaults "disabled" (deny-by-default).
    provider: aiProviderEnum("provider").default("disabled").notNull(),
    // Model identifier (e.g. "gpt-4o-mini", "claude-3-5-sonnet"). Nullable
    // because a disabled config has no model.
    model: varchar("model", { length: 100 }),
    // ENCRYPTED provider credentials (ciphertext blob). NEVER returned/logged.
    // Nullable because a disabled config has no credentials. See module
    // comment.
    encryptedCredentials: text("encrypted_credentials"),
    // Key version that produced `encrypted_credentials`. Maps to
    // `EncryptionKey.version`; rotation (Part 67) scans by version. Nullable
    // when there are no credentials.
    encryptionKeyVersion: integer("encryption_key_version"),
    // Disabled by default. The AI service (Part 67) gates every request on
    // this AND on quota/consent checks (fail closed).
    isEnabled: boolean("is_enabled").default(false).notNull(),
    // Quotas, rate limits, content consent. NOT NULL with default `{}`.
    settings: jsonb("settings").default({}).notNull(),
    // Admin who last updated the config. SET NULL preserves the config when
    // the admin account is removed.
    updatedById: uuid("updated_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // UNIQUE workspace_id: one config per workspace; also serves the lookup.
    uniqueIndex("ai_provider_config_workspace_id_unique").on(t.workspaceId),
  ],
);

// --------------------------------------------------------------------------- //
// ai_usage (append-only, content NOT retained)
// --------------------------------------------------------------------------- //

export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    // Acting user. Nullable + SET NULL so billing/forensics survive account
    // deletion (system-triggered AI jobs may have no user actor).
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    // Feature that triggered the request. e.g. "summarize", "continue",
    // "rewrite", "extract", "embed" (Notted.md AI features). varchar because
    // the feature catalog grows over time; the service validates.
    feature: varchar("feature", { length: 50 }).notNull(),
    // Historical provider/model. varchar (NOT the ai_provider enum) so usage
    // rows outlive enum changes; see module comment.
    provider: varchar("provider", { length: 50 }).notNull(),
    model: varchar("model", { length: 100 }).notNull(),
    // Token accounting (nullable because a failed request may have no usage).
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    // Cost in micro-units (1/1,000,000 of billing currency). bigint for exact
    // fractional aggregation; mode "number" keeps it JSON-safe.
    costMicros: bigint("cost_micros", { mode: "number" }),
    // Outcome. varchar ("success" | "failed" | "rate_limited") so the set can
    // grow without enum migrations; the service validates.
    status: varchar("status", { length: 20 }).notNull(),
    // Machine-readable failure code for failed/rate_limited rows.
    errorCode: text("error_code"),
    // NO content columns — request/output content is NOT retained (ADR 0007).
    // NO updated_at — append-only.
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // "Recent AI usage in workspace X" / time-bounded cost roll-ups.
    index("ai_usage_workspace_created_idx").on(t.workspaceId, t.createdAt),
    // "Usage/cost per feature" roll-up.
    index("ai_usage_workspace_feature_idx").on(t.workspaceId, t.feature),
    // "Failure/rate-limit rate" monitoring query.
    index("ai_usage_workspace_status_idx").on(t.workspaceId, t.status),
  ],
);

// --------------------------------------------------------------------------- //
// Relations
// --------------------------------------------------------------------------- //
// Forward relations only; `workspacesRelations` and `usersRelations` are not
// extended, to keep earlier parts immutable per the handoff rules.

export const aiProviderConfigRelations = relations(aiProviderConfig, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [aiProviderConfig.workspaceId],
    references: [workspaces.id],
  }),
  updatedBy: one(users, {
    fields: [aiProviderConfig.updatedById],
    references: [users.id],
    relationName: "ai_provider_config_updatedBy",
  }),
}));

export const aiUsageRelations = relations(aiUsage, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [aiUsage.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [aiUsage.userId],
    references: [users.id],
    relationName: "ai_usage_user",
  }),
}));
