import { describe, expect, it, vi } from "vitest";

import { DOMAIN_JOB_TYPES } from "../queue/job-identifiers";
import { NOTE_SEARCH_SYNC_JOB_DEFINITION } from "../queue/job-registry";
import { PermanentQueueJobError } from "../queue/queue-errors";
import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";
import { TenantContextService } from "../tenant";

import {
  NoteIndexJobHandler,
  WorkspaceSearchPurgeJobHandler,
} from "./note-index-job-handler.service";

import type { NoteIndexRepository } from "./note-index.repository";
import type { NoteProjectionRepository } from "./note-projection.repository";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { MeilisearchService } from "../infrastructure/meilisearch/meilisearch.service";

const WORKSPACE_ID = "11111111-0000-4000-8000-000000000001";
const OUTBOX_INTENT_ID = "22222222-0000-4000-8000-000000000002";
const NOTE_A = "aaaaaaaa-0000-4000-8000-000000000001";
const NOTE_B = "bbbbbbbb-0000-4000-8000-000000000002";
const NOTE_C = "cccccccc-0000-4000-8000-000000000003";
const AUTHOR_ID = "33333333-0000-4000-8000-000000000004";

function baseDocument(id: string) {
  return {
    id,
    title: `Title ${id}`,
    content: "body",
    tags: ["tag"] as readonly string[],
    workspaceId: WORKSPACE_ID,
    projectId: null,
    authorId: AUTHOR_ID,
    createdAt: 1_786_406_400_000,
    updatedAt: 1_786_406_400_000,
    hasAttachments: false,
  };
}

function syncContext(
  overrides: Partial<{
    outboxIntentId: string;
    payloadIntentId: string;
    workspaceId: string;
    resourceIds: readonly string[];
    actorId?: string;
    correlationId?: string;
  }> = {},
) {
  return {
    outboxIntentId: overrides.outboxIntentId ?? OUTBOX_INTENT_ID,
    // The processor always supplies these; the handler reads them to tell a
    // retryable attempt from the final one.
    attempt: 1,
    maximumAttempts: 3,
    jobType: DOMAIN_JOB_TYPES.noteSearchSync,
    idempotencyKey: "note-search-sync:test",
    signal: new AbortController().signal,
    correlationId: overrides.correlationId,
    payload: {
      action: DOMAIN_JOB_TYPES.noteSearchSync,
      intentId: overrides.payloadIntentId ?? overrides.outboxIntentId ?? OUTBOX_INTENT_ID,
      workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
      resourceIds: overrides.resourceIds ?? [NOTE_A],
      ...(overrides.actorId !== undefined ? { actorId: overrides.actorId } : {}),
    },
  };
}

function purgeContext(
  overrides: Partial<{
    outboxIntentId: string;
    payloadIntentId: string;
    workspaceId: string;
    resourceIds: readonly string[];
  }> = {},
) {
  return {
    outboxIntentId: overrides.outboxIntentId ?? OUTBOX_INTENT_ID,
    // The processor always supplies these; the handler reads them to tell a
    // retryable attempt from the final one.
    attempt: 1,
    maximumAttempts: 3,
    jobType: DOMAIN_JOB_TYPES.workspaceSearchPurge,
    idempotencyKey: "workspace-search-purge:test",
    signal: new AbortController().signal,
    payload: {
      action: DOMAIN_JOB_TYPES.workspaceSearchPurge,
      intentId: overrides.payloadIntentId ?? overrides.outboxIntentId ?? OUTBOX_INTENT_ID,
      workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
      resourceIds: overrides.resourceIds ?? [WORKSPACE_ID],
    },
  };
}

function buildSyncHandler(
  overrides: {
    readonly documents?: readonly ReturnType<typeof baseDocument>[];
    readonly meilisearchEnabled?: boolean;
    readonly projection?: Partial<NoteProjectionRepository>;
    readonly noteIndex?: Partial<NoteIndexRepository>;
  } = {},
) {
  const tenantContext = new TenantContextService();
  const documents = overrides.documents ?? [];
  const projection = {
    loadDocumentsForNoteIds: vi.fn(async () => documents),
    ...overrides.projection,
  } as unknown as NoteProjectionRepository;
  const noteIndex = {
    updateDocuments: vi.fn().mockResolvedValue(undefined),
    deleteDocuments: vi.fn().mockResolvedValue(undefined),
    deleteWorkspaceDocumentsByIds: vi.fn().mockResolvedValue(undefined),
    deleteWorkspaceDocuments: vi.fn().mockResolvedValue(undefined),
    ...overrides.noteIndex,
  } as unknown as NoteIndexRepository;
  const meilisearch = {
    isEnabled: () => overrides.meilisearchEnabled ?? true,
  } as unknown as MeilisearchService;
  const logger = { info: vi.fn(), failure: vi.fn() } as unknown as StructuredLogger;
  const registry = new QueueHandlerRegistry();
  const handler = new NoteIndexJobHandler(
    projection,
    noteIndex,
    meilisearch,
    tenantContext,
    logger,
    registry,
  );
  return { handler, projection, noteIndex, meilisearch, logger, registry, tenantContext };
}

