import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";

import { TasksController } from "./tasks.controller";
import { TasksService } from "./tasks.service";
import { TasksTrpcRouter } from "./tasks.trpc";

@Module({
  imports: [AuthModule, AuthorizationModule],
  controllers: [TasksController],
  providers: [TasksService, TasksTrpcRouter],
  exports: [TasksService, TasksTrpcRouter],
})
export class TasksModule {}
