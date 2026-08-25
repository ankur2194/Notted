// Part 71 — the single writer for `audit_logs`.
//
// WHY A PURE FUNCTION AND NOT AN INJECTED SERVICE. Thirteen services already
// own a private audit writer, each inside its own transaction. Turning that into
// a provider would add a constructor argument to thirteen classes and a stub to
// every one of their unit suites, to gain nothing a module-scoped function does
// not already give: one place that decides what an audit row contains. The
// function takes the caller's `tx` (or `database.db`) so the row still commits
// with the mutation it describes — ADR 0006, unchanged.
//
// WHAT THIS FUNCTION ADDS over the thirteen hand-rolled inserts it replaces:
//   1. the request facts (`ip_address`, `user_agent`) that no writer recorded,
//      read from the request AsyncLocalStorage rather than threaded through
//      thirteen service signatures;
//   2. `request_id` falling back to the ambient request when a caller has none;
//   3. metadata redaction, so a future caller cannot put a credential in an
//      audit row that is exportable to every workspace admin.

import { sql } from "drizzle-orm";

import { getRequestContext } from "../common/request/request-context";
import { auditLogs } from "../database/schema";

import type { DatabaseTransaction } from "../database/database.service";

/**
 * Anything that can insert. `Database` and `DatabaseTransaction` are both
 * `PgDatabase` subtypes over the same schema and the same query-result kind, so
 * one structural parameter serves a transactional writer and the handful of
 * callers that legitimately audit outside one (`storage-maintenance`, the
 * export download).
 */
export type AuditWriter = Pick<DatabaseTransaction, "insert">;

/** Anything that can run a statement — narrower than a whole transaction. */
export type AuditSessionRunner = Pick<DatabaseTransaction, "execute">;

export interface AuditEvent {
  readonly workspaceId: string;
  /** `null` only for a system actor; `audit_logs.user_id` is SET NULL, not NOT NULL. */
  readonly userId: string | null;
  /** `<entity>.<verb>`, lowercase — the convention every existing action follows. */
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  /** Identifiers and cheap facts only. Redacted before it reaches the column. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Explicit correlation id; falls back to the ambient request's. */
  readonly requestId?: string | null;
}

export const AUDIT_REDACTED = "[redacted]" as const;
export const AUDIT_TRUNCATED = "[truncated]" as const;
/** Nesting past this is replaced wholesale — an audit row is facts, not a tree. */
export const AUDIT_METADATA_MAX_DEPTH = 4;

/**
 * EXACT key names that never belong in an audit row, matched case-insensitively.
 *
 * Deliberately exact rather than substring: `keyPrefix` (api-keys),
 * `encryptionKeyVersion` (webhooks), `contentConsent` (AI) and `credentialChanged`
 * (AI) are all existing, deliberate, non-secret metadata keys that a substring
 * rule on "key", "content" or "credential" would silently blank.
 */
const DENIED_KEYS: ReadonlySet<string> = new Set([
  "apikey",
  "api_key",
  "authorization",
  "ciphertext",
  "content",
  "cookie",
  "credential",
  "credentials",
  "href",
  "keyhash",
  "key_hash",
  "password",
  "passphrase",
  "secret",
  "signature",
  "token",
  "url",
]);

/**
 * Suffix rule for the compound names the exact list cannot enumerate —
 * `webhookSecret`, `resetToken`, `downloadUrl`, `payloadHash`. Checked against
 * the lowercased key, so `signedUrl` and `signed_url` are both caught.
 *
 * VERIFIED against every key the thirteen existing writers pass: `keyPrefix`,
 * `scopes`, `host`, `events`, `isEnabled`, `isVerified`, `encryptionKeyVersion`,
 * `eventId`, `deliveryId`, `fields`, `from`, `to`, `role`, `status`,
 * `invitationId`, `replacedInvitationId`, `provider`, `model`,
 * `dailyTokenQuota`, `rateLimitPerMinute`, `contentConsent`,
 * `credentialChanged`, `dryRun`, `sweeps`. None of them ends in a denied word.
 */
const DENIED_KEY_SUFFIX = /(token|secret|password|passphrase|url|hash)$/u;

function isDeniedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return DENIED_KEYS.has(lower) || DENIED_KEY_SUFFIX.test(lower);
}

function redactValue(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) {
    if (depth >= AUDIT_METADATA_MAX_DEPTH) return AUDIT_TRUNCATED;
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    if (depth >= AUDIT_METADATA_MAX_DEPTH) return AUDIT_TRUNCATED;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) =>
        isDeniedKey(key) ? [key, AUDIT_REDACTED] : [key, redactValue(item, depth + 1)],
      ),
    );
  }
  // `undefined` is not JSON; jsonb would drop it silently, so it is made explicit.
  return value === undefined ? null : value;
}

/**
 * Blank credential-shaped keys anywhere in the metadata tree and flatten
 * anything nested deeper than {@link AUDIT_METADATA_MAX_DEPTH}.
 *
 * This is a BACKSTOP, not the primary control. The primary control is that
 * every caller passes identifiers and cheap facts by construction; this exists
 * so a future caller cannot make an exportable, long-lived, widely-readable row
 * carry a credential by accident. Returns a fresh object — callers pass frozen
 * literals.
 */
export function redactAuditMetadata(
  metadata: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return redactValue(metadata, 0) as Record<string, unknown>;
}

/**
 * Append one audit row on `db`, in whatever transaction the caller is already
 * running. Never throws for a missing request context: a queue handler, a
 * scheduler and a CLI seed all legitimately audit with no client to record.
 */
export async function recordAudit(db: AuditWriter, event: AuditEvent): Promise<void> {
  const request = getRequestContext();
  await db.insert(auditLogs).values({
    workspaceId: event.workspaceId,
    userId: event.userId,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    metadata: redactAuditMetadata(event.metadata ?? {}),
    ipAddress: request?.ipAddress ?? null,
    userAgent: request?.userAgent ?? null,
    // An explicit id wins: a caller that carries one through a job boundary
    // knows the correlation better than the ambient request does.
    requestId: event.requestId ?? request?.requestId ?? null,
  });
}

/**
 * Open the ONE hole in the append-only trigger installed by migration
 * `0021_audit_logs_append_only`: a DELETE is refused unless
 * `notted.audit_purge` is `on` for the current transaction.
 *
 * `set_config(..., true)` is TRANSACTION-LOCAL — it reverts on commit or
 * rollback — so the permission cannot outlive the statement that needed it and
 * cannot leak onto a pooled connection. Call it inside the same transaction as
 * the delete; outside one it is a no-op that grants nothing.
 *
 * The only production caller is the retention purge. Test fixtures that clean up
 * their own audit rows use it too, which is the point: the trigger is real for
 * them as well, so a test cannot pass against a table the production code could
 * not have written to.
 */
export async function allowAuditDelete(tx: AuditSessionRunner): Promise<void> {
  await tx.execute(sql`select set_config('notted.audit_purge', 'on', true)`);
}
