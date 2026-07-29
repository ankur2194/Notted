# Part 18 — Operations and Integration Tables

## Status

- **State:** Complete
- **Completed on:** 2026-07-29
- **Implemented by:** `backend-platform-engineer` (subagent)
- **Plan reference:** `Plan.md`, Part 18
- **Related records:**
  `part-12-drizzle-migration-tooling.md`;
  `part-13-identity-authentication-tables.md`;
  `part-14-workspace-membership-tables.md`;
  `part-15-projects-notes-hierarchy-ordering.md`;
  `part-16-tags-attachments-comments-versions.md`;
  `part-17-standalone-task-data.md`;
  `docs/decisions/0003-authentication-ownership.md`;
  `docs/decisions/0005-private-object-storage.md`;
  `docs/decisions/0006-background-workers.md`;
  `docs/decisions/0007-schema-gaps-and-safe-defaults.md`

## Objective

Deliver the FINAL schema part of Phase 3 (Plan Part 18): the operations and
integration tables that close the data model — note embeddings (pgvector),
audit logs, API keys, webhooks + webhook deliveries, exports, AI provider
configuration + append-only AI usage, email delivery records, durable
`job_outbox` intent, and independent job-idempotency records. Plan Part 18 mandates: "Store only hashes for API
keys, encrypt provider credentials with an application master key, and never
store raw webhook signing secrets after initial presentation unless encrypted
storage is required." This part is purely structural schema: no NestJS
services, transports, jobs, auth, encryption helpers, or storage adapters are
introduced — every behavior policy (hashing, encryption, HMAC signing, SSRF
prevention, retries, idempotency dispatch, retention cleanup, authorization
rechecks) is documented as a deferral to its owning service part.

## Implemented Work

Added eight schema modules under
`apps/api/src/database/schema/` defining the ten required tables, six enums,
and their forward relations; appended every table, relation, and enum to the
aggregate `schema` barrel in
`apps/api/src/database/schema/index.ts`; generated the forward migration
`apps/api/src/database/migrations/0006_graceful_blindfold.sql`; and added a
unit + DATABASE_URL-gated live test suite at
`apps/api/test/operations-integration-schema.test.ts`.

Reviewer #1's fix pass adds `job-outbox.ts`, `job_outbox_status`, and the
`job_outbox` table through forward migration `0007_early_bloodaxe.sql`.
Application services insert identifier-only, versioned intent in the business
transaction; a dispatcher publishes only after commit. Nullable `workspace_id`
uses `ON DELETE SET NULL` so operational intent history survives workspace
deletion without retaining content. `job_idempotency` remains separate,
independently expiring worker replay protection. Unit/live schema assertions
cover status values, columns, nullability, the unique idempotency key, tenant,
dispatcher `(status, available_at)`, and correlation indexes.

- **`note-embeddings.ts`** — `note_embeddings` (one 1536-dim pgvector row per
  note for semantic search). Columns: `id`; `note_id` (→ `notes.id` CASCADE,
  notNull, **UNIQUE** — one current embedding per note; the upsert path is
  `on conflict (note_id) do update`); `embedding`
  (`vector("embedding", { dimensions: 1536 })` notNull — the Drizzle built-in
  `vector` helper from `drizzle-orm/pg-core`, no separate npm package; the
  `vector` extension is already enabled by `0000_enable_extensions.sql`);
  `model` (varchar 100, notNull — records the embedding model so the indexer
  detects model changes); `content_hash` (varchar 64, notNull — sha256 of the
  source text, lets the indexer detect stale vectors); `dimensions` (integer,
  notNull — mirrors vector dimensionality so the query path detects a
  mismatch before issuing `<=>`); `created_at`. Indexes:
  `note_embeddings_note_id_unique` (UNIQUE); **`note_embeddings_embedding_idx`
  HNSW cosine** — `index("note_embeddings_embedding_idx").using("hnsw",
t.embedding.op("vector_cosine_ops"))`, matching the `<=>` cosine-distance
  operator the query path uses. A multi-embedding/chunked design is deferred
  to Part 53; the UNIQUE `note_id` gives a clean single-row upsert path until
  then. Relations: `noteEmbeddingsRelations` → `notes`.
- **`audit-logs.ts`** — `audit_logs` (append-only workspace activity trail).
  Columns: `id`; `workspace_id` (→ `workspaces.id` CASCADE, notNull);
  `user_id` (→ `users.id` SET NULL, nullable — preserves the event when the
  acting user is deleted); `action` (varchar 50, notNull); `entity_type`
  (varchar 50, notNull); `entity_id` (uuid, notNull — polymorphic, NO FK);
  `metadata` (jsonb, `.default({}).notNull()` — NO content/secrets; redaction
  is service-enforced, Part 71); `ip_address` (varchar 45, nullable);
  `user_agent` (text, nullable); `request_id` (text, nullable); `created_at`.
  **No `updated_at`** — append-only (immutability is service-enforced, Part
  71). Indexes: `audit_logs_workspace_created_idx` `(workspace_id, created_at
DESC NULLS LAST)`; `audit_logs_workspace_entity_idx` `(workspace_id,
entity_type, entity_id)`; `audit_logs_user_id_idx` `(user_id)`. Relations:
  `auditLogsRelations` → `workspaces`, `users`.
