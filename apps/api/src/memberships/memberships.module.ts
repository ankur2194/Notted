import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { EmailModule } from "../email/email.module";
import { SmtpModule } from "../infrastructure/smtp/smtp.module";
import { QueueModule } from "../queue/queue.module";

import { InvitationEmailQueueHandler } from "./invitation-email-worker.service";
import { InvitationTokenService } from "./invitation-token.service";
import { MembershipsController } from "./memberships.controller";
import { MembershipsService } from "./memberships.service";

@Module({
  imports: [AuthModule, AuthorizationModule, EmailModule, SmtpModule, QueueModule],
  controllers: [MembershipsController],
  providers: [InvitationEmailQueueHandler, InvitationTokenService, MembershipsService],
  exports: [InvitationTokenService, MembershipsService],
})
export class MembershipsModule {}
