import { Module } from "@nestjs/common";

import { CommonModule } from "../common/common.module";
import { ConfigModule } from "../config/config.module";
import { DatabaseModule } from "../database/database.module";
import { MeilisearchModule } from "../infrastructure/meilisearch/meilisearch.module";
import { TenantContextModule } from "../tenant/tenant-context.module";

import { NoteIndexRepository } from "./note-index.repository";
import { NoteProjectionRepository } from "./note-projection.repository";
import { NoteReindexService } from "./note-reindex.service";
import { WorkspaceSearchRepository } from "./workspace-search.repository";

/** Deliberately excludes AppModule, QueueModule, auth, schedulers, and HTTP transports. */
@Module({
  imports: [ConfigModule, CommonModule, DatabaseModule, TenantContextModule, MeilisearchModule],
  providers: [
    NoteIndexRepository,
    NoteProjectionRepository,
    WorkspaceSearchRepository,
    NoteReindexService,
  ],
  exports: [NoteReindexService],
})
export class SearchReindexCliModule {}
