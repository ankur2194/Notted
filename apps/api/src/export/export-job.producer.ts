// Part 62 — transaction-scoped producer for the `export.generate` intent.
//
// Called from inside `ExportService.create`'s transaction, exactly like
// `NoteSearchIndexProducer.scheduleSearchSync` and
// `MentionNotificationProducer.scheduleMentionNotifications`: ADR 0006 requires
// the durable intent to commit atomically with the `exports` row it describes,
// with dispatch happening only after commit. Recording the intent outside the
// transaction would let a crash between the two leave an `exports` row stuck in
// `queued` forever with nothing scheduled to claim it.
//
// The payload is IDENTIFIER-ONLY (ADR 0006). No format, no options, no source
// content, no object key: the handler claims the row and re-reads every one of
// those from PostgreSQL, so a tampered or replayed payload cannot redirect a
// generation at a different source or widen its scope. `requestedById` travels
// only so the handler can re-authorize that user against the LIVE source; it
// grants nothing by itself, which is why the registry entry declares authority
// "system".

import { createHash, randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { jobOutbox, type JobOutboxPayload } from "../database/schema";
import { DOMAIN_JOB_TYPES } from "../queue/job-identifiers";
import {
  EXPORT_GENERATE_JOB_DEFINITION,
  EXPORT_GENERATE_SOURCE_QUEUE_NAME,
} from "../queue/job-registry";
import { activeWorkspaceId, TenantContextService } from "../tenant";

import type { DatabaseTransaction } from "../database/database.service";

/** Shared prefix for every export idempotency key, for operator legibility. */
export const EXPORT_GENERATE_IDEMPOTENCY_PREFIX = "export-generate:";

/**
 * The export id IS the identity. Every create mints a fresh uuid for a fresh
 * row, so this key is naturally exactly-once without hashing anything: two
 * intents can only collide when the SAME row is scheduled twice (a retried
 * transaction), which is precisely the case `onConflictDoNothing` must swallow.
 * API-level idempotency replay is handled a layer up by
 * `api_idempotency_records`, so a repeated request never reaches this at all.
 */
export function exportGenerateIdempotencyKey(exportId: string): string {
  return `${EXPORT_GENERATE_IDEMPOTENCY_PREFIX}${exportId}`;
}

/** Identifier-only payload; it carries a requester, so it has its own schema. */
type ExportGeneratePayload = JobOutboxPayload & {
  readonly workspaceId: string;
  readonly exportId: string;
  readonly requestedById: string;
};

export interface ScheduleExportGenerationInput {
  readonly workspaceId: string;
  readonly exportId: string;
  readonly requestedById: string;
  readonly correlationId?: string | null;
}

@Injectable()
export class ExportJobProducer {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * Schedule the single `export.generate` intent for one `exports` row inside
   * `tx`. The caller MUST pass the transaction that inserted the row.
   */
  async scheduleExportGeneration(
    tx: DatabaseTransaction,
    input: ScheduleExportGenerationInput,
  ): Promise<void> {
    const intentId = randomUUID();
    const payload: ExportGeneratePayload = Object.freeze({
      action: DOMAIN_JOB_TYPES.generateExport,
      intentId,
      workspaceId: input.workspaceId,
      exportId: input.exportId,
      requestedById: input.requestedById,
    });
    await tx
      .insert(jobOutbox)
      .values({
        id: intentId,
        // Read from the active tenant context, not from the argument: the
        // caller has already proved the two agree, and taking it from here
        // keeps the outbox row scoped by the server-side value.
        workspaceId: activeWorkspaceId(this.tenantContext),
        queueName: EXPORT_GENERATE_SOURCE_QUEUE_NAME,
        jobType: DOMAIN_JOB_TYPES.generateExport,
        payloadVersion: EXPORT_GENERATE_JOB_DEFINITION.payloadVersion,
        payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        idempotencyKey: exportGenerateIdempotencyKey(input.exportId),
        correlationId: input.correlationId ?? null,
      })
      // The globally unique idempotency index turns a retried transaction into
      // a silent no-op instead of aborting the export creation.
      .onConflictDoNothing();
  }
}
