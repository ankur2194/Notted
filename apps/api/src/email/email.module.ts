import { Module } from "@nestjs/common";

import { AuthorizationModule } from "../authorization/authorization.module";
import { SmtpModule } from "../infrastructure/smtp/smtp.module";
import { QueueModule } from "../queue/queue.module";

import { EmailDeliveryQueueHandler } from "./email-delivery.worker.service";
import { EmailRendererService } from "./email-renderer.service";
import { WorkspaceEmailProducerService } from "./workspace-email-producer.service";

@Module({
  // QueueModule supplies QueueHandlerRegistry (the dispatch gate the delivery
  // handler registers through); SmtpModule supplies the transport. DatabaseModule,
  // TenantContextModule and ConfigModule are @Global, so DatabaseService,
  // TenantContextService, APP_CONFIG and FEATURES_CONFIG need no import here.
  //
  // This module must NEVER import NotificationModule — the arrow goes the other
  // way (mention email is produced from the notification side), and keeping it
  // one-way is what makes a `forwardRef` unnecessary.
  imports: [AuthorizationModule, SmtpModule, QueueModule],
  providers: [EmailRendererService, WorkspaceEmailProducerService, EmailDeliveryQueueHandler],
  exports: [EmailRendererService, WorkspaceEmailProducerService],
})
export class EmailModule {}
