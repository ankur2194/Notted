import { Module } from "@nestjs/common";

import { MeilisearchModule } from "../infrastructure/meilisearch/meilisearch.module";
import { QueueModule } from "../queue/queue.module";

import {
  NoteIndexJobHandler,
  WorkspaceSearchPurgeJobHandler,
} from "./note-index-job-handler.service";
import { NoteIndexRepository } from "./note-index.repository";
import { NoteProjectionRepository } from "./note-projection.repository";
import { NoteReindexService } from "./note-reindex.service";
import { NoteSearchIndexProducer } from "./note-search-index-producer";
import { WorkspaceSearchRepository } from "./workspace-search.repository";

@Module({
  // QueueModule supplies QueueHandlerRegistry (the dispatch gate the handlers
  // register through). DatabaseModule, TenantContextModule, and CommonModule
  // are @Global, so no explicit imports are needed for their providers.
  imports: [MeilisearchModule, QueueModule],
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
  ],
  exports: [
    NoteIndexRepository,
    NoteProjectionRepository,
    NoteReindexService,
    // Re-exported so NotesModule/TagsModule/AttachmentsModule/ProjectsModule
    // can inject the producer after adding SearchModule to their imports.
    NoteSearchIndexProducer,
  ],
})
export class SearchModule {}
