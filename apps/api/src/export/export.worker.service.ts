// Part 62 — consumer for the `export.generate` intent.
//
// WHY GENERATION LIVES HERE AND NOT IN THE REQUEST: rendering a note into bytes
// and pushing them to MinIO is unbounded work on a request thread, and ADR 0006
// is explicit that the durable INTENT commits with the business mutation while
// the SIDE EFFECT happens after commit. `ExportService.create` writes the
// `exports` row plus the outbox intent in one transaction and returns; this
// handler is the only thing that ever produces the artefact.
//
// THE PAYLOAD IS IDENTIFIERS ONLY (ADR 0006). Nothing readable travels through
// Redis: no title, no content, no object key, no credentials. Every fact this
// handler acts on — the format, the source, the requester, the note body — is
// re-read from PostgreSQL, so a tampered or stale payload can neither redirect
// the upload nor smuggle content into the artefact.
//
// AUTHORIZATION IS SERVER-LOADED, TWICE, FOR TWO DIFFERENT SUBJECTS:
//  1. A SYSTEM authority with a FINITE capability set (`workspace.read` on
//     `workspace`, never a wildcard) opens the tenant context the row
//     bookkeeping needs. It deliberately cannot read a note.
//  2. The REQUESTER is re-authorized against the LIVE source with
//     `authorizeUserJob`. A workspace membership check is NOT what `note.read`
//     means — a restricted project's notes are readable only by project
//     members — so the same policy the HTTP and socket transports run decides
//     here too, at generation time, against facts loaded now rather than at
//     request time.
//
// FAILURE PHILOSOPHY: almost nothing here throws. A denied requester, a deleted
// source, an unimplemented format, a storage outage — each is a CLEAN job
// outcome recorded on the row via `markFailed`, because none of them will
// resolve differently on a retry and none of them should dead-letter. Only a
// genuinely broken envelope throws, and it throws permanently.
//
// FORMAT EXTENSION POINT: new formats are added in `export-generation.service.ts`
// (a new arm in `ExportGenerationService.render` plus its media facts in
// `export-renderers.ts`). Nothing in this file changes — it already treats the
// generator as a closed box that either returns bytes or refuses. Do NOT add
// per-format branching, per-format authorization, or a second upload path here.

import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, eq } from "drizzle-orm";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { AuthorizationDeniedError } from "../authorization/authorization.errors";
import { StructuredLogger } from "../common/logging/structured-logger.service";
import { DatabaseService } from "../database/database.service";
import { notes, users } from "../database/schema";
import { WorkspaceEmailProducerService } from "../email/workspace-email-producer.service";
import { ObjectStorageService } from "../infrastructure/minio/object-storage.service";
import { NotificationService } from "../notifications/notification.service";
import { defineQueueJobRegistration, type QueueJobContext } from "../queue/job-contracts";
import { EXPORT_GENERATE_JOB_DEFINITION } from "../queue/job-registry";
import { PermanentQueueJobError } from "../queue/queue-errors";
import { QueueHandlerRegistry } from "../queue/queue-handler-registry.service";

import { ExportGenerationService } from "./export-generation.service";
import { exportObjectKey } from "./export-object-key";
import { UnsupportedExportFormatError, type ExportArtifact } from "./export-renderers";
import { ExportService, type ExportClaim } from "./export.service";

import type { z } from "zod";

/** `notifications.summary` / `notifications.target_label` column widths. */
const SUMMARY_MAX_LENGTH = 160;
const TARGET_LABEL_MAX_LENGTH = 120;

type ExportGenerateContext = QueueJobContext<
  typeof EXPORT_GENERATE_JOB_DEFINITION.jobType,
  z.output<typeof EXPORT_GENERATE_JOB_DEFINITION.payloadSchema>
>;

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : value.slice(0, max);

@Injectable()
export class ExportGenerationWorkerService implements OnModuleInit, OnModuleDestroy {
  readonly jobType = EXPORT_GENERATE_JOB_DEFINITION.jobType;
  private unregister?: () => void;

