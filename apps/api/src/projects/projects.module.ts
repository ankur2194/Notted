import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { SearchModule } from "../search/search.module";

import { ProjectsController } from "./projects.controller";
import { ProjectsService } from "./projects.service";

@Module({
  // SearchModule supplies the NoteSearchIndexProducer used to emit
  // `note.search.sync` intents on project delete fan-out (Part 51.3).
  imports: [AuthModule, AuthorizationModule, SearchModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
