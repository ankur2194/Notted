import { resolve } from "node:path";

import { isTable, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aiProviderConfig,
  aiProviderConfigRelations,
  aiProviderEnum,
  aiUsage,
  aiUsageRelations,
  apiKeys,
  apiKeysRelations,
  auditLogs,
  auditLogsRelations,
  emailDeliveries,
  emailDeliveriesRelations,
  emailStatusEnum,
  exportFormatEnum,
  exportStatusEnum,
  exportJobs,
  exportJobsRelations,
  jobIdempotency,
  jobOutbox,
  jobOutboxRelations,
  jobOutboxStatusEnum,
  jobStatusEnum,
  noteEmbeddings,
  noteEmbeddingsRelations,
  schema,
  webhookDeliveryStatusEnum,
  webhookDeliveries,
  webhookDeliveriesRelations,
  webhooks,
  webhooksRelations,
} from "../src/database/schema";

import { expectPostgresErrorCode } from "./database-test-helpers";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");
const CONNECTION_TIMEOUT_MS = 2_000;

const HAS_DATABASE_URL = typeof DATABASE_URL === "string" && DATABASE_URL.trim() !== "";

/** The dimensionality of the `note_embeddings.embedding` vector column. */
const EMBEDDING_DIMENSIONS = 1536;

/** True when `value` looks like a Drizzle `Relations` object (config + table). */
function isRelationsObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { config?: unknown }).config === "function" &&
    typeof (value as { table?: unknown }).table === "object"
  );
}

/** Map of index name -> isUnique for a table, via Drizzle metadata. */
function indexUniqueness(table: PgTable): Map<string, boolean> {
  return new Map(
    getTableConfig(table).indexes.map((idx) => [idx.config.name ?? "", idx.config.unique]),
  );
}

/** Map of index name -> access method (e.g. "hnsw") for a table. `undefined`
 * means the default btree (Drizzle emits no method for the default). */
function indexMethod(table: PgTable): Map<string, string | undefined> {
  return new Map(
    getTableConfig(table).indexes.map((idx) => [idx.config.name ?? "", idx.config.method]),
  );
}

/** Map of column name -> column for a table, via Drizzle metadata. */
function columnsOf(table: PgTable): Map<string, { notNull: boolean; name: string }> {
  return new Map(
    getTableConfig(table).columns.map((c) => [c.name, { notNull: c.notNull, name: c.name }]),
  );
}

/** Set of column names for a table, via Drizzle metadata. */
function columnNames(table: PgTable): Set<string> {
  return new Set(getTableConfig(table).columns.map((c) => c.name));
}

/** PostgreSQL error codes asserted by the live suite. */
const PG_UNIQUE_VIOLATION = "23505";
// Inserting a value that is not a valid label of a PostgreSQL enum type
// raises SQLSTATE 22P02 (invalid_text_representation): "invalid input value
// for enum".
const PG_INVALID_TEXT_REPRESENTATION = "22P02";

// ----------------------------------------------------------------------------
// Unit tests: schema shape, columns, indexes, enums, and the hash-only /
// content-omission invariants. These run without a database because they only
// inspect Drizzle metadata declared in TypeScript.
// ----------------------------------------------------------------------------

