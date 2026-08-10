import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";

import { TagsController } from "./tags.controller";
import { TagsService } from "./tags.service";
import { TagsTrpcRouter } from "./tags.trpc";

@Module({
  imports: [AuthModule, AuthorizationModule],
  controllers: [TagsController],
  providers: [TagsService, TagsTrpcRouter],
  exports: [TagsService, TagsTrpcRouter],
})
export class TagsModule {}
