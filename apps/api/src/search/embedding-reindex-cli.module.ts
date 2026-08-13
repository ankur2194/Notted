import { Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module";
import { DatabaseModule } from "../database/database.module";
import { EmbeddingsModule } from "../infrastructure/embeddings/embeddings.module";
import { TenantContextModule } from "../tenant/tenant-context.module";

import { NoteEmbeddingProducer } from "./note-embedding-producer";
import { NoteEmbeddingReindexService } from "./note-embedding-reindex.service";
import { NoteEmbeddingRepository } from "./note-embedding.repository";

/** No HTTP, AppModule, QueueModule, workers, listeners, or schedulers. Writes outbox intent only. */
@Module({
  imports: [ConfigModule, DatabaseModule, TenantContextModule, EmbeddingsModule],
  providers: [NoteEmbeddingProducer, NoteEmbeddingRepository, NoteEmbeddingReindexService],
  exports: [NoteEmbeddingReindexService],
})
export class EmbeddingReindexCliModule {}
