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

import { AttachmentsController, NoteAttachmentsController } from "./attachments.controller";
import { AttachmentsService } from "./attachments.service";
import { IMAGE_PROCESSOR } from "./image-processing";
import { ImageProcessingService } from "./image-processing.service";

@Module({
  imports: [AuthModule, AuthorizationModule, MinioModule],
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
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
