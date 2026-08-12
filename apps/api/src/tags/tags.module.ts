import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { SearchModule } from "../search/search.module";

import { TagsController } from "./tags.controller";
import { TagsService } from "./tags.service";
import { TagsTrpcRouter } from "./tags.trpc";

@Module({
  // SearchModule supplies the NoteSearchIndexProducer used to emit
  // `note.search.sync` intents on tag rename/delete fan-out (Part 51.3).
  imports: [AuthModule, AuthorizationModule, SearchModule],
  controllers: [TagsController],
  providers: [TagsService, TagsTrpcRouter],
  exports: [TagsService, TagsTrpcRouter],
})
export class TagsModule {}
