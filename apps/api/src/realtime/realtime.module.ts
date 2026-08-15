import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { RedisModule } from "../infrastructure/redis/redis.module";
import { NoteVersionsService } from "../notes/note-versions.service";
import { NotificationModule } from "../notifications/notification.module";
import { SearchModule } from "../search/search.module";

import { RealtimeRateLimitService } from "./realtime-rate-limit.service";
import { RealtimeRedisAdapterService } from "./realtime-redis-adapter.service";
import { RealtimeRoomService } from "./realtime-room.service";
import { RealtimeGateway } from "./realtime.gateway";
import { NoteCollaborationProjectionService } from "./yjs/note-collaboration.projection";
import { NoteCollaborationRepository } from "./yjs/note-collaboration.repository";
import { NoteCollaborationService } from "./yjs/note-collaboration.service";

@Module({
  // SearchModule supplies NoteSearchIndexProducer/NoteEmbeddingProducer so a
  // committed projection schedules the same index intents a synchronous note
  // mutation does.
  //
  // NoteVersionsService is PROVIDED here rather than imported from NotesModule
  // on purpose: NotesModule imports THIS module (NotesService.restoreVersion
  // needs NoteCollaborationService), so importing it back would be a module
  // cycle requiring `forwardRef`. The service is stateless and transaction-
  // scoped — its only dependency is the @Global TenantContextService — so a
  // second instance is indistinguishable from the first, and keeping the arrow
  // one-way is worth far more than sharing one object.
  // NotificationModule supplies MentionNotificationProducer so a mention typed
  // in a LIVE COLLABORATIVE session schedules the same intent a synchronous
  // `NotesService.update` does — the projection writes `notes.content` directly
  // and would otherwise notify nobody. The arrow stays one-way: NotificationModule
  // imports neither this module nor NotesModule, so no `forwardRef` is involved.
  imports: [AuthModule, AuthorizationModule, NotificationModule, RedisModule, SearchModule],
  providers: [
    RealtimeGateway,
    RealtimeRateLimitService,
    RealtimeRedisAdapterService,
    RealtimeRoomService,
    NoteVersionsService,
    NoteCollaborationRepository,
    NoteCollaborationService,
    NoteCollaborationProjectionService,
  ],
  exports: [
    RealtimeGateway,
    RealtimeRateLimitService,
    RealtimeRedisAdapterService,
    RealtimeRoomService,
    NoteCollaborationService,
    NoteCollaborationProjectionService,
  ],
})
export class RealtimeModule {}
