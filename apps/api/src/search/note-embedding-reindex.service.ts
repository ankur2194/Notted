import { Inject, Injectable } from "@nestjs/common";

import { DatabaseService } from "../database/database.service";
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from "../infrastructure/embeddings/embedding-provider";
import { createTenantContext, TenantContextService } from "../tenant";

import { NoteEmbeddingProducer } from "./note-embedding-producer";
import { NoteEmbeddingRepository } from "./note-embedding.repository";

export interface EmbeddingReindexResult {
  readonly status: "completed" | "disabled";
  readonly workspaceId: string;
  readonly model: string;
  readonly scheduled: number;
}
@Injectable()
export class NoteEmbeddingReindexService {
  constructor(
    @Inject(EMBEDDING_PROVIDER) private readonly provider: EmbeddingProvider,
    private readonly repository: NoteEmbeddingRepository,
    private readonly producer: NoteEmbeddingProducer,
    private readonly database: DatabaseService,
    private readonly tenantContext: TenantContextService,
  ) {}
  async reindexWorkspace(workspaceId: string): Promise<EmbeddingReindexResult> {
    if (this.provider.availability() === "disabled")
      return { status: "disabled", workspaceId, model: this.provider.model(), scheduled: 0 };
    return this.tenantContext.run(createTenantContext({ workspaceId, userId: null }), async () => {
      let afterId: string | undefined;
      let scheduled = 0;
      for (;;) {
        const page = await this.repository.stalePage({
          model: this.provider.model(),
          dimensions: this.provider.dimensions(),
          afterId,
          limit: 200,
        });
        if (page.noteIds.length > 0) {
          await this.database.transaction((tx) =>
            this.producer.scheduleGeneration(tx, workspaceId, page.noteIds, {
              mutation: "embedding.reindex",
            }),
          );
          scheduled += page.noteIds.length;
        }
        if (page.nextCursor === undefined) break;
        afterId = page.nextCursor;
      }
      return { status: "completed", workspaceId, model: this.provider.model(), scheduled };
    });
  }
}