describe("operations and integration tables schema (unit)", () => {
  it("exposes the Part 18 tables, enums, and relations in the schema barrel", () => {
    // All Part 18 tables are present in the aggregate barrel.
    expect(isTable(schema.noteEmbeddings)).toBe(true);
    expect(isTable(schema.auditLogs)).toBe(true);
    expect(isTable(schema.apiKeys)).toBe(true);
    expect(isTable(schema.webhooks)).toBe(true);
    expect(isTable(schema.webhookDeliveries)).toBe(true);
    expect(isTable(schema.exportJobs)).toBe(true);
    expect(isTable(schema.aiProviderConfig)).toBe(true);
    expect(isTable(schema.aiUsage)).toBe(true);
    expect(isTable(schema.emailDeliveries)).toBe(true);
    expect(isTable(schema.jobIdempotency)).toBe(true);
    expect(isTable(schema.jobOutbox)).toBe(true);

    // Relations objects for the relational tables (job_idempotency is
    // intentionally standalone — no relations).
    for (const rel of [
      schema.noteEmbeddingsRelations,
      schema.auditLogsRelations,
      schema.apiKeysRelations,
      schema.webhooksRelations,
      schema.webhookDeliveriesRelations,
      schema.exportJobsRelations,
      schema.aiProviderConfigRelations,
      schema.aiUsageRelations,
      schema.emailDeliveriesRelations,
      schema.jobOutboxRelations,
    ]) {
      expect(isRelationsObject(rel)).toBe(true);
    }
  });

  it("exports each Part 18 table, relation, and enum by name", () => {
    expect(noteEmbeddings).toBe(schema.noteEmbeddings);
    expect(auditLogs).toBe(schema.auditLogs);
    expect(apiKeys).toBe(schema.apiKeys);
    expect(webhooks).toBe(schema.webhooks);
    expect(webhookDeliveries).toBe(schema.webhookDeliveries);
    expect(exportJobs).toBe(schema.exportJobs);
    expect(aiProviderConfig).toBe(schema.aiProviderConfig);
    expect(aiUsage).toBe(schema.aiUsage);
    expect(emailDeliveries).toBe(schema.emailDeliveries);
    expect(jobIdempotency).toBe(schema.jobIdempotency);
    expect(jobOutbox).toBe(schema.jobOutbox);

    expect(noteEmbeddingsRelations).toBe(schema.noteEmbeddingsRelations);
    expect(auditLogsRelations).toBe(schema.auditLogsRelations);
    expect(apiKeysRelations).toBe(schema.apiKeysRelations);
    expect(webhooksRelations).toBe(schema.webhooksRelations);
    expect(webhookDeliveriesRelations).toBe(schema.webhookDeliveriesRelations);
    expect(exportJobsRelations).toBe(schema.exportJobsRelations);
    expect(aiProviderConfigRelations).toBe(schema.aiProviderConfigRelations);
    expect(aiUsageRelations).toBe(schema.aiUsageRelations);
    expect(emailDeliveriesRelations).toBe(schema.emailDeliveriesRelations);
    expect(jobOutboxRelations).toBe(schema.jobOutboxRelations);

    expect(aiProviderEnum).toBe(schema.aiProviderEnum);
    expect(emailStatusEnum).toBe(schema.emailStatusEnum);
    expect(exportFormatEnum).toBe(schema.exportFormatEnum);
    expect(exportStatusEnum).toBe(schema.exportStatusEnum);
    expect(jobStatusEnum).toBe(schema.jobStatusEnum);
    expect(jobOutboxStatusEnum).toBe(schema.jobOutboxStatusEnum);
    expect(webhookDeliveryStatusEnum).toBe(schema.webhookDeliveryStatusEnum);
  });

  it("declares the Part 18 enums with the expected values", () => {
    expect(webhookDeliveryStatusEnum.enumName).toBe("webhook_delivery_status");
    expect(webhookDeliveryStatusEnum.enumValues).toEqual([
      "pending",
      "success",
      "failed",
      "retrying",
    ]);

    expect(exportFormatEnum.enumName).toBe("export_format");
    expect(exportFormatEnum.enumValues).toEqual(["pdf", "html", "markdown", "txt", "docx", "zip"]);

    expect(exportStatusEnum.enumName).toBe("export_status");
    expect(exportStatusEnum.enumValues).toEqual([
      "queued",
      "processing",
      "ready",
      "failed",
      "expired",
      "cancelled",
    ]);

    expect(aiProviderEnum.enumName).toBe("ai_provider");
    expect(aiProviderEnum.enumValues).toEqual(["openai", "anthropic", "disabled"]);

    expect(emailStatusEnum.enumName).toBe("email_status");
    expect(emailStatusEnum.enumValues).toEqual([
      "queued",
      "processing",
      "sent",
      "failed",
      "suppressed",
      "reconciliation_required",
    ]);

    expect(jobStatusEnum.enumName).toBe("job_status");
    expect(jobStatusEnum.enumValues).toEqual([
      "pending",
      "processing",
      "completed",
      "failed",
      "reconciliation_required",
    ]);
    expect(jobOutboxStatusEnum.enumName).toBe("job_outbox_status");
    expect(jobOutboxStatusEnum.enumValues).toEqual([
      "pending",
      "dispatching",
      "dispatched",
      "completed",
      "failed",
      "cancelled",
    ]);
  });

  it("declares a durable identifier-only outbox separate from worker idempotency", () => {
    const cols = columnsOf(jobOutbox);
    for (const name of [
      "id",
      "workspace_id",
      "queue_name",
      "job_type",
      "payload_version",
      "payload",
      "payload_hash",
      "idempotency_key",
      "status",
      "attempt_count",
      "available_at",
      "locked_at",
      "dispatched_at",
      "completed_at",
      "correlation_id",
      "last_error_code",
      "created_at",
      "updated_at",
    ]) {
      expect(cols.has(name), `job_outbox.${name}`).toBe(true);
    }

    expect(cols.get("workspace_id")?.notNull).toBe(false);
    expect(cols.get("payload_version")?.notNull).toBe(true);
    expect(cols.get("payload")?.notNull).toBe(true);
    expect(cols.get("payload_hash")?.notNull).toBe(true);
    expect(cols.get("idempotency_key")?.notNull).toBe(true);
    expect(cols.get("status")?.notNull).toBe(true);
    expect(cols.get("attempt_count")?.notNull).toBe(true);
    expect(indexUniqueness(jobOutbox).get("job_outbox_idempotency_key_unique")).toBe(true);
    expect(indexUniqueness(jobOutbox).get("job_outbox_workspace_created_idx")).toBe(false);
    expect(indexUniqueness(jobOutbox).get("job_outbox_dispatcher_idx")).toBe(false);
    expect(indexUniqueness(jobOutbox).get("job_outbox_correlation_id_idx")).toBe(false);
  });

  it("declares api_keys as hash-only with a UNIQUE key_hash and safe defaults", () => {
    const cols = columnsOf(apiKeys);
    for (const name of [
      "id",
      "workspace_id",
      "created_by_id",
      "name",
      "key_hash",
      "key_prefix",
      "scopes",
      "last_used_at",
      "expires_at",
      "is_revoked",
      "created_at",
    ]) {
      expect(cols.has(name), `api_keys.${name}`).toBe(true);
    }

    // CRITICAL: the raw key is NEVER stored. Only the hash and the display
    // prefix. There is no `key`, `secret`, `token`, or `plaintext` column.
    expect(columnNames(apiKeys).has("key")).toBe(false);
    expect(columnNames(apiKeys).has("raw_key")).toBe(false);
    expect(columnNames(apiKeys).has("secret")).toBe(false);
    expect(columnNames(apiKeys).has("token")).toBe(false);

    expect(cols.get("key_hash")?.notNull).toBe(true);
    expect(cols.get("key_prefix")?.notNull).toBe(true);
    expect(cols.get("is_revoked")?.notNull).toBe(true);
    expect(cols.get("last_used_at")?.notNull).toBe(false);
    expect(cols.get("expires_at")?.notNull).toBe(false);

    // UNIQUE key_hash powers the authenticate-by-key lookup + uniqueness.
    expect(indexUniqueness(apiKeys).get("api_keys_key_hash_unique")).toBe(true);
    // (workspace_id) list/admin lookup.
    expect(indexUniqueness(apiKeys).get("api_keys_workspace_id_idx")).toBe(false);
  });

  it("declares ai_provider_config with one row per workspace (UNIQUE workspace_id)", () => {
    const cols = columnsOf(aiProviderConfig);
    for (const name of [
      "id",
      "workspace_id",
      "provider",
      "model",
      "encrypted_credentials",
      "encryption_key_version",
      "is_enabled",
      "settings",
      "updated_by_id",
      "created_at",
      "updated_at",
    ]) {
      expect(cols.has(name), `ai_provider_config.${name}`).toBe(true);
    }

    // Provider defaults to "disabled" and isEnabled defaults false
    // (deny-by-default per ADR 0007).
    expect(cols.get("provider")?.notNull).toBe(true);
    expect(cols.get("is_enabled")?.notNull).toBe(true);

    // CRITICAL: credentials are stored only as an ENCRYPTED blob + the key
    // version that produced it. There is no plaintext column.
    expect(columnNames(aiProviderConfig).has("api_key")).toBe(false);
    expect(columnNames(aiProviderConfig).has("credentials")).toBe(false);
    expect(columnNames(aiProviderConfig).has("plaintext")).toBe(false);

    // One config per workspace; the unique index also serves the lookup.
    expect(indexUniqueness(aiProviderConfig).get("ai_provider_config_workspace_id_unique")).toBe(
      true,
    );
  });

  it("declares job_idempotency with a UNIQUE key and TTL/dedup columns", () => {
    const cols = columnsOf(jobIdempotency);
    for (const name of [
      "id",
      "key",
      "queue_name",
      "status",
      "payload_hash",
      "result",
      "error_message",
      "expires_at",
      "created_at",
      "updated_at",
    ]) {
      expect(cols.has(name), `job_idempotency.${name}`).toBe(true);
    }

    // CRITICAL: only a payload HASH is stored; never the payload itself
    // (ADR 0006 — payloads never contain bodies/credentials/secrets).
    expect(columnNames(jobIdempotency).has("payload")).toBe(false);

    expect(cols.get("key")?.notNull).toBe(true);
    expect(cols.get("queue_name")?.notNull).toBe(true);
    expect(cols.get("expires_at")?.notNull).toBe(true);

    // UNIQUE key is the durable dedup surface.
    expect(indexUniqueness(jobIdempotency).get("job_idempotency_key_unique")).toBe(true);
    expect(indexUniqueness(jobIdempotency).get("job_idempotency_queue_status_idx")).toBe(false);
    expect(indexUniqueness(jobIdempotency).get("job_idempotency_expires_at_idx")).toBe(false);
  });

  it("declares note_embeddings with a UNIQUE note_id, the embedding vector, and an HNSW index", () => {
    const cols = columnsOf(noteEmbeddings);
    for (const name of [
      "id",
      "note_id",
      "embedding",
      "model",
      "content_hash",
      "dimensions",
      "created_at",
    ]) {
      expect(cols.has(name), `note_embeddings.${name}`).toBe(true);
    }

    expect(cols.get("note_id")?.notNull).toBe(true);
    expect(cols.get("embedding")?.notNull).toBe(true);
    expect(cols.get("model")?.notNull).toBe(true);
    expect(cols.get("content_hash")?.notNull).toBe(true);
    expect(cols.get("dimensions")?.notNull).toBe(true);

    // One current embedding per note.
    expect(indexUniqueness(noteEmbeddings).get("note_embeddings_note_id_unique")).toBe(true);

    // HNSW access method with the cosine operator class is asserted at the DB
    // layer (pg_indexes indexdef) in the live suite; here we assert the
    // Drizzle-declared access method is "hnsw" (the default is undefined/btree).
    expect(indexMethod(noteEmbeddings).get("note_embeddings_embedding_idx")).toBe("hnsw");
  });

  it("declares ai_usage WITHOUT any request/output content columns (ADR 0007)", () => {
    const names = columnNames(aiUsage);

    // The full safe column set: identity + accounting + outcome only.
    for (const name of [
      "id",
      "workspace_id",
      "user_id",
      "feature",
      "provider",
      "model",
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
      "cost_micros",
      "status",
      "error_code",
      "created_at",
    ]) {
      expect(names.has(name), `ai_usage.${name}`).toBe(true);
    }

    // CRITICAL (ADR 0007): request/output content is NOT retained. Assert no
    // column that could hold prompt/input/output/response/body/content exists.
    const forbidden = [
      "prompt",
      "input",
      "output",
      "response",
      "body",
      "content",
      "request",
      "request_body",
      "output_text",
      "result_text",
      "excerpt",
    ];
    for (const name of forbidden) {
      expect(names.has(name), `ai_usage must NOT have ${name}`).toBe(false);
    }

    // Append-only: no updated_at.
    expect(names.has("updated_at")).toBe(false);

    // The three tenant-scoped lookup indexes (time / feature / status).
    const idx = indexUniqueness(aiUsage);
    expect(idx.get("ai_usage_workspace_created_idx")).toBe(false);
    expect(idx.get("ai_usage_workspace_feature_idx")).toBe(false);
    expect(idx.get("ai_usage_workspace_status_idx")).toBe(false);
  });

  it("declares email_deliveries WITHOUT any body/token/magic-link columns", () => {
    const names = columnNames(emailDeliveries);

    for (const name of [
      "id",
      "workspace_id",
      "recipient",
      "template_key",
      "status",
      "attempts",
      "provider_message_id",
      "error_message",
      "related_entity_type",
      "related_entity_id",
      "created_at",
      "sent_at",
    ]) {
      expect(names.has(name), `email_deliveries.${name}`).toBe(true);
    }

    // CRITICAL (ADR 0007): rendered bodies, tokens, and magic links are never
    // persisted. recipient is an email address, not a token.
    const forbidden = [
      "body",
      "html",
      "text",
      "subject",
      "token",
      "magic_link",
      "link",
      "url",
      "code",
      "rendered",
    ];
    for (const name of forbidden) {
      expect(names.has(name), `email_deliveries must NOT have ${name}`).toBe(false);
    }
  });

  it("declares webhooks with an encrypted secret + key version and disabled defaults", () => {
    const cols = columnsOf(webhooks);
    for (const name of [
      "id",
      "workspace_id",
      "created_by_id",
      "url",
      "encrypted_secret",
      "encryption_key_version",
      "events",
      "is_enabled",
      "is_verified",
      "created_at",
      "updated_at",
    ]) {
      expect(cols.has(name), `webhooks.${name}`).toBe(true);
    }

    // CRITICAL: the signing secret is stored only as an ENCRYPTED blob + the
    // key version. There is no plaintext `secret` column.
    expect(columnNames(webhooks).has("secret")).toBe(false);
    expect(columnNames(webhooks).has("signing_secret")).toBe(false);

    expect(cols.get("encrypted_secret")?.notNull).toBe(true);
    expect(cols.get("encryption_key_version")?.notNull).toBe(true);
    // Endpoints start DISABLED until verified (ADR 0007).
    expect(cols.get("is_enabled")?.notNull).toBe(true);
    expect(cols.get("is_verified")?.notNull).toBe(true);
  });

  it("declares exports with the private-object-storage + two-lifecycle columns", () => {
    const names = columnNames(exportJobs);
    for (const name of [
      "id",
      "workspace_id",
      "requested_by_id",
      "format",
      "options",
      "status",
      "source_type",
      "source_id",
      "object_key",
      "object_expires_at",
      "signed_url_expires_at",
      "error_code",
      "error_message",
      "created_at",
      "completed_at",
    ]) {
      expect(names.has(name), `exports.${name}`).toBe(true);
    }

    // Two distinct lifecycles (ADR 0007): object retention vs download grant.
    expect(names.has("object_expires_at")).toBe(true);
    expect(names.has("signed_url_expires_at")).toBe(true);

    // Lookup indexes + the partial object-retention cleanup index.
    const idx = indexUniqueness(exportJobs);
    expect(idx.get("exports_workspace_created_idx")).toBe(false);
    expect(idx.get("exports_requested_by_id_idx")).toBe(false);
    expect(idx.get("exports_status_idx")).toBe(false);
    expect(idx.get("exports_object_expires_at_idx")).toBe(false);
  });

  it("declares audit_logs as append-only (no updated_at) with safe metadata", () => {
    const names = columnNames(auditLogs);
    for (const name of [
      "id",
      "workspace_id",
      "user_id",
      "action",
      "entity_type",
      "entity_id",
      "metadata",
      "ip_address",
      "user_agent",
      "request_id",
      "created_at",
    ]) {
      expect(names.has(name), `audit_logs.${name}`).toBe(true);
    }

    // Append-only: no updated_at (immutability is service-enforced, Part 71).
    expect(names.has("updated_at")).toBe(false);

    const idx = indexUniqueness(auditLogs);
    expect(idx.get("audit_logs_workspace_created_idx")).toBe(false);
    expect(idx.get("audit_logs_workspace_entity_idx")).toBe(false);
    expect(idx.get("audit_logs_user_id_idx")).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Live migration test (DATABASE_URL-gated). Follows the same skip pattern as
// `database.migration.test.ts` and `tasks-schema.test.ts` so it is inert in CI
// without a database and skips cleanly when dev compose is not running. Each
// live test creates deterministic unique fixtures and cleans up via the
// workspace cascade in a finally block. Deterministic and secret-free: the
// vector literal is built from a fixed numeric pattern, not from any user
// content or credential.
// ----------------------------------------------------------------------------

async function isDatabaseReachable(connectionString: string): Promise<boolean> {
  const client = new Client({ connectionString, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS });
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {
      /* connection cleanup is best-effort during the reachability probe */
    });
  }
}

/** Creates deterministic user + workspace + owner membership and returns their ids. */
async function bootstrapTenant(
  db: NodePgDatabase,
  stamp: string,
  label: string,
): Promise<{ userId: string; workspaceId: string }> {
  const email = `p18-${label}-${stamp}@notted.invalid`;
  const slug = `p18-${label}-${stamp}`;

  const user = await db.execute(sql`
    insert into users (email, name) values (${email}, ${`Part18 ${label}`})
    returning id
  `);
  const userId = (user.rows[0] as { id: string }).id;

  const workspace = await db.execute(sql`
    insert into workspaces (name, slug, created_by_id)
    values (${"Part18 " + label}, ${slug}, ${userId})
    returning id
  `);
  const workspaceId = (workspace.rows[0] as { id: string }).id;

  await db.execute(sql`
    insert into workspace_members (workspace_id, user_id, role)
    values (${workspaceId}, ${userId}, 'owner')
  `);

  return { userId, workspaceId };
}

/**
 * Builds a deterministic pgvector text literal of `dimensions` values. Index
 * `oneAt` receives 1.0; every other index receives 0.0. Deterministic and
 * secret-free (pure numeric pattern, no user content or credential).
 */
function unitVectorLiteral(dimensions: number, oneAt: number): string {
  const parts = new Array<string>(dimensions);
  for (let i = 0; i < dimensions; i += 1) {
    parts[i] = i === oneAt ? "1" : "0";
  }
  return `[${parts.join(",")}]`;
}

describe.skipIf(!HAS_DATABASE_URL)("operations and integration tables schema (live)", () => {
  let pool: Pool | undefined;
  let db: NodePgDatabase | undefined;
  let reachable = false;

  beforeAll(async () => {
    reachable = await isDatabaseReachable(DATABASE_URL as string);
    if (!reachable) {
      return;
    }
    pool = new Pool({ connectionString: DATABASE_URL as string, max: 1 });
    const database = drizzle(pool);
    db = database;
    await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterAll(async () => {
    if (pool !== undefined) {
      await pool.end().catch(() => {
        /* pool shutdown is best-effort during teardown */
      });
    }
  });

  it("creates the Part 18 tables and enums", async ({ skip }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const tables = (
      await db.execute(sql`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name in (
            'note_embeddings', 'audit_logs', 'api_keys',
            'webhooks', 'webhook_deliveries', 'exports',
            'ai_provider_config', 'ai_usage', 'email_deliveries',
            'job_idempotency', 'job_outbox'
          )
        order by table_name
      `)
    ).rows as unknown as ReadonlyArray<{ table_name: string }>;

    expect(tables.map((row) => row.table_name)).toEqual([
      "ai_provider_config",
      "ai_usage",
      "api_keys",
      "audit_logs",
      "email_deliveries",
      "exports",
      "job_idempotency",
      "job_outbox",
      "note_embeddings",
      "webhook_deliveries",
      "webhooks",
    ]);

    const enumTypes = (
      await db.execute(sql`
        select t.typname, e.enumlabel
        from pg_type t
        join pg_enum e on t.oid = e.enumtypid
        where t.typname in (
          'webhook_delivery_status', 'export_format', 'export_status',
          'ai_provider', 'email_status', 'job_status', 'job_outbox_status'
        )
        order by t.typname, e.enumsortorder
      `)
    ).rows as unknown as ReadonlyArray<{ typname: string; enumlabel: string }>;

    const byType = new Map<string, string[]>();
    for (const row of enumTypes) {
      const list = byType.get(row.typname) ?? [];
      list.push(row.enumlabel);
      byType.set(row.typname, list);
    }
    expect(byType.get("ai_provider")).toEqual(["openai", "anthropic", "disabled"]);
    expect(byType.get("email_status")).toEqual([
      "queued",
      "processing",
      "sent",
      "failed",
      "suppressed",
      "reconciliation_required",
    ]);
    expect(byType.get("export_format")).toEqual(["pdf", "html", "markdown", "txt", "docx", "zip"]);
    expect(byType.get("export_status")).toEqual([
      "queued",
      "processing",
      "ready",
      "failed",
      "expired",
      "cancelled",
    ]);
    expect(byType.get("job_status")).toEqual([
      "pending",
      "processing",
      "completed",
      "failed",
      "reconciliation_required",
    ]);
    expect(byType.get("job_outbox_status")).toEqual([
      "pending",
      "dispatching",
      "dispatched",
      "completed",
      "failed",
      "cancelled",
    ]);
    expect(byType.get("webhook_delivery_status")).toEqual([
      "pending",
      "success",
      "failed",
      "retrying",
    ]);
  });

  it("(a) accepts a 1536-dim vector insert into note_embeddings and runs a cosine <=> query", async ({
    skip,
  }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const { userId, workspaceId } = await bootstrapTenant(db, stamp, "vec");

    try {
      // Two notes, each with one embedding. Embedding A is the unit vector
      // along dimension 0; embedding B along dimension 1. Both 1536-dim.
      const noteA = await db.execute(sql`
        insert into notes (workspace_id, title, created_by_id)
        values (${workspaceId}, ${"Vec A " + stamp}, ${userId})
        returning id
      `);
      const noteAId = (noteA.rows[0] as { id: string }).id;

      const noteB = await db.execute(sql`
        insert into notes (workspace_id, title, created_by_id)
        values (${workspaceId}, ${"Vec B " + stamp}, ${userId})
        returning id
      `);
      const noteBId = (noteB.rows[0] as { id: string }).id;

      const embeddingA = unitVectorLiteral(EMBEDDING_DIMENSIONS, 0);
      const embeddingB = unitVectorLiteral(EMBEDDING_DIMENSIONS, 1);

      // Insert the 1536-dim vector via an explicit ::vector cast of the
      // deterministic text literal. `dimensions` mirrors the vector length so
      // the query path can detect mismatches before issuing `<=>`.
      await db.execute(sql`
        insert into note_embeddings (note_id, embedding, model, content_hash, dimensions)
        values (${noteAId}, ${embeddingA}::vector, ${"test-embed-small"}, ${"hashA-" + stamp}, ${EMBEDDING_DIMENSIONS})
      `);
      await db.execute(sql`
        insert into note_embeddings (note_id, embedding, model, content_hash, dimensions)
        values (${noteBId}, ${embeddingB}::vector, ${"test-embed-small"}, ${"hashB-" + stamp}, ${EMBEDDING_DIMENSIONS})
      `);

      // UNIQUE note_id: a second embedding for note A must be rejected.
      await expectPostgresErrorCode(
        db.execute(sql`
          insert into note_embeddings (note_id, embedding, model, content_hash, dimensions)
          values (${noteAId}, ${embeddingA}::vector, ${"test-embed-small"}, ${"hashA2-" + stamp}, ${EMBEDDING_DIMENSIONS})
        `),
        PG_UNIQUE_VIOLATION,
      );

      // Cosine distance (<=>) query: the query vector is identical to
      // embedding A (unit vector along dimension 0). Distance(A, query) = 0;
      // Distance(B, query) = 1 (orthogonal). A must be the nearest neighbor.
      const queryVec = unitVectorLiteral(EMBEDDING_DIMENSIONS, 0);
      const nearest = await db.execute(sql`
        select note_id, embedding <=> ${queryVec}::vector as distance
        from note_embeddings
        order by embedding <=> ${queryVec}::vector
        limit 1
      `);
      const row = nearest.rows[0] as { note_id: string; distance: number };
      expect(row.note_id).toBe(noteAId);
      // Cosine distance of identical vectors is 0.
      expect(Number(row.distance)).toBe(0);

      // Sanity: B is orthogonal (cosine distance 1).
      const allOrdered = await db.execute(sql`
        select note_id
        from note_embeddings
        order by embedding <=> ${queryVec}::vector
      `);
      expect((allOrdered.rows as unknown as { note_id: string }[]).map((r) => r.note_id)).toEqual([
        noteAId,
        noteBId,
      ]);
    } finally {
      // Deleting the workspace cascades to its notes, which cascade to
      // note_embeddings; the user row is removed explicitly.
      await db.execute(sql`delete from workspaces where id = ${workspaceId}`);
      await db.execute(sql`delete from users where id = ${userId}`);
    }
  });

  it("(b) rejects a duplicate api_keys.key_hash via the UNIQUE constraint", async ({ skip }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const { userId, workspaceId } = await bootstrapTenant(db, stamp, "apikey");

    try {
      // The same key_hash for two different keys must be rejected — a generated
      // secret maps to exactly one api_keys row. The raw key is never stored;
      // "sha256-hash-AAAA" stands in for a real salted hash.
      await db.execute(sql`
        insert into api_keys (workspace_id, created_by_id, name, key_hash, key_prefix)
        values (${workspaceId}, ${userId}, ${"Key A " + stamp}, ${"sha256-hash-AAAA"}, ${"ntd_pk_a"})
      `);

      await expectPostgresErrorCode(
        db.execute(sql`
          insert into api_keys (workspace_id, created_by_id, name, key_hash, key_prefix)
          values (${workspaceId}, ${userId}, ${"Key B " + stamp}, ${"sha256-hash-AAAA"}, ${"ntd_pk_b"})
        `),
        PG_UNIQUE_VIOLATION,
      );
    } finally {
      await db.execute(sql`delete from workspaces where id = ${workspaceId}`);
      await db.execute(sql`delete from users where id = ${userId}`);
    }
  });

  it("(c) rejects an invalid webhook_deliveries.status via the enum constraint", async ({
    skip,
  }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const stamp = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const { userId, workspaceId } = await bootstrapTenant(db, stamp, "wh");

    try {
      // A webhook endpoint is required as the delivery FK target. Defaults
      // (is_enabled/is_verified false, events [], encrypted_secret present)
      // match the deny-by-default model.
      const webhook = await db.execute(sql`
        insert into webhooks (workspace_id, created_by_id, url, encrypted_secret, encryption_key_version)
        values (${workspaceId}, ${userId}, ${"https://example.invalid/hook"}, ${"encrypted-blob"}, 1)
        returning id
      `);
      const webhookId = (webhook.rows[0] as { id: string }).id;

      // An invalid status label is not a member of webhook_delivery_status;
      // PostgreSQL rejects it with SQLSTATE 22P02 (invalid_text_representation).
      await expectPostgresErrorCode(
        db.execute(sql`
          insert into webhook_deliveries (webhook_id, event, attempt, status)
          values (${webhookId}, ${"note.created"}, 1, ${"bogus_status"})
        `),
        PG_INVALID_TEXT_REPRESENTATION,
      );

      // A valid status is accepted.
      await db.execute(sql`
        insert into webhook_deliveries (webhook_id, event, attempt, status)
        values (${webhookId}, ${"note.created"}, 1, ${"pending"})
      `);
    } finally {
      await db.execute(sql`delete from workspaces where id = ${workspaceId}`);
      await db.execute(sql`delete from users where id = ${userId}`);
    }
  });

  it("(d) creates the tenant-scoped and unique indexes declared by Part 18", async ({ skip }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    const rows = (
      await db.execute(sql`
        select tablename, indexname, indexdef
        from pg_indexes
        where schemaname = 'public'
          and tablename in (
            'note_embeddings', 'audit_logs', 'api_keys',
            'webhooks', 'webhook_deliveries', 'exports',
            'ai_provider_config', 'ai_usage', 'email_deliveries',
            'job_idempotency', 'job_outbox'
          )
      `)
    ).rows as unknown as ReadonlyArray<{
      tablename: string;
      indexname: string;
      indexdef: string;
    }>;

    const byName = new Map(rows.map((r) => [r.indexname, r]));

    // Unique constraints (Plan Part 18 verify: "key uniqueness").
    expect(byName.get("api_keys_key_hash_unique")?.indexdef).toContain("UNIQUE INDEX");
    expect(byName.get("ai_provider_config_workspace_id_unique")?.indexdef).toContain(
      "UNIQUE INDEX",
    );
    expect(byName.get("job_idempotency_key_unique")?.indexdef).toContain("UNIQUE INDEX");
    expect(byName.get("job_outbox_idempotency_key_unique")?.indexdef).toContain("UNIQUE INDEX");
    expect(byName.get("note_embeddings_note_id_unique")?.indexdef).toContain("UNIQUE INDEX");

    // The HNSW cosine index — the core vector-search access path. Assert both
    // the access method (USING hnsw) and the cosine operator class
    // (vector_cosine_ops) that matches the `<=>` query operator.
    const hnswDef = byName.get("note_embeddings_embedding_idx")?.indexdef ?? "";
    expect(hnswDef).toContain("USING hnsw");
    expect(hnswDef).toContain("vector_cosine_ops");

    // Tenant-scoped lookup indexes exist on the major Part 18 tables
    // (Plan Part 18 verify: "tenant-scoped indexes").
    for (const indexName of [
      "audit_logs_workspace_created_idx",
      "audit_logs_workspace_entity_idx",
      "exports_workspace_created_idx",
      "exports_status_idx",
      "ai_usage_workspace_created_idx",
      "ai_usage_workspace_feature_idx",
      "email_deliveries_workspace_created_idx",
      "webhook_deliveries_webhook_created_idx",
      "webhooks_workspace_id_idx",
      "api_keys_workspace_id_idx",
      "job_outbox_workspace_created_idx",
      "job_outbox_dispatcher_idx",
      "job_outbox_correlation_id_idx",
    ]) {
      expect(byName.has(indexName), `expected index ${indexName}`).toBe(true);
    }

    // The partial object-retention cleanup index on exports.object_expires_at
    // (ADR 0007: completed export objects retained 7 days, then deleted).
    expect(byName.get("exports_object_expires_at_idx")?.indexdef).toContain("WHERE");
    expect(byName.get("exports_object_expires_at_idx")?.indexdef).toContain("object_expires_at");
  });
});
