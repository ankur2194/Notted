import { Module } from "@nestjs/common";

import { NotesModule } from "../notes/notes.module";
import { TagsModule } from "../tags/tags.module";
import { TasksModule } from "../tasks/tasks.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";

import { TrpcRootRouter } from "./trpc-root.service";

@Module({
  imports: [WorkspacesModule, NotesModule, TagsModule, TasksModule],
  providers: [TrpcRootRouter],
  exports: [TrpcRootRouter],
})
export class TrpcModule {}
