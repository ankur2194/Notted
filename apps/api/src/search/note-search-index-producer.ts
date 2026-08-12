// Part 51.3 — transaction-scoped producer for the `note.search.sync` intent.
//
// ADR 0006 requires that durable side-effect intents are recorded in the SAME
// PostgreSQL transaction as the business mutation that produced them, and that
// dispatch happens only after commit via the shared outbox dispatcher. This
// producer is the narrow, focused entry point every note-affecting service
// (Notes/Tags/Attachments/Projects) calls from inside its transaction to
// schedule a Meilisearch re-sync of one or more notes.
//
// Responsibilities held here, deliberately ONCE:
//
// 1. WORKSPACE VALIDATION. Each call must prove the supplied `workspaceId` is
//    the active server-side tenant workspace (Part 19). This prevents a future
//    caller from substituting a client-supplied workspace id. The helper fails
//    closed via `assertActiveWorkspace`, which throws the typed tenant-mismatch
//    error on a divergence.
//
// 2. PAYLOAD CONTRACT. The payload is identifier-only and matches the Part 51.2
//    `platformIdentifierPayloadSchema("note.search.sync")`: action, intentId,
//    workspaceId, resourceIds (1..8), optional actorId. Never note content,
//    titles, tag names, or attachment bytes — those remain in PostgreSQL and
//    are re-read by the handler.
//
// 3. CHUNKING. The schema caps `resourceIds` at 8 per intent. Mutations that
//    affect more than 8 notes (subtree move/delete, project delete, folder
//    delete, tag rename/delete fan-out) MUST be split across multiple outbox
//    rows. This producer chunks deterministically and inserts one row per
//    chunk, each with its own fresh intentId.
//
// 4. IDEMPOTENCY KEYS. Keys are a SHA-256 digest of workspace, mutation
//    discriminator, and the row's outbox intent UUID. They are deterministic
//    for that mutation intent while fresh intent UUIDs ensure later legitimate
//    edits of the same notes are never suppressed by the unique index.
//
// 5. PAYLOAD HASH. Uses the existing `createHash("sha256")` pattern shared by
//    every other producer so dispatcher replay validation sees a consistent
//    envelope shape.
//
// This producer never reads `notes`, `tags`, `attachments`, or any tenant-owned
// row: callers capture affected IDs BEFORE destructive cascades and pass them
// in. That is the rule that makes descendant/cascade fan-out safe — once a
// cascade has removed the rows we can no longer enumerate them, so the service
// is responsible for capturing them upstream of the delete and handing them
// here.
//
// Search intents are ADDITIONAL outbox rows in the same transaction. Every
// existing `note-domain-events`/`tag-domain-events`/`attachment-domain-events`/
// `project-domain-events` row is preserved unchanged for future consumers; the
// `note.search.sync` intent is a parallel concern that re-derives the index
// from authoritative PostgreSQL state.

