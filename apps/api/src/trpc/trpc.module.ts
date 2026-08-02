import { Module } from "@nestjs/common";

import { NotesModule } from "../notes/notes.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";

import { TrpcRootRouter } from "./trpc-root.service";

@Module({
  imports: [WorkspacesModule, NotesModule],
  providers: [TrpcRootRouter],
  exports: [TrpcRootRouter],
})
export class TrpcModule {}
