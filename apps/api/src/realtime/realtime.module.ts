import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { RedisModule } from "../infrastructure/redis/redis.module";

import { RealtimeRateLimitService } from "./realtime-rate-limit.service";
import { RealtimeRedisAdapterService } from "./realtime-redis-adapter.service";
import { RealtimeRoomService } from "./realtime-room.service";
import { RealtimeGateway } from "./realtime.gateway";

@Module({
  imports: [AuthModule, AuthorizationModule, RedisModule],
  providers: [
    RealtimeGateway,
    RealtimeRateLimitService,
    RealtimeRedisAdapterService,
    RealtimeRoomService,
  ],
  exports: [
    RealtimeGateway,
    RealtimeRateLimitService,
    RealtimeRedisAdapterService,
    RealtimeRoomService,
  ],
})
export class RealtimeModule {}