function buildPurgeHandler(
  overrides: {
    readonly meilisearchEnabled?: boolean;
    readonly noteIndex?: Partial<NoteIndexRepository>;
  } = {},
) {
  const noteIndex = {
    deleteWorkspaceDocuments: vi.fn().mockResolvedValue(undefined),
    ...overrides.noteIndex,
  } as unknown as NoteIndexRepository;
  const meilisearch = {
    isEnabled: () => overrides.meilisearchEnabled ?? true,
  } as unknown as MeilisearchService;
  const logger = { info: vi.fn(), failure: vi.fn() } as unknown as StructuredLogger;
  const registry = new QueueHandlerRegistry();
  const handler = new WorkspaceSearchPurgeJobHandler(noteIndex, meilisearch, logger, registry);
  return { handler, noteIndex, meilisearch, logger, registry };
}

describe("NoteIndexJobHandler", () => {
  it("registers for the note.search.sync job type on module init", () => {
    const subject = buildSyncHandler();
    subject.handler.onModuleInit();
    const binding = subject.registry.lookup(DOMAIN_JOB_TYPES.noteSearchSync);
    expect(binding?.handler).toBe(subject.handler);
    expect(binding?.definition.route.physicalQueueName).toBe("notted-default");
    expect(binding?.definition.route.sourceQueueNames).toEqual(["note-search-sync"]);
    subject.handler.onModuleDestroy();
    expect(subject.registry.lookup(DOMAIN_JOB_TYPES.noteSearchSync)).toBeUndefined();
  });

  it("rejects a payload whose intentId differs from the outbox intent", async () => {
    const subject = buildSyncHandler();
    await expect(
      subject.handler.handle(
        syncContext({
          outboxIntentId: OUTBOX_INTENT_ID,
          payloadIntentId: "99999999-0000-4000-8000-000000000009",
        }),
      ),
    ).rejects.toBeInstanceOf(PermanentQueueJobError);
    expect(subject.projection.loadDocumentsForNoteIds).not.toHaveBeenCalled();
  });

  it("succeeds without indexing when Meilisearch is disabled", async () => {
    const subject = buildSyncHandler({ meilisearchEnabled: false });
    await expect(subject.handler.handle(syncContext())).resolves.toBeUndefined();
    expect(subject.projection.loadDocumentsForNoteIds).not.toHaveBeenCalled();
    expect(subject.noteIndex.updateDocuments).not.toHaveBeenCalled();
    expect(subject.noteIndex.deleteDocuments).not.toHaveBeenCalled();
  });

  it("upserts live documents and deletes absent/soft-deleted IDs (convergence)", async () => {
    // NOTE_A and NOTE_B exist; NOTE_C is absent (soft-deleted or missing).
    const subject = buildSyncHandler({
      documents: [baseDocument(NOTE_A), baseDocument(NOTE_B)],
    });
    subject.handler.onModuleInit();

    await subject.handler.handle(syncContext({ resourceIds: [NOTE_A, NOTE_B, NOTE_C] }));

    expect(subject.projection.loadDocumentsForNoteIds).toHaveBeenCalledWith([
      NOTE_A,
      NOTE_B,
      NOTE_C,
    ]);
    expect(subject.noteIndex.updateDocuments).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: NOTE_A }),
        expect.objectContaining({ id: NOTE_B }),
      ]),
    );
    expect(subject.noteIndex.deleteWorkspaceDocumentsByIds).toHaveBeenCalledWith(WORKSPACE_ID, [
      NOTE_C,
    ]);
    expect(subject.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "synced", upserted: 2, deleted: 1 }),
      expect.any(String),
    );
  });

  it("skips the upsert call entirely when every requested ID is absent", async () => {
    const subject = buildSyncHandler({ documents: [] });
    subject.handler.onModuleInit();

    await subject.handler.handle(syncContext({ resourceIds: [NOTE_C] }));

    expect(subject.noteIndex.updateDocuments).not.toHaveBeenCalled();
    expect(subject.noteIndex.deleteWorkspaceDocumentsByIds).toHaveBeenCalledWith(WORKSPACE_ID, [
      NOTE_C,
    ]);
  });

  it("skips the delete call when every requested ID is live", async () => {
    const subject = buildSyncHandler({ documents: [baseDocument(NOTE_A)] });
    subject.handler.onModuleInit();

    await subject.handler.handle(syncContext({ resourceIds: [NOTE_A] }));

    expect(subject.noteIndex.updateDocuments).toHaveBeenCalledWith([
      expect.objectContaining({ id: NOTE_A }),
    ]);
    expect(subject.noteIndex.deleteDocuments).not.toHaveBeenCalled();
  });

  it("establishes tenant scope under the payload workspace before reading", async () => {
    const seenContexts: string[] = [];
    const tenantContext = new TenantContextService();
    const projection = {
      loadDocumentsForNoteIds: vi.fn(async () => {
        // Inside the projection call, the active context must match the payload
        // workspace. If no context is active, this throws.
        seenContexts.push(tenantContext.get().workspaceId);
        return [];
      }),
    } as unknown as NoteProjectionRepository;
    const handler = new NoteIndexJobHandler(
      projection,
      {
        updateDocuments: vi.fn(),
        deleteWorkspaceDocumentsByIds: vi.fn(),
      } as unknown as NoteIndexRepository,
      { isEnabled: () => true } as unknown as MeilisearchService,
      tenantContext,
      { info: vi.fn(), failure: vi.fn() } as unknown as StructuredLogger,
      new QueueHandlerRegistry(),
    );

    await handler.handle(syncContext({ workspaceId: WORKSPACE_ID, resourceIds: [NOTE_A] }));

    expect(seenContexts).toEqual([WORKSPACE_ID]);
  });

  it("makes duplicate and out-of-order deliveries converge to authoritative state", async () => {
    // Simulate a restore after a delete: the authoritative projection for
    // NOTE_A exists again. A previous delivery may have deleted it; this
    // delivery re-upserts it.
    const subject = buildSyncHandler({ documents: [baseDocument(NOTE_A)] });
    subject.handler.onModuleInit();

    // First delivery: NOTE_A is live -> upsert.
    await subject.handler.handle(syncContext({ resourceIds: [NOTE_A] }));
    expect(subject.noteIndex.updateDocuments).toHaveBeenCalledTimes(1);
    expect(subject.noteIndex.deleteDocuments).not.toHaveBeenCalled();

    // Second delivery (duplicate): same authoritative state -> upsert again.
    await subject.handler.handle(syncContext({ resourceIds: [NOTE_A] }));
    expect(subject.noteIndex.updateDocuments).toHaveBeenCalledTimes(2);
    expect(subject.noteIndex.deleteDocuments).not.toHaveBeenCalled();

    // Third delivery models an out-of-order delete that arrived after a
    // restore: the authoritative read finds NOTE_A absent, so it deletes.
    subject.projection.loadDocumentsForNoteIds = vi.fn(async () => []);
    await subject.handler.handle(syncContext({ resourceIds: [NOTE_A] }));
    expect(subject.noteIndex.deleteWorkspaceDocumentsByIds).toHaveBeenCalledWith(WORKSPACE_ID, [
      NOTE_A,
    ]);
  });

  it("handles a missing workspace safely by deleting the stale documents", async () => {
    // When the workspace is gone, the tenant-scoped projection returns zero
    // rows; the handler treats all requested IDs as "delete from index".
    const subject = buildSyncHandler({ documents: [] });
    subject.handler.onModuleInit();

    await expect(
      subject.handler.handle(syncContext({ workspaceId: WORKSPACE_ID, resourceIds: [NOTE_A] })),
    ).resolves.toBeUndefined();
    expect(subject.noteIndex.deleteWorkspaceDocumentsByIds).toHaveBeenCalledWith(WORKSPACE_ID, [
      NOTE_A,
    ]);
    expect(subject.noteIndex.updateDocuments).not.toHaveBeenCalled();
  });

  it("forwards the correlation id into the tenant context", async () => {
    const tenantContext = new TenantContextService();
    let capturedRequestId: string | null | undefined = undefined;
    const projection = {
      loadDocumentsForNoteIds: vi.fn(async () => {
        capturedRequestId = tenantContext.get().requestId;
        return [];
      }),
    } as unknown as NoteProjectionRepository;
    const handler = new NoteIndexJobHandler(
      projection,
      {
        updateDocuments: vi.fn(),
        deleteWorkspaceDocumentsByIds: vi.fn(),
      } as unknown as NoteIndexRepository,
      { isEnabled: () => true } as unknown as MeilisearchService,
      tenantContext,
      { info: vi.fn(), failure: vi.fn() } as unknown as StructuredLogger,
      new QueueHandlerRegistry(),
    );

    await handler.handle(syncContext({ correlationId: "55555555-0000-4000-8000-000000000005" }));

    expect(capturedRequestId).toBe("55555555-0000-4000-8000-000000000005");
  });
});

