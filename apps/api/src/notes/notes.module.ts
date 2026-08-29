import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { NotificationModule } from "../notifications/notification.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { SearchModule } from "../search/search.module";
import { WebhooksModule } from "../webhooks/webhooks.module";

import { FoldersService } from "./folders.service";
import { NoteSharesController } from "./note-shares.controller";
import { NoteSharesService } from "./note-shares.service";
import { NoteVersionsService } from "./note-versions.service";
import { FoldersController, NotesController } from "./notes.controller";
import { NotesService } from "./notes.service";
import { NotesTrpcRouter } from "./notes.trpc";

@Module({
  // SearchModule supplies the NoteSearchIndexProducer used to emit
  // `note.search.sync` intents alongside note mutations (Part 51.3).
  // RealtimeModule supplies NoteCollaborationService so `restoreVersion` can
  // reconcile the persisted Yjs authority with the restored projection inside
  // its own transaction (Part 58). The arrow is one-way — RealtimeModule never
  // imports NotesModule — so no `forwardRef` is involved.
  // NotificationModule supplies the MentionNotificationProducer used to emit
  // `notification.mention` intents inside the note-update transaction
  // (Part 60). The arrow is one-way — NotificationModule never imports
  // NotesModule — so no `forwardRef` is involved.
  // WebhooksModule supplies the WebhookDeliveryProducer used to emit
  // `webhook.deliver` intents inside every note-mutation transaction (Part 66).
  // The arrow is one-way — WebhooksModule imports nothing from here, because
  // the delivery worker re-reads `notes` directly under its own system
  // authority — so no `forwardRef` is involved.
  imports: [
    AuthModule,
    AuthorizationModule,
    NotificationModule,
    RealtimeModule,
    SearchModule,
    WebhooksModule,
  ],
  controllers: [NotesController, FoldersController, NoteSharesController],
  providers: [
    FoldersService,
    NotesService,
    NoteSharesService,
    NoteVersionsService,
    NotesTrpcRouter,
  ],
  exports: [FoldersService, NotesService, NoteSharesService, NoteVersionsService, NotesTrpcRouter],
})
export class NotesModule {}
