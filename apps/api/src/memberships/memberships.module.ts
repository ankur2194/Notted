import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { EmailModule } from "../email/email.module";
import { SmtpModule } from "../infrastructure/smtp/smtp.module";
import { QueueModule } from "../queue/queue.module";
import { WebhooksModule } from "../webhooks/webhooks.module";

import { InvitationEmailQueueHandler } from "./invitation-email-worker.service";
import { InvitationTokenService } from "./invitation-token.service";
import { MembershipsController } from "./memberships.controller";
import { MembershipsService } from "./memberships.service";

@Module({
  // WebhooksModule supplies the WebhookDeliveryProducer used to emit the
  // `member.joined` webhook intent inside the invitation-acceptance transaction
  // (Part 66). One-way arrow, so no `forwardRef`.
  imports: [AuthModule, AuthorizationModule, EmailModule, SmtpModule, QueueModule, WebhooksModule],
  controllers: [MembershipsController],
  providers: [InvitationEmailQueueHandler, InvitationTokenService, MembershipsService],
  exports: [InvitationTokenService, MembershipsService],
})
export class MembershipsModule {}
