import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { SearchModule } from "../search/search.module";

import { NoteSharesController } from "./note-shares.controller";
import { NoteSharesService } from "./note-shares.service";
import { NoteVersionsService } from "./note-versions.service";
import { FoldersController, NotesController } from "./notes.controller";
import { NotesService } from "./notes.service";
import { NotesTrpcRouter } from "./notes.trpc";

@Module({
  // SearchModule supplies the NoteSearchIndexProducer used to emit
  // `note.search.sync` intents alongside note mutations (Part 51.3).
  imports: [AuthModule, AuthorizationModule, SearchModule],
  controllers: [NotesController, FoldersController, NoteSharesController],
  providers: [NotesService, NoteSharesService, NoteVersionsService, NotesTrpcRouter],
  exports: [NotesService, NoteSharesService, NoteVersionsService, NotesTrpcRouter],
})
export class NotesModule {}
