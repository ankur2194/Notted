import { Module } from "@nestjs/common";

import { AiModule } from "./ai/ai.module";
import { ApiKeysModule } from "./api-keys/api-keys.module";
import { ApiController } from "./api.controller";
import { AttachmentsModule } from "./attachments/attachments.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { AuthorizationModule } from "./authorization/authorization.module";
import { CommentsModule } from "./comments/comments.module";
import { CommonModule } from "./common/common.module";
import { ConfigModule } from "./config/config.module";
import { DatabaseModule } from "./database/database.module";
import { DomainsModule } from "./domains/domains.module";
import { EmailModule } from "./email/email.module";
import { ExportModule } from "./export/export.module";
import { HealthModule } from "./health/health.module";
import { MaintenanceModule } from "./maintenance/maintenance.module";
import { MembershipsModule } from "./memberships/memberships.module";
import { MetricsModule } from "./metrics/metrics.module";
import { NotesModule } from "./notes/notes.module";
import { NotificationModule } from "./notifications/notification.module";
import { OpenApiModule } from "./openapi/openapi.module";
import { ProjectsModule } from "./projects/projects.module";
import { QueueModule } from "./queue/queue.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { SearchModule } from "./search/search.module";
import { ShellModule } from "./shell/shell.module";
import { StorageModule } from "./storage/storage.module";
import { TagsModule } from "./tags/tags.module";
import { TasksModule } from "./tasks/tasks.module";
import { TenantContextModule } from "./tenant/tenant-context.module";
import { TrpcModule } from "./trpc/trpc.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { WorkspacesModule } from "./workspaces/workspaces.module";

@Module({
  imports: [
    ConfigModule,
    CommonModule,
    DatabaseModule,
    AuthModule,
    AuthorizationModule,
    // Part 65. `ApiKeysModule` owns key issuance/revocation and the bearer
    // authenticator the `/api/v1` pre-guard calls; `OpenApiModule` documents
    // the public REST surface those keys reach.
    ApiKeysModule,
    OpenApiModule,
    // Part 67. Owns the workspace AI configuration surface, the encrypted
    // provider credential, and the fail-closed governance gate every AI
    // request passes through.
    AiModule,
    AttachmentsModule,
    // Part 71. Owns the read-only audit trail REST surface (paged list + bounded CSV export).
    AuditModule,
    CommentsModule,
    // Part 73. Owns the custom-domain claim/verify surface and the public
    // host-to-workspace lookup the reverse proxy and ACME issuer ask.
    DomainsModule,
    // Part 61. Owns the generic template renderer, the transactional producer,
    // and the `email.deliver` queue handler.
    EmailModule,
    // Part 62. Owns the export REST transport, job rows, and the `export.generate`
    // queue handler.
    ExportModule,
    HealthModule,
    // Part 45. `StorageModule` already imports `MaintenanceModule`; both are
    // listed so the scheduler is instantiated even if the storage transport is
    // ever removed from the graph.
    MaintenanceModule,
    StorageModule,
    MembershipsModule,
    // Part 78. Owns `GET /metrics` and the scrape-time collectors. Every other
    // metric is written through module-scope consts in `metrics.registry.ts`,
    // so no other module imports this one.
    MetricsModule,
    ShellModule,
    NotificationModule,
    NotesModule,
    ProjectsModule,
    // Safe with zero handlers: QueueHandlerRegistry is the mandatory dispatch gate.
    QueueModule,
    RealtimeModule,
    // Safe before Part 51 queue producers/handlers: this owns only the
    // rebuildable note-index contract and provider adapter.
    SearchModule,
    TagsModule,
    TasksModule,
    TenantContextModule,
    TrpcModule,
    // Part 66. Owns the webhook admin surface and the delivery worker, and
    // exports the transaction-scoped producer that NotesModule, ProjectsModule
    // and MembershipsModule commit their intents through.
    WebhooksModule,
    WorkspacesModule,
  ],
  controllers: [ApiController],
})
export class AppModule {}
