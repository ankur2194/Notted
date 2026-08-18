// Part 62: export job lifecycle.
//
// DEPENDENCY DIRECTION — every arrow points INTO this module. `ExportModule`
// must NEVER be imported by `NotesModule`, `EmailModule` or `NotificationModule`
// (nor by anything else except `AppModule`): it consumes note content, sends the
// "your export is ready" email, and writes the ready notification, so the only
// import edges are outbound. Keeping that one-way is what makes `forwardRef`
// unnecessary here, unlike the Part 61 `EmailModule → AuthorizationModule →
// AuthModule` case that had to fall back to direct providers.

import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { EmailModule } from "../email/email.module";
import { MinioModule } from "../infrastructure/minio/minio.module";
import { NotificationModule } from "../notifications/notification.module";
import { QueueModule } from "../queue/queue.module";

import { BrowserPoolService } from "./browser-pool.service";
import { ExportGenerationService } from "./export-generation.service";
import { ExportJobProducer } from "./export-job.producer";
import { ExportController } from "./export.controller";
import { ExportService } from "./export.service";
import { ExportGenerationWorkerService } from "./export.worker.service";
import { NoteExportSourceService } from "./note-export-source.service";
import { PdfExportService } from "./pdf-export.service";
import { puppeteerLauncherProvider } from "./puppeteer-launcher.provider";

@Module({
  // MinioModule supplies ObjectStorageService (artefact bytes); QueueModule
  // supplies QueueHandlerRegistry (the dispatch gate the generation worker
  // registers through); EmailModule supplies WorkspaceEmailProducerService and
  // NotificationModule supplies NotificationService, both used by the worker for
  // the non-fatal "ready" side effects. DatabaseModule, TenantContextModule and
  // ConfigModule are @Global, so they need no import here.
  imports: [
    AuthModule,
    AuthorizationModule,
    MinioModule,
    QueueModule,
    EmailModule,
    NotificationModule,
  ],
  controllers: [ExportController],
  // Part 63 additions, all INTERNAL to this module and deliberately not
  // exported: Chromium is an export implementation detail, and a second module
  // reaching for `BrowserPoolService` would quietly turn the one shared browser
  // into shared global state with no owner.
  providers: [
    ExportService,
    ExportJobProducer,
    ExportGenerationWorkerService,
    ExportGenerationService,
    PdfExportService,
    BrowserPoolService,
    puppeteerLauncherProvider,
    // Part 64. Internal for the same reason Chromium is: the `zip` bundle reads
    // attachments, comments and versions on the REQUESTER's authority through
    // `authorizeUserJob`, and a second module reaching for it would be a way to
    // read note-scoped rows without going through that module's own policies.
    NoteExportSourceService,
  ],
  exports: [ExportService],
})
export class ExportModule {}
