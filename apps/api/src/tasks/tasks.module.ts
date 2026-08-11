import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";

import { TaskStatusesController } from "./task-statuses.controller";
import { TaskStatusesService } from "./task-statuses.service";
import { TasksController } from "./tasks.controller";
import { TasksService } from "./tasks.service";
import { TasksTrpcRouter } from "./tasks.trpc";

@Module({
  imports: [AuthModule, AuthorizationModule],
  controllers: [TasksController, TaskStatusesController],
  providers: [TasksService, TaskStatusesService, TasksTrpcRouter],
  exports: [TasksService, TaskStatusesService, TasksTrpcRouter],
})
export class TasksModule {}
