// Part 51.2 — concrete queue handlers for the rebuildable note search index.
//
// Two handlers register through `QueueHandlerRegistry` during module init:
//
// 1. `NoteIndexJobHandler` — owns the new `note.search.sync` domain job type.
//    It receives note IDs + workspaceId, re-reads authoritative PostgreSQL
//    state under tenant scope, UPSERTS live (non-deleted) projections, and
//    DELETES Meilisearch documents for IDs that are absent or soft-deleted.
//    Re-reading authoritative state on every event makes out-of-order
//    create/update/delete/restore deliveries converge to the current truth.
//
// 2. `WorkspaceSearchPurgeJobHandler` — owns dedicated `workspace.search.purge`
//    domain job type for the search index concern, deleting all indexed
//    documents for the workspace via a Meilisearch filter.
//
// Tenant scope: `NoteIndexJobHandler` establishes the active tenant context
// directly via `tenantContext.run(...)` and relies on
// `NoteProjectionRepository`'s `whereWorkspace` enforcement (consistent with
// the system-owned `StorageMaintenanceQueueHandler`). A `note.read`
// authorization decision is not required: the search projection is a
// rebuildable system artifact of data the platform already owns, and the
// projection query re-proves each note's workspace membership. Establishing
// the context directly (rather than via `authorizeSystem`) also avoids the
// denial ambiguity for a missing workspace — the tenant-scoped query simply
// returns zero rows and the handler deletes the stale documents, which is the
// convergent outcome.
//
// Disabled Meilisearch: when `FEATURE_SEARCH_ENABLED=false`, both handlers
// return successfully WITHOUT indexing. The index is rebuildable (Part 51.4),
// and failing the durable intent would poison `job_outbox` with unprocessable
// rows that retry forever. This is the documented safe option chosen over
// fail-closed.
//
// Handlers MUST NOT update `job_outbox` or `job_idempotency`; the generic
// worker (Part 50) owns that lifecycle. Handlers throw on failure; permanent
// business failures use `PermanentQueueJobError`.

import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { MeilisearchService } from "../infrastructure/meilisearch/meilisearch.service";
import { defineQueueJobRegistration, type QueueJobContext } from "../queue/job-contracts";
import {
  NOTE_SEARCH_SYNC_JOB_DEFINITION,
  WORKSPACE_SEARCH_PURGE_JOB_DEFINITION,
} from "../queue/job-registry";
import { PermanentQueueJobError } from "../queue/queue-errors";
import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";
import { createTenantContext, TenantContextService } from "../tenant";

import { NoteIndexRepository } from "./note-index.repository";
import { NoteProjectionRepository } from "./note-projection.repository";

import type { z } from "zod";

type NoteSearchSyncContext = QueueJobContext<
  typeof NOTE_SEARCH_SYNC_JOB_DEFINITION.jobType,
  z.output<typeof NOTE_SEARCH_SYNC_JOB_DEFINITION.payloadSchema>
>;

type WorkspaceSearchPurgeContext = QueueJobContext<
  typeof WORKSPACE_SEARCH_PURGE_JOB_DEFINITION.jobType,
  z.output<typeof WORKSPACE_SEARCH_PURGE_JOB_DEFINITION.payloadSchema>
>;

/**
 * Idempotent `note.search.sync` consumer. Re-reads authoritative PostgreSQL
 * for each requested note ID under the payload's workspace scope and UPSERTS
 * or DELETES the corresponding Meilisearch document so the index converges to
 * current truth regardless of event ordering or duplication.
 */
@Injectable()
export class NoteIndexJobHandler implements OnModuleInit, OnModuleDestroy {
  readonly jobType = NOTE_SEARCH_SYNC_JOB_DEFINITION.jobType;
  private unregister?: () => void;

