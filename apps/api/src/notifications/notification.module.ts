import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { QueueModule } from "../queue/queue.module";

import { MentionNotificationProducer } from "./mention-notification.producer";
import { MentionNotificationWorkerService } from "./mention-notification.worker.service";
import { NotificationController } from "./notification.controller";
import { NotificationService } from "./notification.service";

@Module({
  // QueueModule supplies QueueHandlerRegistry (the dispatch gate the mention
  // worker registers through). This module must NEVER import NotesModule —
  // NotesModule imports this one so `NotesService.update` can emit the intent,
  // and the arrow stays one-way so no `forwardRef` is needed.
  imports: [AuthModule, AuthorizationModule, QueueModule],
  controllers: [NotificationController],
  providers: [NotificationService, MentionNotificationProducer, MentionNotificationWorkerService],
  // Only the producer is exported: NotesModule emits the intent, it never
  // writes a notification row directly.
  exports: [NotificationService, MentionNotificationProducer],
})
export class NotificationModule {}