- **`api-keys.ts`** — `api_keys` (hash-only machine credentials; ADR 0003).
  Columns: `id`; `workspace_id` (→ `workspaces.id` CASCADE, notNull);
  `created_by_id` (→ `users.id` RESTRICT, notNull); `name` (varchar 100);
  `key_hash` (varchar 255, notNull — **HASH ONLY**; the raw key is never
  stored, logged, or returned post-create); `key_prefix` (varchar 8, notNull —
  display fragment, non-sensitive on its own); `scopes` (varchar 255,
  `.default("read,write").notNull()` — comma-separated scope tokens from the
  {read, write, admin} set; the API-key service (Part 61) parses/validates);
  `last_used_at` (nullable); `expires_at` (nullable); `is_revoked` (boolean
  default false, notNull — soft revocation flag preserving the audit trail);
  `created_at`. Indexes: `api_keys_key_hash_unique` (UNIQUE — lookup +
  uniqueness); `api_keys_workspace_id_idx`. Relations: `apiKeysRelations` →
  `workspaces`, `users`.
- **`webhooks.ts`** — `webhooks` + `webhook_deliveries` + enum
  `webhook_delivery_status`. `webhooks` columns: `id`; `workspace_id` (→
  `workspaces.id` CASCADE, notNull); `created_by_id` (→ `users.id` RESTRICT,
  notNull); `url` (text, notNull — HTTPS required outside dev, service-
  validated Part 66; no DB CHECK because dev permits localhost); `encrypted_secret`
  (text, notNull — **ENCRYPTED** HMAC signing secret blob; raw shown once,
  never returned); `encryption_key_version` (integer, notNull — records which
  `DATA_ENCRYPTION_KEYS` version produced the ciphertext, enabling rotation);
  `events` (jsonb, `.default([]).notNull()` — array of subscribed event names);
  `is_enabled` (boolean default false, notNull — disabled until verified);
  `is_verified` (boolean default false, notNull); `created_at`/`updated_at`.
  Index: `webhooks_workspace_id_idx`. `webhook_deliveries` (immutable
  attempts): `id`; `webhook_id` (→ `webhooks.id` CASCADE, notNull); `event`
  (varchar 100, notNull); `payload_hash` (varchar 64, nullable — sha256 of the
  delivered payload; **the full payload is NOT persisted** because payloads
  may carry workspace content within the endpoint's scopes); `status`
  (`webhook_delivery_status` default `pending`, notNull); `attempt` (integer,
  notNull — 1-based attempt number); `response_status` (integer, nullable);
  `response_body_snippet` (text, nullable — bounded/redacted by the service);
  `error_message` (text, nullable — safe); `delivered_at` (nullable);
  `created_at`. **No `updated_at`** — immutable attempts (a retry is a NEW
  row). Indexes: `webhook_deliveries_webhook_created_idx` `(webhook_id,
created_at)`; `webhook_deliveries_status_idx` `(status)`. HMAC signing,
  SSRF prevention, exponential backoff, and capped retries are dispatcher
  logic (Part 66). Relations: `webhooksRelations` (+ `deliveries` many),
  `webhookDeliveriesRelations` → `webhooks`.
- **`exports.ts`** — `exports` + enums `export_format` + `export_status`.
  Columns: `id`; `workspace_id` (→ `workspaces.id` CASCADE, notNull);
  `requested_by_id` (→ `users.id` RESTRICT, notNull); `format`
  (`export_format` notNull); `options` (jsonb, `.default({}).notNull()`);
  `status` (`export_status` default `queued`, notNull); `source_type` (varchar
  50, notNull — "note"/"project"/"workspace"); `source_id` (uuid, nullable —
  polymorphic, NO FK: the export outlives source deletion within its
  retention window); `object_key` (text, nullable — opaque MinIO key when
  ready; ADR 0005); `object_expires_at` (nullable — 7-day object retention);
  `signed_url_expires_at` (nullable — 7-day download-grant ceiling; distinct
  from object retention per ADR 0007); `error_code` (text, nullable);
  `error_message` (text, nullable — safe); `created_at`; `completed_at`
  (nullable). Indexes: `exports_workspace_created_idx`; `exports_requested_by_id_idx`;
  `exports_status_idx`; **`exports_object_expires_at_idx`** — partial index
  `.where(sql\`exports.object_expires_at is not null\`)`for the cleanup job.
Authorization is rechecked at create AND download (Part 62); objects are
private (Part 63); failed/cancelled/expired rows are not downloadable.
Relations:`exportsRelations`→`workspaces`, `users`.
- **`ai.ts`** — `ai_provider_config` + `ai_usage` + enum `ai_provider`.
  `ai_provider_config` (one per workspace): `id`; `workspace_id` (→
  `workspaces.id` CASCADE, notNull, **UNIQUE**); `provider` (`ai_provider`
  default `disabled`, notNull — deny-by-default); `model` (varchar 100,
  nullable); `encrypted_credentials` (text, nullable — **ENCRYPTED** provider
  API-key blob; never returned/logged; the AI service Part 67 is the sole
  reader that decrypts); `encryption_key_version` (integer, nullable —
  rotation handle; nullable because a `disabled` config has no credentials);
  `is_enabled` (boolean default false, notNull); `settings` (jsonb,
  `.default({}).notNull()` — quotas/rate limits/consent); `updated_by_id` (→
  `users.id` SET NULL, nullable); `created_at`/`updated_at`. Index:
  `ai_provider_config_workspace_id_unique` (UNIQUE — also serves the lookup).
  `ai_usage` (append-only, **content NOT retained** — ADR 0007): `id`;
  `workspace_id` (→ `workspaces.id` CASCADE, notNull); `user_id` (→
  `users.id` SET NULL, nullable); `feature` (varchar 50, notNull);
  `provider`/`model` (varchar, notNull — varchar rather than the enum so
  historical rows outlive enum changes); `prompt_tokens`/`completion_tokens`/
  `total_tokens` (integer, nullable); `cost_micros` (`bigint` mode "number",
  nullable — cost in micro-units for exact fractional aggregation);
  `status` (varchar 20, notNull); `error_code` (text, nullable); `created_at`.
  **No content columns** (no prompt/input/output/response/body/result_text);
  **no `updated_at`** (append-only). Indexes: `ai_usage_workspace_created_idx`;
  `ai_usage_workspace_feature_idx`; `ai_usage_workspace_status_idx`. Quotas
  fail closed (Part 67). Relations: `aiProviderConfigRelations`,
  `aiUsageRelations`.
- **`email-deliveries.ts`** — `email_deliveries` + enum `email_status`.
  Columns: `id`; `workspace_id` (→ `workspaces.id` CASCADE, **nullable** —
  system emails are workspace-less); `recipient` (varchar 255, notNull —
  email address, NOT a token); `template_key` (varchar 100, notNull);
  `status` (`email_status` default `queued`, notNull); `attempts` (integer
  default 0, notNull); `provider_message_id` (varchar 255, nullable);
  `error_message` (text, nullable — safe); `related_entity_type` (varchar 50,
  nullable); `related_entity_id` (uuid, nullable — polymorphic, NO FK);
  `created_at`; `sent_at` (nullable). **NO body/token/magic-link columns** —
  rendered bodies, tokens, and links are produced at send time (Part 65) and
  never persisted; transactional intent lives in `job_outbox` and worker replay
  protection lives independently in `job_idempotency`.
  Indexes: `email_deliveries_status_idx`; `email_deliveries_workspace_created_idx`;
  `email_deliveries_recipient_idx`. Relations: `emailDeliveriesRelations` →
  `workspaces`.
- **`job-idempotency.ts`** — `job_idempotency` + enum `job_status`. Columns:
  `id`; `key` (varchar 255, notNull, **UNIQUE** — stable idempotency key);
  `queue_name` (varchar 100, notNull); `status` (`job_status` default
  `pending`, notNull); `payload_hash` (varchar 64, nullable — hash only, NOT
  the payload; ADR 0006); `result` (jsonb, nullable — SMALL safe result, not a
  payload store); `error_message` (text, nullable); `expires_at` (timestamptz,
  notNull — TTL); `created_at`; `updated_at` (tracks status transitions).
  Indexes: `job_idempotency_key_unique` (UNIQUE);
  `job_idempotency_queue_status_idx` `(queue_name, status)`;
  `job_idempotency_expires_at_idx` `(expires_at)` for the cleanup job. **No
  foreign keys** — intentionally standalone (the key space spans many intent
  types and must outlive referenced-resource deletion within its TTL).
- Appended every Part 18 table, relation, and enum to the aggregate `schema`
  object in `apps/api/src/database/schema/index.ts` and re-exported each by
  name. The existing Part 12–17 entries and the `Schema = typeof schema` type
  are preserved; a `// Part 18 — ...` comment marks the new block.
- Generated migration `apps/api/src/database/migrations/0006_graceful_blindfold.sql`
  via `pnpm db:generate`, plus its snapshot (`meta/0006_snapshot.json`) and a
  new journal entry (`idx: 6`, `tag: 0006_graceful_blindfold`) in
  `meta/_journal.json` (the journal previously ended at `idx: 5`). Prior
  migrations (`0000`–`0005`), their snapshots, and the pre-Part-18 journal
  entries were NOT edited.
- Reviewed the generated SQL (see Verification Evidence): six enums, ten
  tables, fifteen foreign keys (cascade/restrict/set-null), four UNIQUE
  indexes (`api_keys_key_hash_unique`, `ai_provider_config_workspace_id_unique`,
  `job_idempotency_key_unique`, `note_embeddings_note_id_unique`), the HNSW
  cosine vector index (`USING hnsw ("embedding" vector_cosine_ops)`), the
  partial object-retention index, the DESC audit index, and the tenant-scoped
  lookup indexes. No review-time reorder was needed.
- Added `apps/api/test/operations-integration-schema.test.ts` with:
  - A no-database unit suite: the barrel exposes all ten Part 18 tables + six
    enums + nine relation objects; each enum has the expected values;
    `api_keys.key_hash` is UNIQUE and there is no raw-key column;
    `ai_provider_config` is one-per-workspace (UNIQUE) with no plaintext
    credential column; `job_idempotency.key` is UNIQUE with no payload column;
    `note_embeddings` has a UNIQUE `note_id` and the HNSW access method
    (`indexMethod` returns `"hnsw"`); `ai_usage` has NO content columns
    (asserts a forbidden-name list and the full safe set; append-only, no
    `updated_at`); `email_deliveries` has NO body/token/magic-link columns;
    `webhooks` stores only an encrypted secret + key version (no plaintext
    secret column); `exports` has the two distinct lifecycle columns and the
    partial index; `audit_logs` is append-only (no `updated_at`).
  - A `DATABASE_URL`-gated live suite (mirroring `tasks-schema.test.ts`) that
    applies migrations and asserts: the ten tables and six enums exist;
    (a) `note_embeddings` accepts a deterministic 1536-dim vector insert
    (`unitVectorLiteral` builds a pure-numeric literal; secret-free), the
    UNIQUE `note_id` rejects a second embedding for the same note (23505), and
    a cosine `<=>` query returns the correct nearest neighbor (distance 0 for
    identical vectors, 1 for orthogonal); (b) `api_keys.key_hash` uniqueness
    rejects a duplicate hash (23505); (c) `webhook_deliveries.status` rejects
    an invalid enum label (SQLSTATE 22P02) while accepting a valid one;
    (d) tenant-scoped and unique indexes exist via `pg_indexes`, including the
    HNSW index definition (`USING hnsw` + `vector_cosine_ops`) and the partial
    `exports_object_expires_at_idx`. Each live test creates deterministic
    unique fixtures and cleans up via the workspace cascade in a finally
    block. Uses `isDatabaseReachable` + `describe.skipIf(!HAS_DATABASE_URL)` +
    `skip()`.

## Important Decisions

- **Hash-only API keys; encrypted secrets with explicit key-version columns.**
  `api_keys.key_hash` is the only on-disk representation of the secret
  (`varchar(255)` UNIQUE; the raw key exists only in the create response).
  `webhooks.encrypted_secret` and `ai_provider_config.encrypted_credentials`
  store application-layer-encrypted ciphertext blobs (the master key comes
  from `SECURITY_CONFIG.DATA_ENCRYPTION_KEYS` in
  `apps/api/src/config/security.config.ts`); each is paired with an
  `encryption_key_version` integer that records which `version:base64` key
  produced the ciphertext, so Part 67 rotation can find and re-encrypt old
  rows. The schema never sees plaintext; encryption is a service concern
  (Parts 66/67), documented per the task's KEY INFRASTRUCTURE FACTS.
- **`webhook_deliveries.payload_hash` instead of a payload column.** Webhook
  payloads may include workspace content within the endpoint's scopes (ADR
  0007: "never include data outside the endpoint's scopes"), so the durable
  row stores only a sha256 hash of the payload body plus a bounded,
  service-redacted `response_body_snippet`. The full payload lives transiently
  in BullMQ for the bounded retry window (ADR 0006) and is not made durable in
  PostgreSQL. Chosen over a redacted-jsonb payload column to keep attempts
  small and to avoid any chance of leaking scoped content at rest.
