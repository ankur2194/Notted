import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { SearchModule } from "../search/search.module";
import { WebhooksModule } from "../webhooks/webhooks.module";

import { ProjectsController } from "./projects.controller";
import { ProjectsService } from "./projects.service";

@Module({
  // SearchModule supplies the NoteSearchIndexProducer used to emit
  // `note.search.sync` intents on project delete fan-out (Part 51.3).
  // WebhooksModule supplies the WebhookDeliveryProducer used to emit the
  // `project.created` webhook intent inside the project-mutation transaction
  // (Part 66). One-way arrow, so no `forwardRef`.
  imports: [AuthModule, AuthorizationModule, SearchModule, WebhooksModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