  constructor(
    private readonly database: DatabaseService,
    private readonly exports: ExportService,
    private readonly generation: ExportGenerationService,
    private readonly objects: ObjectStorageService,
    private readonly notifications: NotificationService,
    private readonly emailProducer: WorkspaceEmailProducerService,
    private readonly authorization: AuthorizationEntryService,
    private readonly registry: QueueHandlerRegistry,
    private readonly logger: StructuredLogger,
  ) {}

  onModuleInit(): void {
    this.unregister = this.registry.register(
      defineQueueJobRegistration({ definition: EXPORT_GENERATE_JOB_DEFINITION, handler: this }),
    );
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async handle(context: ExportGenerateContext): Promise<void> {
    if (context.payload.intentId !== context.outboxIntentId) {
      throw new PermanentQueueJobError("payload_invalid");
    }
    const { workspaceId, exportId, requestedById } = context.payload;

    // A FINITE system authority, never a wildcard. It exists only to open the
    // tenant context the `exports` bookkeeping (and the email producer's
    // `assertActiveWorkspace`) requires. It cannot read a note on purpose: the
    // requester's own authority does that below.
    const operation = await this.authorization.authorizeSystem({
      actor: {
        kind: "system",
        authorityId: "export-generation-worker",
        workspaceId,
        purpose: "generate a queued workspace export",
        allowedActions: ["workspace.read"],
        allowedResourceKinds: ["workspace"],
      },
      action: "workspace.read",
      resource: { kind: "workspace" },
      correlationId: context.correlationId,
    });
    await this.authorization.run(operation, () =>
      this.generate(context, workspaceId, exportId, requestedById),
    );
  }

  private async generate(
    context: ExportGenerateContext,
    workspaceId: string,
    exportId: string,
    payloadRequestedById: string,
  ): Promise<void> {
    // THE ONE AND ONLY REPLAY GUARD. `claim` is the conditional
    // `queued -> processing` transition, so exactly one attempt can proceed.
    // `null` means the row was already claimed by a live attempt or already
    // settled (ready/failed/cancelled/expired) — a replay, not a failure. There
    // is deliberately no second guard anywhere below: two guards would
    // eventually disagree about which one owns the artefact.
    const claim = await this.exports.claim({ workspaceId, exportId });
    if (claim === null) {
      // ponytail: a `claim` miss is treated as a benign replay, which is right for a row that reached a terminal status but WRONG for one still at `processing`. Anything that throws after a successful claim (a database blip on the note re-read, a non-authorization failure, a failing `markReady`) leaves the row at `processing` forever: the retry's claim misses, this branch returns normally, and BullMQ marks the job complete instead of dead-lettering. There is no `processing -> failed` staleness edge — `storage-maintenance.service.ts` only does `ready -> expired`. Not data loss and not a leak; the user sees the dialog's timeout state and a fresh idempotency key produces a working export. Upgrade path: a staleness reaper in the Part 45 sweep (`processing` AND `created_at < now() - interval`, settled as `generation_failed`), which is smaller than teaching this branch to distinguish "someone else holds it" from "my own crashed attempt" — a distinction the row cannot currently express.
      this.logger.info(
        {
          jobId: exportId,
          workspaceId,
          // The payload requester, logged only here: with no claim there is no
          // authoritative row to attribute the replay to.
          requestedById: payloadRequestedById,
          jobType: this.jobType,
          outcome: "replayed",
        },
        "Export generation skipped an already-claimed job",
      );
      return;
    }

    // Defence in depth. `ExportService.create` refuses anything but a note
    // source today, so reaching this means a hand-inserted or migrated row.
    // Refuse it as a clean, machine-readable failure rather than crashing.
    if (claim.sourceType !== "note" || claim.sourceId === null) {
      await this.exports.markFailed({ workspaceId, exportId, errorCode: "format_unsupported" });
      return;
    }
    const sourceId = claim.sourceId;

    // RE-AUTHORIZE THE REQUESTER AGAINST THE LIVE SOURCE, not their membership.
    // Access may have been revoked between the request and this attempt, and a
    // restricted project's notes are readable only by project members. A denial
    // is a clean job outcome ("no longer allowed to have these bytes"), not a
    // throw: retrying it would never change the answer.
    try {
      await this.authorization.authorizeUserJob({
        userId: claim.requestedById,
        workspaceId,
        action: "note.read",
        resource: { kind: "note", id: sourceId },
        correlationId: context.correlationId,
      });
    } catch (error: unknown) {
      if (error instanceof AuthorizationDeniedError) {
        await this.exports.markFailed({ workspaceId, exportId, errorCode: "source_forbidden" });
        return;
      }
      throw error;
    }

    // Authoritative state, re-read now. Never the payload, never the object key.
    const [note] = await this.database.db
      .select({
        title: notes.title,
        content: notes.content,
        // AUTHORITATIVE SHEET. The page size is note state and is read here,
        // never taken from the request or the payload; the margins, which are
        // a per-browser viewing preference, ride in `options` and are clamped
        // by the renderer.
        pageSize: notes.pageSize,
        isDeleted: notes.isDeleted,
      })
      .from(notes)
      .where(and(eq(notes.workspaceId, workspaceId), eq(notes.id, sourceId)))
      .limit(1);
    // A SOURCE THAT DISAPPEARED MUST NEVER DEAD-LETTER. Deleting a note while
    // its export is queued is ordinary user behaviour, not an operational
    // incident: record `source_unavailable` on the row and finish cleanly.
    if (note === undefined || note.isDeleted) {
      await this.exports.markFailed({ workspaceId, exportId, errorCode: "source_unavailable" });
      return;
    }

    let artifact: ExportArtifact;
    try {
      artifact = await this.generation.render(claim.format, {
        title: note.title,
        content: note.content,
        options: claim.options,
        // `notes.page_size` is a `varchar`, so it is narrowed here rather than
        // trusted: a hand-edited or migrated row cannot put an unknown sheet
        // name into a stylesheet, it just falls back to the default.
        pageSize: note.pageSize === "letter" ? "letter" : "a4",
        // Part 64. IDENTIFIERS ONLY, and every one of them is a value this
        // handler already loaded or re-authorized above — nothing new is
        // trusted by passing them on. `zip` uses them to run its own authorized
        // reads for attachments/comments/versions; every other format ignores
        // them. This stays free of per-format branching on purpose.
        subject: {
          workspaceId,
          noteId: sourceId,
          requestedById: claim.requestedById,
          // `QueueJobContext` types this optional; the subject normalizes it to
          // `null` so a downstream authorized read gets one absent-value shape
          // rather than two.
          correlationId: context.correlationId ?? null,
        },
      });
    } catch (error: unknown) {
      const unsupported = error instanceof UnsupportedExportFormatError;
      await this.exports.markFailed({
        workspaceId,
        exportId,
        errorCode: unsupported ? "format_unsupported" : "generation_failed",
      });
      // CLASS NAME ONLY. A renderer error message can quote the note it choked
      // on, and a log line is persistence just like a mailbox is.
      this.logger.failure(
        {
          jobId: exportId,
          workspaceId,
          jobType: this.jobType,
          outcome: unsupported ? "format_unsupported" : "generation_failed",
          errorClass: error instanceof Error ? error.name : "unknown",
        },
        "Export generation could not produce an artefact",
      );
      return;
    }

    const objectKey = exportObjectKey(workspaceId, exportId, artifact.fileExtension);
    try {
      await this.objects.putObject("exports", objectKey, artifact.body, {
        contentType: artifact.mimeType,
        contentLength: artifact.body.byteLength,
      });
    } catch (error: unknown) {
      // Covers `ObjectStorageDisabledError` and every transport failure alike:
      // from the row's point of view there are no bytes either way, and the key
      // is deterministic so a re-request overwrites rather than orphans.
      await this.exports.markFailed({ workspaceId, exportId, errorCode: "storage_unavailable" });
      this.logger.failure(
        {
          jobId: exportId,
          workspaceId,
          jobType: this.jobType,
          outcome: "storage_unavailable",
          errorClass: error instanceof Error ? error.name : "unknown",
        },
        "Export artefact could not be stored",
      );
      return;
    }

    const ready = await this.exports.markReady({
      workspaceId,
      exportId,
      objectKey,
      byteLength: artifact.body.byteLength,
    });
    if (!ready) {
      // Someone cancelled mid-flight and won the race. The row is terminal and
      // is NOT ours to resurrect, and announcing a cancelled export would be
      // worse than announcing nothing.
      //
      // We must delete the bytes ourselves. `markReady` is the ONLY writer of
      // `exports.object_key`, so losing this race leaves the row terminal with
      // a NULL key — and the Part 45 sweep selects on `isNotNull(objectKey)`
      // (`storage-maintenance.service.ts`), so it can never see this object.
      // There is no orphan scan over the `exports` bucket either. Without this
      // removal every cancel-during-upload leaks one artefact permanently.
      // The row is already terminal, so there is nothing left to race with.
      try {
        await this.objects.removeObject("exports", objectKey);
      } catch (error: unknown) {
        // Best effort: a failed cleanup must not fail an already-settled job.
        this.logger.failure(
          {
            jobId: exportId,
            workspaceId,
            jobType: this.jobType,
            outcome: "orphan_cleanup_failed",
            errorClass: error instanceof Error ? error.name : "unknown",
          },
          "Export artefact could not be removed after losing the completion race",
        );
      }
      this.logger.info(
        { jobId: exportId, workspaceId, jobType: this.jobType, outcome: "lost_race" },
        "Export was settled by another actor before it could be marked ready",
      );
      return;
    }

    await this.announce(context, claim, exportId, workspaceId, note.title);

    this.logger.info(
      {
        jobId: exportId,
        workspaceId,
        jobType: this.jobType,
        outcome: "ready",
        byteLength: artifact.body.byteLength,
      },
      "Export generation completed",
    );
  }

  /**
   * TWO SEPARATE FAILURE DOMAINS, NEITHER OF WHICH MAY FAIL THE EXPORT.
   *
   * By the time this runs the bytes are durable in MinIO and the row already
   * says `ready` — the user can find and download the export from the app with
   * or without an announcement. A notification insert that trips a constraint
   * or an SMTP config that is simply wrong must therefore never re-queue this
   * job: a retry would re-render and re-upload an artefact that already exists,
   * and (worse) could re-announce it once storage succeeded again.
   *
   * They are also independent of each other: an in-app notification is not a
   * mailbox, and an outage in one is not an outage in the other. They therefore
   * get SEPARATE `try` blocks rather than one — a notification insert that trips
   * a constraint must not swallow the email that would still have been
   * deliverable. Sharing a `catch` would quietly couple the two domains this
   * design (and Part 60/61's two-intent split) exists to keep apart.
   */
  private async announce(
    context: ExportGenerateContext,
    claim: ExportClaim,
    exportId: string,
    workspaceId: string,
    noteTitle: string,
  ): Promise<void> {
    try {
      await this.notifications.emit({
        workspaceId,
        recipientUserId: claim.requestedById,
        actorUserId: null,
        kind: "export",
        targetType: "export",
        targetId: exportId,
        summary: truncate(`Your ${claim.format.toUpperCase()} export is ready`, SUMMARY_MAX_LENGTH),
        targetLabel: truncate(noteTitle, TARGET_LABEL_MAX_LENGTH),
      });
    } catch (error: unknown) {
      this.announceFailed(error, exportId, workspaceId, "notification_failed");
    }

    try {
      const [requester] = await this.database.db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, claim.requestedById))
        .limit(1);
      if (requester === undefined) return;

      await this.database.transaction((tx) =>
        this.emailProducer.queue(tx, {
          templateKey: "export_ready",
          recipient: requester.email,
          workspaceId,
          // AUTHORITATIVE SUBJECT REFERENCE. The delivery handler re-reads the
          // export row through exactly this pair, so it must be the export id
          // and the literal `"export"` — nothing else resolves.
          relatedEntityType: "export",
          relatedEntityId: exportId,
          actorId: claim.requestedById,
          correlationId: context.correlationId,
        }),
      );
    } catch (error: unknown) {
      this.announceFailed(error, exportId, workspaceId, "email_failed");
    }
  }

  /** Identifiers, an outcome and an error CLASS. Never a message, never content. */
  private announceFailed(
    error: unknown,
    exportId: string,
    workspaceId: string,
    outcome: "notification_failed" | "email_failed",
  ): void {
    this.logger.warning(
      {
        jobId: exportId,
        workspaceId,
        jobType: this.jobType,
        outcome,
        errorClass: error instanceof Error ? error.name : "unknown",
      },
      "Export ready side effect failed",
    );
  }
}