- **`ai_usage` retains NO request/output content (ADR 0007 hard rule).** The
  column set is identity + token accounting + cost + outcome only. There is
  deliberately no column for the prompt, the input document excerpt, or the
  generated output. If future debugging ever requires content capture, a
  separate opt-in, time-boxed, encrypted table would be introduced by a later
  part — never by adding a content column here. The unit suite asserts a
  forbidden-name list to prevent accidental regression.
- **`note_embeddings` is ONE row per note (UNIQUE `note_id`).** Sufficient for
  the initial semantic-search surface (title + extracted plain text → one
  vector). A multi-embedding / per-chunk design is deferred to Part 53; the
  UNIQUE constraint gives the indexer a clean `on conflict (note_id) do
update` upsert path until then. The HNSW cosine index (`vector_cosine_ops`)
  matches the `<=>` query operator; IVFFlat was rejected (HNSW has better
  incremental-upsert recall and needs no clustering step).
- **`ai_provider_config` provider/model and `ai_usage` provider/model/status
  use varchar, not the `ai_provider` enum, in `ai_usage`.** The config table
  itself uses the `ai_provider` enum (a workspace's CURRENT provider is one of
  openai/anthropic/disabled). But `ai_usage` rows are historical append-only
  records that must outlive enum changes (a provider removed from the enum
  must still appear in past usage); `ai_usage.provider`/`model`/`status` are
  therefore varchar. Same evolution argument as why `status` is varchar.