describe("WorkspaceSearchPurgeJobHandler", () => {
  it("registers for the dedicated workspace.search.purge job type on module init", () => {
    const subject = buildPurgeHandler();
    subject.handler.onModuleInit();
    const binding = subject.registry.lookup(DOMAIN_JOB_TYPES.workspaceSearchPurge);
    expect(binding?.handler).toBe(subject.handler);
    expect(binding?.definition.route.physicalQueueName).toBe("notted-maintenance");
    expect(binding?.definition.route.sourceQueueNames).toEqual(["workspace-search-purge"]);
    subject.handler.onModuleDestroy();
    expect(subject.registry.lookup(DOMAIN_JOB_TYPES.workspaceSearchPurge)).toBeUndefined();
  });

  it("rejects a payload whose intentId differs from the outbox intent", async () => {
    const subject = buildPurgeHandler();
    await expect(
      subject.handler.handle(
        purgeContext({
          outboxIntentId: OUTBOX_INTENT_ID,
          payloadIntentId: "99999999-0000-4000-8000-000000000009",
        }),
      ),
    ).rejects.toBeInstanceOf(PermanentQueueJobError);
    expect(subject.noteIndex.deleteWorkspaceDocuments).not.toHaveBeenCalled();
  });

  it("succeeds without purging when Meilisearch is disabled", async () => {
    const subject = buildPurgeHandler({ meilisearchEnabled: false });
    await expect(subject.handler.handle(purgeContext())).resolves.toBeUndefined();
    expect(subject.noteIndex.deleteWorkspaceDocuments).not.toHaveBeenCalled();
  });

  it("deletes all indexed documents for the workspace via the filter-based purge", async () => {
    const subject = buildPurgeHandler();
    subject.handler.onModuleInit();

    await subject.handler.handle(purgeContext({ workspaceId: WORKSPACE_ID }));

    expect(subject.noteIndex.deleteWorkspaceDocuments).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(subject.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID, outcome: "purged" }),
      expect.any(String),
    );
  });

  it("is idempotent: a repeated purge intent re-invokes the same filter delete", async () => {
    const subject = buildPurgeHandler();
    subject.handler.onModuleInit();

    await subject.handler.handle(purgeContext());
    await subject.handler.handle(purgeContext());

    expect(subject.noteIndex.deleteWorkspaceDocuments).toHaveBeenCalledTimes(2);
    expect(subject.noteIndex.deleteWorkspaceDocuments).toHaveBeenNthCalledWith(2, WORKSPACE_ID);
  });
});

