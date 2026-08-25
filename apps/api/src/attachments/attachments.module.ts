// `Notted.md` specifies `attachments/{attachments.module.ts,
// attachments.controller.ts, attachments.service.ts, dto/}`. The `dto/`
// directory is deliberately absent: this codebase parses shared Zod schemas at
// the transport boundary (see `notes.controller.ts` / `projects.controller.ts`)
// rather than class-validator DTO classes, so a `dto/` directory here would
// hold contracts that duplicate `@notted/shared-validators` and could drift
// from it. Recorded in the Part 40 completion record.

import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuthorizationModule } from "../authorization/authorization.module";
import { MinioModule } from "../infrastructure/minio/minio.module";
import { SearchModule } from "../search/search.module";
import { StorageModule } from "../storage/storage.module";

import { AttachmentsController, NoteAttachmentsController } from "./attachments.controller";
import { AttachmentsService } from "./attachments.service";
import { IMAGE_PROCESSOR } from "./image-processing";
import { ImageProcessingService } from "./image-processing.service";

@Module({
  // Part 45: `StorageModule` supplies `StorageQuotaService`, the single owner of
  // the quota rules the upload path enforces.
  // Part 51.3: `SearchModule` supplies `NoteSearchIndexProducer` for
  // re-syncing the owning note on attachment ready/delete.
  imports: [AuthModule, AuthorizationModule, MinioModule, StorageModule, SearchModule],
  controllers: [AttachmentsController, NoteAttachmentsController],
  providers: [
    AttachmentsService,
    // Part 41: the Sharp-backed processor. This binding is the ONLY place the
    // real implementation is named, which is what made replacing Part 40's
    // passthrough a one-line change. `ImageProcessingConfig` reaches it through
    // the global `ConfigModule`.
    ImageProcessingService,
    { provide: IMAGE_PROCESSOR, useExisting: ImageProcessingService },
  ],
  // Part 72: the `IMAGE_PROCESSOR` TOKEN is exported — not the Sharp-backed
  // class — so `WorkspacesModule` can re-encode a branding logo through the SAME
  // reviewed pipeline (SVG scan, HEIC decode, EXIF strip, bounded re-encode)
  // while still depending only on the `ImageProcessor` interface, exactly as
  // `AttachmentsService` does. Exporting the concrete class instead would have
  // coupled the workspace surface to the native decoder and made it untestable
  // without one. `matchesEtag` and `parseSingleFileUpload` are plain functions
  // and need no provider.
  exports: [AttachmentsService, IMAGE_PROCESSOR],
})
export class AttachmentsModule {}
