// Part 66: outbound webhooks and their delivery logs.
//
// DEPENDENCY DIRECTION — every arrow points INTO this module. `NotesModule`,
// `ProjectsModule` and `MembershipsModule` import it for the producer; this
// module imports none of them, because it needs no note, project or membership
// SERVICE — the delivery worker re-reads those tables directly under a system
// authority and re-authorizes the endpoint's creator against them. That is what
// keeps the graph acyclic with no `forwardRef` anywhere, the same one-way shape
// `SearchModule` and `NotificationModule` already have with `NotesModule`.

import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { QueueModule } from "../queue/queue.module";

import { WebhookDeliveryProducer } from "./webhook-delivery.producer";
import { WebhookDeliveryWorkerService } from "./webhook-delivery.worker.service";
import { WebhookSecretService } from "./webhook-secret.service";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";

@Module({
  // QueueModule supplies QueueHandlerRegistry (the dispatch gate the delivery
  // worker registers through). DatabaseModule, TenantContextModule,
  // ConfigModule and CommonModule are all @Global, so they need no import.
  imports: [AuthModule, AuthorizationModule, QueueModule],
  controllers: [WebhooksController],
  providers: [
    WebhooksService,
    WebhookSecretService,
    WebhookDeliveryProducer,
    WebhookDeliveryWorkerService,
  ],
  // ONLY the producer is exported. `WebhooksService` stays internal: it is the
  // one place that can decrypt a signing secret and the one place that returns
  // a raw one, and a second module reaching for it would be a way to do both
  // without going through this module's own authorization.
  exports: [WebhookDeliveryProducer],
})
export class WebhooksModule {}