describe("note search sync registration contract", () => {
  it("matches the canonical registry definition exactly", () => {
    const subject = buildSyncHandler();
    subject.handler.onModuleInit();
    const binding = subject.registry.lookup(DOMAIN_JOB_TYPES.noteSearchSync);
    expect(binding?.definition.jobType).toBe(NOTE_SEARCH_SYNC_JOB_DEFINITION.jobType);
    expect(binding?.definition.payloadVersion).toBe(NOTE_SEARCH_SYNC_JOB_DEFINITION.payloadVersion);
    expect(binding?.definition.route.physicalQueueName).toBe(
      NOTE_SEARCH_SYNC_JOB_DEFINITION.route.physicalQueueName,
    );
  });

  it("validates the producer payload contract: identifier-only, workspace-scoped, 1-8 resourceIds", () => {
    const schema = NOTE_SEARCH_SYNC_JOB_DEFINITION.payloadSchema;
    // Valid producer payload.
    const valid = {
      action: DOMAIN_JOB_TYPES.noteSearchSync,
      intentId: OUTBOX_INTENT_ID,
      workspaceId: WORKSPACE_ID,
      resourceIds: [NOTE_A, NOTE_B],
    };
    expect(schema.safeParse(valid).success).toBe(true);
    // Optional actorId is accepted but not required.
    expect(schema.safeParse({ ...valid, actorId: AUTHOR_ID }).success).toBe(true);
    // Rejects content/secrets leaking across the boundary.
    expect(schema.safeParse({ ...valid, secret: "leak" }).success).toBe(false);
    // Rejects zero resourceIds.
    expect(schema.safeParse({ ...valid, resourceIds: [] }).success).toBe(false);
    // Rejects more than 8 resourceIds.
    expect(
      schema.safeParse({
        ...valid,
        resourceIds: Array.from(
          { length: 9 },
          (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
        ),
      }).success,
    ).toBe(false);
    // Rejects missing workspaceId.
    expect(
      schema.safeParse({
        action: valid.action,
        intentId: valid.intentId,
        resourceIds: valid.resourceIds,
      }).success,
    ).toBe(false);
  });
});
