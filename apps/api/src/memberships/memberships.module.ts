import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { RedisModule } from "../infrastructure/redis/redis.module";
import { SmtpModule } from "../infrastructure/smtp/smtp.module";

import { InvitationEmailDispatcherService } from "./invitation-email-dispatcher.service";
import { InvitationEmailQueueService } from "./invitation-email-queue.service";
import { InvitationEmailWorkerService } from "./invitation-email-worker.service";
import { InvitationTokenService } from "./invitation-token.service";
import { MembershipsController } from "./memberships.controller";
import { MembershipsService } from "./memberships.service";

@Module({
  imports: [AuthModule, AuthorizationModule, RedisModule, SmtpModule],
  controllers: [MembershipsController],
  providers: [
    InvitationEmailDispatcherService,
    InvitationEmailQueueService,
    InvitationEmailWorkerService,
    InvitationTokenService,
    MembershipsService,
  ],
  exports: [InvitationEmailQueueService, InvitationTokenService, MembershipsService],
})
export class MembershipsModule {}