- **`exports` has TWO distinct lifecycle timestamps.** `signed_url_expires_at`
  is the download-grant ceiling (7 days, Notted.md); `object_expires_at` is
  the object-retention expiry (7 days, ADR 0007) the cleanup job uses. They
  are independent: an object may briefly outlive its grant for
  reconciliation, or be deleted before its grant if cancelled. The partial
  index `exports_object_expires_at_idx WHERE object_expires_at IS NOT NULL`
  keeps the cleanup scan tight.
- **`email_deliveries.workspace_id` is nullable.** System emails (email
  verification, magic link, password reset) are sent before/outside any
  workspace context. CASCADE only affects workspace-scoped rows (invitation,
  mention, export-ready). There is no user FK — the recipient is an email
  address per ADR 0007's "safe recipient reference", not a user id.
- **`job_idempotency` has NO foreign keys.** The same key space spans many
  intent types (`email:...`, `export:...`, `webhook:...`), the row must outlive
  referenced-resource deletion within its TTL, and the `key` encodes intent
  identity. The dispatcher (Part 50/51) is the sole reader/writer.
- **`api_keys.scopes` is a comma-separated varchar (default "read,write").**
  Matches the Notted.md sample and the {read, write, admin} set. A jsonb array
  was considered and rejected: the CSV keeps the column compact and the
  service (Part 61) is the single parser, so the on-disk shape stays simple.