import { createHash, randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { jobOutbox, type JobOutboxPayload } from "../database/schema";
import { DOMAIN_JOB_TYPES } from "../queue/job-identifiers";
import {
  NOTE_SEARCH_SYNC_JOB_DEFINITION,
  NOTE_SEARCH_SYNC_SOURCE_QUEUE_NAME,
} from "../queue/job-registry";
import { activeWorkspaceId, assertActiveWorkspace, TenantContextService } from "../tenant";

import type { DatabaseTransaction } from "../database/database.service";

/** Maximum number of note IDs carried in a single sync intent (schema cap). */
export const NOTE_SEARCH_SYNC_BATCH_SIZE = 8;

/**
 * Mutation identity and optional metadata attached to a sync schedule. The
 * correlation id flows from the inbound request id; the actor id is the user
 * whose mutation triggered the sync. Both are persisted on the outbox row for
 * operator traceability.
 */
export interface NoteSearchIndexProducerOptions {
  /** Domain event/mutation that caused this independent search intent. */
  readonly mutation: string;
  readonly correlationId?: string | null;
  readonly actorId?: string;
}

@Injectable()
export class NoteSearchIndexProducer {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * Schedule one or more `note.search.sync` intents inside `tx`. The caller
   * MUST pass the transaction it is using for its business mutation so the
   * intent commits atomically with that mutation; recording outside the
   * transaction would let a crash between commit and intent leave the index
   * permanently divergent until the Part 51.4 reindex command is run.
   *
   * `workspaceId` is the workspace the notes belong to. It is validated
   * against the active server-side tenant context before any SQL is issued.
   *
   * `noteIds` is the full set of notes the handler must re-read. Empty lists
   * are a no-op (a defensive convenience for call sites that fan out from a
   * subtree or join result that may legitimately be empty); they never
   * produce an outbox row.
   *
   * Lists longer than 8 IDs are chunked into multiple outbox rows, each
   * carrying at most 8 deduplicated IDs and its own fresh intentId. The chunk
   * order preserves first-seen caller order so operator queries are predictable.
   */
  async scheduleSearchSync(
    tx: DatabaseTransaction,
    workspaceId: string,
    noteIds: readonly string[],
    options: NoteSearchIndexProducerOptions,
  ): Promise<void> {
    if (noteIds.length === 0) return;
    // Validate tenant scope BEFORE issuing any SQL. This is the same primitive
    // every tenant-owned write uses; a mismatch throws the typed
    // `tenant.workspace_mismatch` error.
    assertActiveWorkspace(workspaceId, this.tenantContext, "note.search.sync");

    const chunks = chunkNoteIds(noteIds);
    for (const chunk of chunks) {
      const intentId = randomUUID();
      const payload: JobOutboxPayload = Object.freeze({
        action: DOMAIN_JOB_TYPES.noteSearchSync,
        intentId,
        workspaceId,
        resourceIds: Object.freeze([...chunk]),
        ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
      });
      const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      // Deterministic for this mutation's outbox intent, but collision-safe for
      // later legitimate edits of the same note: every row has a fresh UUID,
      // while the discriminator prevents different mutation classes from
      // sharing an identity namespace.
      const idempotencyIdentity = JSON.stringify({
        workspaceId,
        mutation: options.mutation,
        intentId,
      });
      const idempotencyKey = `${NOTE_SEARCH_SYNC_IDEMPOTENCY_PREFIX}${createHash("sha256")
        .update(idempotencyIdentity)
        .digest("hex")}`;
      await tx.insert(jobOutbox).values({
        id: intentId,
        workspaceId: activeWorkspaceId(this.tenantContext),
        queueName: NOTE_SEARCH_SYNC_SOURCE_QUEUE_NAME,
        jobType: DOMAIN_JOB_TYPES.noteSearchSync,
        payloadVersion: NOTE_SEARCH_SYNC_JOB_DEFINITION.payloadVersion,
        payload,
        payloadHash,
        idempotencyKey,
        correlationId: options.correlationId ?? null,
      });
    }
  }
}

/** Shared prefix for every search-sync idempotency key, for legibility only. */
export const NOTE_SEARCH_SYNC_IDEMPOTENCY_PREFIX = "note-search-sync:";

/**
 * Pure helper that splits a note-id list into chunks of at most
 * {@link NOTE_SEARCH_SYNC_BATCH_SIZE}. Exported for unit testing of the
 * chunking contract without going through the database.
 */
export function chunkNoteIds(noteIds: readonly string[]): readonly (readonly string[])[] {
  const uniqueIds = [...new Set(noteIds)];
  const chunks: string[][] = [];
  for (let offset = 0; offset < uniqueIds.length; offset += NOTE_SEARCH_SYNC_BATCH_SIZE) {
    chunks.push(uniqueIds.slice(offset, offset + NOTE_SEARCH_SYNC_BATCH_SIZE));
  }
  return chunks;
}