  constructor(
    private readonly projection: NoteProjectionRepository,
    private readonly noteIndex: NoteIndexRepository,
    private readonly meilisearch: MeilisearchService,
    private readonly tenantContext: TenantContextService,
    private readonly logger: StructuredLogger,
    private readonly registry: QueueHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.unregister = this.registry.register(
      defineQueueJobRegistration({ definition: NOTE_SEARCH_SYNC_JOB_DEFINITION, handler: this }),
    );
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async handle(context: NoteSearchSyncContext): Promise<void> {
    if (context.payload.intentId !== context.outboxIntentId) {
      throw new PermanentQueueJobError("payload_invalid");
    }
    if (!this.meilisearch.isEnabled()) {
      // Disabled search is an operator state, not a handler failure. Succeed
      // without indexing; Part 51.4 reindex rebuilds when search re-enables.
      return;
    }

    const noteIds = context.payload.resourceIds;
    const workspaceId = context.payload.workspaceId;

    // Establish tenant scope for the projection read. The payload workspaceId
    // is proven by the producer's transactional outbox row; the projection
    // query re-proves each note's membership via whereWorkspace. A missing
    // workspace yields zero rows, so all requested IDs are deleted from the
    // index — the convergent outcome after a workspace deletion.
    await this.tenantContext.run(
      createTenantContext({
        workspaceId,
        userId: null,
        requestId: context.correlationId,
      }),
      async () => {
        const documents = await this.projection.loadDocumentsForNoteIds(noteIds);
        const loadedIds = new Set(documents.map((doc) => doc.id));
        const toDelete = noteIds.filter((id) => !loadedIds.has(id));

        if (documents.length > 0) {
          await this.noteIndex.updateDocuments([...documents]);
        }
        if (toDelete.length > 0) {
          // A tampered payload must never delete another tenant's globally
          // addressed document. Both workspace and IDs are constrained at the
          // provider boundary.
          await this.noteIndex.deleteWorkspaceDocumentsByIds(workspaceId, toDelete);
        }
        this.logger.info(
          {
            workspaceId,
            jobType: this.jobType,
            outcome: "synced",
            upserted: documents.length,
            deleted: toDelete.length,
          },
          "Note search index sync completed",
        );
      },
    );
  }
}

/**
 * Dedicated `workspace.search.purge` consumer. Deletes ALL
 * indexed documents for the workspace via a Meilisearch `workspaceId` filter.
 * No tenant-scoped PostgreSQL read is needed: the workspace row is already
 * gone by the time this runs, and `deleteWorkspaceDocuments` is an idempotent
 * filter-based delete.
 *
 * The generic `workspace.deleted` concern remains unclaimed by search;
 * workspace deletion commits both durable intents in the same transaction.
 */
@Injectable()
export class WorkspaceSearchPurgeJobHandler implements OnModuleInit, OnModuleDestroy {
  readonly jobType = WORKSPACE_SEARCH_PURGE_JOB_DEFINITION.jobType;
  private unregister?: () => void;

  constructor(
    private readonly noteIndex: NoteIndexRepository,
    private readonly meilisearch: MeilisearchService,
    private readonly logger: StructuredLogger,
    private readonly registry: QueueHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.unregister = this.registry.register(
      defineQueueJobRegistration({
        definition: WORKSPACE_SEARCH_PURGE_JOB_DEFINITION,
        handler: this,
      }),
    );
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async handle(context: WorkspaceSearchPurgeContext): Promise<void> {
    if (context.payload.intentId !== context.outboxIntentId) {
      throw new PermanentQueueJobError("payload_invalid");
    }
    if (!this.meilisearch.isEnabled()) {
      // Same disabled-search policy as NoteIndexJobHandler: do not poison the
      // durable cleanup intent while search is intentionally disabled.
      return;
    }
    await this.noteIndex.deleteWorkspaceDocuments(context.payload.workspaceId);
    this.logger.info(
      {
        workspaceId: context.payload.workspaceId,
        jobType: this.jobType,
        outcome: "purged",
      },
      "Workspace search index purge completed",
    );
  }
}