- **All `created_by_id`/`requested_by_id` audit columns use ON DELETE
  RESTRICT; `updated_by_id`, `user_id`, `assignee_id`-style optional links use
  SET NULL.** Matches the Part 14/15/16/17 audit convention: deleting a creator
  must not silently drop the audit trail (the service — Part 26 — reassigns
  before account deletion). SET NULL preserves rows while clearing optional
  links.
- **`audit_logs.metadata`, `exports.options`, `ai_provider_config.settings`
  are `.default({}).notNull()`; `webhooks.events` is `.default([]).notNull()`.**
  Consistent with the Part 14 `workspaces.settings` convention: "no metadata"
  is an explicit empty object/array, not NULL. A minor, documented deviation
  from the Notted.md `audit_logs` sample (which omits `.notNull()`).
- **`audit_logs_workspace_created_idx` uses `created_at DESC`.** Honors the
  Plan Part 18 index spec ("(workspaceId, createdAt desc)") and lets the
  "recent activity" hot path serve reverse scans without a sort. Drizzle
  emits `DESC NULLS LAST`.
- **Forward relations only.** `notesRelations`, `workspacesRelations`,
  `usersRelations` are intentionally not extended with back-references, to
  keep Part 13–17 files immutable per the handoff rules (same as Parts 14–17).
- **`exports` is a valid TS binding name.** Although `exports` is special in
  CommonJS, the schema files use ES module syntax (`export const`) and
  drizzle-kit/esbase handle `import { exports }`/`export const exports`
  correctly (verified: `pnpm db:generate` produced the migration with no
  error). The PostgreSQL table name `exports` is not a reserved word in PG.

## Files and Components

