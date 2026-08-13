import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationPolicyModule } from "../authorization/authorization-policy.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { EmbeddingsModule } from "../infrastructure/embeddings/embeddings.module";
import { MeilisearchModule } from "../infrastructure/meilisearch/meilisearch.module";
import { QueueModule } from "../queue/queue.module";

import { HybridRankingService } from "./hybrid-ranking.service";
import { HybridSearchService } from "./hybrid-search.service";
import { NoteEmbeddingJobHandler } from "./note-embedding-job-handler.service";
import { NoteEmbeddingProducer } from "./note-embedding-producer";
import { NoteEmbeddingRepository } from "./note-embedding.repository";
import {
  NoteIndexJobHandler,
  WorkspaceSearchPurgeJobHandler,
} from "./note-index-job-handler.service";
import { NoteIndexRepository } from "./note-index.repository";
import { NoteProjectionRepository } from "./note-projection.repository";
import { NoteReindexService } from "./note-reindex.service";
import { NoteSearchIndexProducer } from "./note-search-index-producer";
import { SearchResultRepository } from "./search-result.repository";
import { SearchController } from "./search.controller";
import { SearchService } from "./search.service";
import { SemanticSearchRepository } from "./semantic-search.repository";
import { SemanticSearchService } from "./semantic-search.service";
import { WorkspaceSearchRepository } from "./workspace-search.repository";

@Module({
  // QueueModule supplies QueueHandlerRegistry (the dispatch gate the handlers
  // register through). DatabaseModule, TenantContextModule, and CommonModule
  // are @Global, so no explicit imports are needed for their providers.
  //
  // AuthorizationModule is imported so the `AuthorizationHttpGuard` and
  // `AuthorizationHttpInterceptor` (referenced by `@RequireAuthorization` on
  // `SearchController`) are resolvable inside this module's request scope. It
  // also re-exports `AuthorizationPolicyModule`, but the explicit
  // `AuthorizationPolicyModule` import documents the
  // `SearchResultRepository`'s direct dependency on
  // `AuthorizationPolicyService`.
  imports: [
    AuthModule,
    AuthorizationModule,
    AuthorizationPolicyModule,
    EmbeddingsModule,
    MeilisearchModule,
    QueueModule,
  ],
  controllers: [SearchController],
  providers: [
    NoteIndexRepository,
    NoteProjectionRepository,
    WorkspaceSearchRepository,
    NoteReindexService,
    NoteIndexJobHandler,
    WorkspaceSearchPurgeJobHandler,
    // Part 51.3 — narrow transaction-scoped producer injected into every
    // note-affecting service (Notes/Tags/Attachments/Projects) so they can
    // emit `note.search.sync` intents alongside their existing domain-event
    // outbox rows.
    NoteSearchIndexProducer,
    // Part 52.2 — authorized full-text search application service and its
    // authoritative PostgreSQL reads for candidate authorization + metadata.
    SearchResultRepository,
    SearchService,
    NoteEmbeddingProducer,
    NoteEmbeddingRepository,
    NoteEmbeddingJobHandler,
    SemanticSearchRepository,
    SemanticSearchService,
    HybridRankingService,
    HybridSearchService,
  ],
  exports: [
    NoteIndexRepository,
    NoteProjectionRepository,
    NoteReindexService,
    // Re-exported so NotesModule/TagsModule/AttachmentsModule/ProjectsModule
    // can inject the producer after adding SearchModule to their imports.
    NoteSearchIndexProducer,
    NoteEmbeddingProducer,
  ],
})
export class SearchModule {}
