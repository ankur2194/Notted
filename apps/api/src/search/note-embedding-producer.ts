import { createHash, randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { jobOutbox, type JobOutboxPayload } from "../database/schema";
import { DOMAIN_JOB_TYPES } from "../queue/job-identifiers";
import {
  NOTE_EMBEDDING_GENERATE_JOB_DEFINITION,
  NOTE_EMBEDDING_GENERATE_SOURCE_QUEUE_NAME,
} from "../queue/job-registry";
import { activeWorkspaceId, assertActiveWorkspace, TenantContextService } from "../tenant";

import type { DatabaseTransaction } from "../database/database.service";

export const NOTE_EMBEDDING_BATCH_SIZE = 8;
export interface NoteEmbeddingProducerOptions {
  readonly mutation: string;
  readonly correlationId?: string | null;
  readonly actorId?: string;
}

@Injectable()
export class NoteEmbeddingProducer {
  constructor(private readonly tenantContext: TenantContextService) {}
  async scheduleGeneration(
    tx: DatabaseTransaction,
    workspaceId: string,
    noteIds: readonly string[],
    options: NoteEmbeddingProducerOptions,
  ): Promise<void> {
    if (noteIds.length === 0) return;
    assertActiveWorkspace(workspaceId, this.tenantContext, "note.embedding.generate");
    const unique = [...new Set(noteIds)];
    for (let offset = 0; offset < unique.length; offset += NOTE_EMBEDDING_BATCH_SIZE) {
      const intentId = randomUUID();
      const payload: JobOutboxPayload = Object.freeze({
        action: DOMAIN_JOB_TYPES.noteEmbeddingGenerate,
        intentId,
        workspaceId,
        resourceIds: Object.freeze(unique.slice(offset, offset + NOTE_EMBEDDING_BATCH_SIZE)),
        ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
      });
      await tx.insert(jobOutbox).values({
        id: intentId,
        workspaceId: activeWorkspaceId(this.tenantContext),
        queueName: NOTE_EMBEDDING_GENERATE_SOURCE_QUEUE_NAME,
        jobType: DOMAIN_JOB_TYPES.noteEmbeddingGenerate,
        payloadVersion: NOTE_EMBEDDING_GENERATE_JOB_DEFINITION.payloadVersion,
        payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        idempotencyKey: `note-embedding:${createHash("sha256")
          .update(JSON.stringify({ workspaceId, mutation: options.mutation, intentId }))
          .digest("hex")}`,
        correlationId: options.correlationId ?? null,
      });
    }
  }
}
