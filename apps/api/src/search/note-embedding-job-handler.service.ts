import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from "../infrastructure/embeddings/embedding-provider";
import { defineQueueJobRegistration, type QueueJobContext } from "../queue/job-contracts";
import { NOTE_EMBEDDING_GENERATE_JOB_DEFINITION } from "../queue/job-registry";
import { PermanentQueueJobError } from "../queue/queue-errors";
import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";
import { createTenantContext, TenantContextService } from "../tenant";

import { NoteEmbeddingRepository } from "./note-embedding.repository";

import type { z } from "zod";

type Context = QueueJobContext<
  typeof NOTE_EMBEDDING_GENERATE_JOB_DEFINITION.jobType,
  z.output<typeof NOTE_EMBEDDING_GENERATE_JOB_DEFINITION.payloadSchema>
>;
@Injectable()
export class NoteEmbeddingJobHandler implements OnModuleInit, OnModuleDestroy {
  readonly jobType = NOTE_EMBEDDING_GENERATE_JOB_DEFINITION.jobType;
  private unregister?: () => void;
  constructor(
    @Inject(EMBEDDING_PROVIDER) private readonly provider: EmbeddingProvider,
    private readonly repository: NoteEmbeddingRepository,
    private readonly tenantContext: TenantContextService,
    private readonly registry: QueueHandlerRegistry,
  ) {}
  onModuleInit(): void {
    this.unregister = this.registry.register(
      defineQueueJobRegistration({
        definition: NOTE_EMBEDDING_GENERATE_JOB_DEFINITION,
        handler: this,
      }),
    );
  }
  onModuleDestroy(): void {
    this.unregister?.();
  }
  async handle(context: Context): Promise<void> {
    if (context.payload.intentId !== context.outboxIntentId)
      throw new PermanentQueueJobError("payload_invalid");
    if (this.provider.availability() === "disabled") return;
    await this.tenantContext.run(
      createTenantContext({
        workspaceId: context.payload.workspaceId,
        userId: null,
        requestId: context.correlationId,
      }),
      async () => {
        for (const noteId of context.payload.resourceIds) {
          const source = await this.repository.loadSource(noteId);
          if (source === null) continue;
          const metadata = await this.repository.metadata(noteId);
          if (
            metadata?.model === this.provider.model() &&
            metadata.dimensions === this.provider.dimensions() &&
            metadata.contentHash === source.contentHash
          )
            continue;
          const result = await this.provider.embed(source.text, context.signal);
          await this.repository.upsertIfSourceCurrent({
            noteId,
            expectedHash: source.contentHash,
            vector: result.vector,
            model: result.model,
            dimensions: result.dimensions,
          });
        }
      },
    );
  }
}