| Path                                                           | Purpose                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/database/schema/note-embeddings.ts`              | `note_embeddings` (1536-dim pgvector, HNSW cosine index, UNIQUE note_id) + `noteEmbeddingsRelations`. Documents the one-row-per-note design, the reindex-correctness columns (model/dimensions/content_hash), and the Part 53 chunked-design deferral.                                |
| `apps/api/src/database/schema/audit-logs.ts`                   | `audit_logs` (append-only; polymorphic entity; safe metadata; no updatedAt) + `auditLogsRelations`. Documents immutability as service-enforced (Part 71).                                                                                                                             |
| `apps/api/src/database/schema/api-keys.ts`                     | `api_keys` (hash-only key_hash UNIQUE; scopes CSV; soft revoke) + `apiKeysRelations`. Documents the raw-key-never-persisted rule and the scopes model.                                                                                                                                |
| `apps/api/src/database/schema/webhooks.ts`                     | `webhooks` (encrypted signing secret + key version; disabled until verified) + `webhook_deliveries` (immutable attempts; payload hash only) + `webhook_delivery_status` enum + relations. Documents HMAC/SSRF/retry deferral to Part 66.                                              |
| `apps/api/src/database/schema/exports.ts`                      | `exports` (state machine; two lifecycle timestamps; partial cleanup index; polymorphic source) + `export_format`/`export_status` enums + relations. Documents the create+download authorization recheck (Part 62) and private objects (Part 63).                                      |
| `apps/api/src/database/schema/ai.ts`                           | `ai_provider_config` (one per workspace; encrypted credentials + key version; disabled by default) + `ai_usage` (append-only; NO content columns) + `ai_provider` enum + relations. Documents credential encryption (Part 67), fail-closed quotas, and the content-not-retained rule. |
| `apps/api/src/database/schema/email-deliveries.ts`             | `email_deliveries` (template key + safe recipient; NO body/token columns; nullable workspace_id) + `email_status` enum + relation. Documents separate transaction-coupled outbox and worker replay protection.                                                                        |
| `apps/api/src/database/schema/job-idempotency.ts`              | `job_idempotency` (UNIQUE key; payload hash only; small safe result; TTL) + `job_status` enum. Documents independently expiring worker replay protection (ADR 0006) and the no-FK/no-relations choice.                                                                                |
| `apps/api/src/database/schema/job-outbox.ts`                   | Durable transaction-coupled intent, identifier-only typed/versioned payload, dispatch lifecycle, unique producer idempotency key, and workspace/dispatcher/correlation indexes.                                                                                                       |
| `apps/api/src/database/schema/index.ts`                        | Aggregate `schema` barrel now exposes the Part 18 tables, relations, and enums and re-exports each by name. `Schema = typeof schema` preserved.                                                                                                                                       |
| `apps/api/src/database/migrations/0006_graceful_blindfold.sql` | Generated forward migration: six enums, ten tables, fifteen FKs, four UNIQUE indexes, the HNSW cosine vector index, the partial object-retention index, the DESC audit index, and the tenant-scoped lookup indexes.                                                                   |
| `apps/api/src/database/migrations/meta/0006_snapshot.json`     | Generated Drizzle snapshot for migration 0006.                                                                                                                                                                                                                                        |
| `apps/api/src/database/migrations/meta/_journal.json`          | Appended journal entry `idx: 6`, `tag: 0006_graceful_blindfold`.                                                                                                                                                                                                                      |
| `apps/api/src/database/migrations/0007_early_bloodaxe.sql`     | Forward correction creating `job_outbox_status`, `job_outbox`, FK, uniqueness, and lookup indexes.                                                                                                                                                                                    |
| `apps/api/src/database/migrations/meta/0007_snapshot.json`     | Generated final Phase 3 snapshot at journal index 7.                                                                                                                                                                                                                                  |
| `apps/api/test/operations-integration-schema.test.ts`          | Unit suite (no DB) + DATABASE_URL-gated live suite asserting tables/enums, the HNSW vector index + cosine `<=>` query, api_keys uniqueness, the webhook_deliveries status enum constraint, and tenant-scoped indexes via pg_indexes.                                                  |

## Database and Data Changes

Migration `0006_graceful_blindfold.sql` is additive only. It creates six enum
types (`webhook_delivery_status`, `export_format`, `export_status`,
`ai_provider`, `email_status`, `job_status`), ten tables (`note_embeddings`,
`audit_logs`, `api_keys`, `webhooks`, `webhook_deliveries`, `exports`,
`ai_provider_config`, `ai_usage`, `email_deliveries`, `job_idempotency`),
fifteen foreign keys, four UNIQUE indexes (`api_keys_key_hash_unique`,
`ai_provider_config_workspace_id_unique`, `job_idempotency_key_unique`,
`note_embeddings_note_id_unique`), the HNSW vector index
(`note_embeddings_embedding_idx` `USING hnsw ("embedding"
vector_cosine_ops)`), a partial index (`exports_object_expires_at_idx WHERE
object_expires_at IS NOT NULL`), a DESC index
(`audit_logs_workspace_created_idx` on `(workspace_id, created_at DESC NULLS
LAST)`), and the tenant-scoped lookup indexes. Foreign-key cascade choices:
workspace_id CASCADE everywhere (tenant lifecycle); note_embeddings.note_id
CASCADE; webhook_deliveries.webhook_id CASCADE; created_by_id/requested_by_id
RESTRICT (audit convention); user_id/updated_by_id SET NULL. No data, no
seed, no destructive statement, no extension change (the `vector` extension is
already enabled by `0000_enable_extensions.sql`). Defaults use PostgreSQL
built-ins (`gen_random_uuid()`, `now()`, enum literals, `'{}'::jsonb`,
`'[]'::jsonb`) and require no extension beyond the Part 12 baseline. The
migration is forward-only per project policy; rollback is a separate reviewed
operation. No prior migration, snapshot, or journal entry was edited by hand.

## API, Configuration, and Operational Changes

None. No routes, contracts, queues, environment variables, ports, feature
flags, or deployment steps were added. Defaults are safe and deny-by-default:
AI is disabled (`ai_provider_config.provider` defaults `disabled`,
`is_enabled` defaults false); webhooks are disabled until verified
(`is_enabled`/`is_verified` default false); API keys start unrevoked but
require a hash; export jobs start `queued`; email deliveries start `queued`;
job idempotency rows start `pending`. No transport reads these tables yet.
The schema is purely structural; Parts 21 (auth), 24 (authorization), 50/51
(dispatcher/workers), 53 (embeddings indexer), 61 (API-key auth), 62/63
(export service/storage), 65 (email service), 66 (webhook dispatcher), 67 (AI
service), 71 (audit service), and 78 (retention cleanup) wire behavior on top.
Field encryption for `webhooks.encrypted_secret` and
`ai_provider_config.encrypted_credentials` is performed by the service layer
using `SECURITY_CONFIG.DATA_ENCRYPTION_KEYS`
(`apps/api/src/config/security.config.ts`); the schema stores only ciphertext

- key version.

## Security and Tenant-Isolation Notes

- **API keys are HASH-ONLY (ADR 0003).** `key_hash` is the sole on-disk
  representation; the raw key is generated, returned once, and discarded.
  `key_hash` is UNIQUE so each secret maps to exactly one row and the
  authenticate-by-key path is a single index scan. `key_prefix` is a
  non-sensitive display fragment. There is no `key`/`secret`/`token` column
  (asserted by the unit suite's forbidden-name check).
- **Webhook signing secrets and AI provider credentials are ENCRYPTED at
  rest** with the application master key; the schema stores only
  `encrypted_secret`/`encrypted_credentials` ciphertext + the
  `encryption_key_version` that produced it. Rotation (Part 67) scans by
  version and re-encrypts. There is no plaintext `secret`/`api_key`/
  `credentials` column (asserted by the unit suite).
- **Request/output content is NOT retained (ADR 0007).** `ai_usage` has no
  prompt/input/output/response/body columns (unit suite asserts a forbidden-
  name list); `email_deliveries` has no body/token/magic-link/subject
  columns; `audit_logs.metadata` is jsonb that the service redacts (no
  content/secrets); `webhook_deliveries` stores only a payload hash + a
  bounded redacted response snippet; `job_idempotency` stores only a payload
  hash + a small safe result.
- **Workspace tenancy.** Every tenant-owned table carries `workspace_id`
  directly and CASCADES on workspace delete. `email_deliveries.workspace_id`
  is nullable for system emails; `job_idempotency` is intentionally
  workspace-less (key-encoded intent). Tenant-scoped lookup indexes have
  `workspace_id` as their leftmost prefix (verified via `pg_indexes` in the
  live suite). A bare UUID never grants cross-workspace access: the owning
  services (Parts 24/61/62/66/67) always re-check the row's `workspace_id`
  against the caller's membership.
- **`exports` authorization is rechecked at create AND download (ADR 0007).**
  Possession of an export id or `object_key` never grants access; the service
  (Part 62) re-evaluates workspace membership + source-scope policy live.
  Objects are private in MinIO (ADR 0005; Part 63). Only `ready` rows are
  downloadable; `failed`/`cancelled`/`expired` are not, and their partial
  objects are cleaned up promptly.
- **`created_by_id`/`requested_by_id` columns are ON DELETE RESTRICT** to
  prevent silent loss of audit trails; the service (Part 26) reassigns before
  account deletion. SET NULL on `user_id`/`updated_by_id` preserves rows
  while clearing optional links (audit/usage events survive user deletion
  with a NULL actor).
- **Append-only tables have no `updated_at`.** `audit_logs`, `ai_usage`, and
  `webhook_deliveries` omit `updated_at`; immutability is service-enforced
  (Part 71 for audit; Part 66 for deliveries; the AI service for usage).
- **No secrets, raw keys, tokens, signed URLs, or personal content appear**
  in any column, the migration, the tests, or this record. The live vector
  test uses a deterministic pure-numeric literal (`unitVectorLiteral`); the
  uniqueness test uses a stand-in string `"sha256-hash-AAAA"` for a real
  salted hash; the webhook test uses `"encrypted-blob"` for real ciphertext.

## Verification Evidence

Final verification completed on 2026-07-29.

| Check                   | Result | Notes                                                                                                                           |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Migration chain         | Pass   | `0006_graceful_blindfold.sql` and `0007_early_bloodaxe.sql` applied on PostgreSQL 16/pgvector 0.8.5.                            |
| Vector/runtime suite    | Pass   | 1536-dimensional inserts, cosine ordering, HNSW `vector_cosine_ops`, key uniqueness, enum rejection, and tenant indexes passed. |
| Durable outbox          | Pass   | `job_outbox` exists after empty and populated upgrades; producer intent is separate from expiring worker idempotency.           |
| Secret/content review   | Pass   | API keys remain hash-only; encrypted credentials carry key versions; usage/delivery/outbox rows omit raw secrets and content.   |
| Repository quality gate | Pass   | Sequential format, lint, type-check, tests, build, audit threshold, and `db:check` passed.                                      |

## Known Limitations and Follow-up Work

- **Field encryption is service-side (Parts 66/67).** The schema stores
  ciphertext blobs + key versions only; the actual encrypt/decrypt, key
  selection, and rotation re-encryption are owned by the webhook dispatcher
  (Part 66) and AI service (Part 67) using `SECURITY_CONFIG.DATA_ENCRYPTION_KEYS`.
- **API-key authentication + scope enforcement is Part 61.** This table is the
  hash-only store; the API-key auth middleware, scope parsing/validation, and
  revocation enforcement are Part 61. `last_used_at` is updated by that
  middleware.
- **Webhook HMAC signing, SSRF prevention, verification challenge, and
  bounded retries are Part 66.** This table stores only the endpoint model
  (encrypted secret, events, enabled/verified flags) and immutable delivery
  attempts; the dispatcher owns signing, URL validation (HTTPS outside dev),
  private-IP rejection, idempotency headers, exponential backoff with jitter,
  and capped attempts (Notted.md "max 5 attempts").
- **Export generation, authorization rechecks, and object lifecycle are
  Parts 62/63/78.** The service (Part 62) rechecks authorization at create
  and download; the storage adapter (Part 63) manages the private MinIO
  object behind the opaque `object_key`; the cleanup flow (Parts 45/62) reaps
  past-`object_expires_at` objects and flips the row to `expired`, and cleans
  up partial objects for failed/cancelled rows.
- **AI provider configuration, quota fail-closed, and usage writes are Part 67.** The AI service encrypts/decrypts credentials, enforces quotas (fail
  closed), resolves feature/model, and writes `ai_usage` rows with token
  counts + cost only (never content).
- **Email rendering, dispatch, suppress-list, outbox, and worker idempotency are Part 65.** The email service renders templates at send time (bodies/tokens are
  never persisted), writes `email_deliveries` plus `job_outbox` in one
  transaction, dispatches after commit, and lets the worker claim a separate
  `job_idempotency` replay key.
- **Audit-log write/redaction and append-only enforcement are Part 71.** The
  schema signals append-only (no `updated_at`); the service enforces
  immutability and redacts `metadata` before insert.
- **Job dispatcher/workers and the two independent lifecycles are Parts 50/51.**
  The dispatcher owns `job_outbox`; workers own `job_idempotency`. Payloads
  never contain bodies/credentials/secrets (ADR 0006). BullMQ's in-memory
  dedup does not survive a Redis flush; this table is the durable cross-
  restart surface.
- **Embeddings indexer (reindex on model/text change, multi-vector/chunked
  design) is Part 53.** This table is the one-row-per-note projection; the
  indexer owns the upsert, model/dimension detection, and stale-vector
  recompute. A later migration may add a chunked-embeddings table without
  conflict.
- **Retention/purge of audit logs, ai_usage, email_deliveries, job_idempotency
  rows, and export objects/records is Part 19/78.** This part models the data
  and TTL columns (`job_idempotency.expires_at`, `exports.object_expires_at`,
  `exports.signed_url_expires_at`); the retention policies are owned by Part
  19 (policy) and the owning Parts 45/50/55/71 (cleanup jobs).
- **The README index (`docs/completed-parts/README.md`) was intentionally not
  edited** (per task instructions; Parts 13–17 followed the same convention).

## Handoff Notes

- Never edit prior migrations `0000_enable_extensions.sql`,
  `0001_volatile_wiccan.sql`, `0002_minor_mad_think.sql`,
  `0003_cute_maria_hill.sql`, `0004_outgoing_catseye.sql`,
  `0005_slim_rick_jones.sql`, their snapshots, or the pre-Part-18 journal
  entries. Forward-only corrections use a new migration.
- Migration `0006_graceful_blindfold.sql` and its snapshot are now immutable;
  any later operations/integration schema change must use a new generated
  forward migration and update the schema barrel.
- Part 18 is the FINAL schema part. Phase 3 (Parts 12–18) data modeling is
  complete. Part 19 (tenant protection + retention policies) and Part 20
  (seed) follow.
- The `vector` extension must remain enabled (Part 12 baseline
  `0000_enable_extensions.sql`). Any environment running the migrations must
  have pgvector installed and the extension enabled, or the
  `note_embeddings_embedding_idx` HNSW index creation will fail.
- `note_embeddings.embedding` is fixed at 1536 dimensions. If a different
  embedding model is introduced later (Part 53), detect via the `model` and
  `dimensions` columns and recompute; a dimension change requires a migration
  (the vector column type is part of the contract).
- The RESTRICT constraints on `api_keys.created_by_id`,
  `webhooks.created_by_id`, and `exports.requested_by_id` mean any Part 21/26
  user-deletion path must handle these creators (transfer or reassign before
  account deletion), alongside the Part 14–17 creators.
- `webhook_deliveries` and `audit_logs` and `ai_usage` have NO `updated_at`;
  any code expecting to timestamp updates to these rows must instead insert a
  new row (deliveries) or accept append-only semantics (audit/usage).
- `exports` and `job_idempotency` are valid TS binding names but `exports` is
  special in CommonJS; the schema files use ES module syntax and esbuild
  handles it (verified by `db:generate`). Do not convert these modules to
  CommonJS without renaming the bindings.
- When running the live suite locally, ensure `DATABASE_URL` points at a
  disposable dev PostgreSQL with the `vector` extension (the dev compose stack
  from Part 9). The live suite applies migrations and creates/cleans up its
  own deterministic fixtures via the workspace cascade, but run it against a
  fresh database or after `infra:reset:dev` for a clean state. The vector
  insert uses a deterministic pure-numeric literal (no user content, no
  secrets).

## Revision History

| Date       | Author                      | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-28 | `backend-platform-engineer` | Initial Part 18 record: added note_embeddings (pgvector HNSW), audit_logs, api_keys (hash-only), webhooks + webhook_deliveries (encrypted secret + key version), exports (state machine + two lifecycle timestamps + partial cleanup index), ai_provider_config + ai_usage (encrypted credentials + content-not-retained), email_deliveries (no bodies/tokens), and job_idempotency (UNIQUE key + payload hash only), with six enums; generated migration `0006_graceful_blindfold.sql`; added unit + live test suites. Status left `In progress` pending reviewer verification. |
| 2026-07-29 | `backend-platform-engineer` | Reviewer #1 fix pass: added `job_outbox` and `job_outbox_status` in migration `0007_early_bloodaxe.sql`. Intent is inserted with the business commit and dispatched after commit; identifier-only versioned payloads exclude content/secrets. `job_idempotency` remains independently expiring worker replay protection. Verification remains pending Reviewer #2.                                                                                                                                                                                                               |
| 2026-07-29 | Lead                        | Completed pgvector/HNSW, hash/encryption, outbox, migration, and repository gates; marked Part 18 Complete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
