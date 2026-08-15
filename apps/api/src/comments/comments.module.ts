import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { RealtimeModule } from "../realtime/realtime.module";

import { CommentsController } from "./comments.controller";
import { CommentsService } from "./comments.service";
import { CommentsTrpcRouter } from "./comments.trpc";

@Module({
  // RealtimeModule supplies RealtimeRoomService, which already exports the emit
  // seam and parks the Socket.io server handed over by the gateway. Injecting
  // the gateway instead would invert the dependency arrow and force a
  // `forwardRef`; RealtimeModule never imports CommentsModule.
  imports: [AuthModule, AuthorizationModule, RealtimeModule],
  controllers: [CommentsController],
  providers: [CommentsService, CommentsTrpcRouter],
  exports: [CommentsService, CommentsTrpcRouter],
})
export class CommentsModule {}
