// Part 40: attachment application service.
//
// Implements ADR 0005's four-step cross-system workflow. PostgreSQL is
// authoritative for identity, ownership, workspace scope, object state, and
// quota; MinIO stores bytes only. Every method enters Part 24 authorization
// first and performs ALL SQL inside the authorized Part 19 tenant context.
//
// Ordering that is a correctness property, not a detail: on failure the row is
// marked `failed` and COMMITTED *before* any object is removed. If the process
// dies between the two, the database still says "failed" and Part 45's sweeper
// removes the stranded objects. The reverse order could delete bytes that a
// still-`ready` row claims to own.

import { createHash, randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { MAX_IMAGE_UPLOAD_BYTES } from "@notted/shared-validators";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { ApiHttpException } from "../common/errors/api-http.exception";
import {
  assertIdempotencyPayload,
  createApiIdempotencyIdentity,
  loadApiIdempotency,
  lockApiIdempotency,
  storeApiIdempotency,
} from "../common/idempotency/api-idempotency";
import { StructuredLogger } from "../common/logging/structured-logger.service";
import { SECURITY_CONFIG, type SecurityConfig } from "../config/security.config";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import {
  attachments,
  auditLogs,
  jobOutbox,
  notes,
  workspaces,
  type AttachmentVariantObject,
  type AttachmentVariantRecord,
  type JobOutboxPayload,
} from "../database/schema";
import {
  ObjectStorageDisabledError,
  ObjectStorageService,
  type ObjectStore,
} from "../infrastructure/minio/object-storage.service";
import {
  activeWorkspaceId,
  assertWorkspaceInsertValues,
  TenantContextService,
  whereWorkspace,
} from "../tenant";

import { attachmentObjectExtension, buildAttachmentObjectKey } from "./attachment-storage-key";
import {
  ATTACHMENT_AUDIT_ACTIONS,
  ATTACHMENT_AUDIT_ENTITY_TYPE,
  ATTACHMENT_DOMAIN_EVENT_IDEMPOTENCY_PREFIX,
  ATTACHMENT_DOMAIN_EVENT_PAYLOAD_VERSION,
  ATTACHMENT_DOMAIN_EVENT_QUEUE,
  ATTACHMENT_DOMAIN_EVENTS,
  ATTACHMENT_PROCESSING_ERRORS,
  ATTACHMENT_VARIANT_FALLBACKS,
  type AttachmentMutation,
  type AttachmentProcessingErrorCode,
} from "./attachments.constants";
import { sanitizeAttachmentFilename } from "./filename";
import { IMAGE_PROCESSOR, ImageProcessingError, type ImageProcessor } from "./image-processing";
import { IMAGE_SIGNATURE_HEAD_BYTES, sniffImageMediaType } from "./image-signature";

import type {
  AttachmentDeleteResult,
  AttachmentListResult,
  AttachmentMedia,
  AttachmentServableVariant,
  AttachmentStatus,
  AttachmentUploadResult,
  AttachmentVariantSet,
  AuthenticatedPrincipal,
} from "@notted/shared-types";
import type { Readable } from "node:stream";

const ATTACHMENTS_BUCKET = "attachments" as const;
/** Keys are random and immutable, so a rendition can be cached indefinitely. */
const CONTENT_CACHE_CONTROL = "private, max-age=31536000, immutable";

interface ScopedInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly requestId?: string | null;
}

export interface UploadImageInput extends ScopedInput {
  readonly noteId: string;
  readonly buffer: Buffer;
  /** UNTRUSTED transport hint; never persisted as the type. */
  readonly declaredMimeType: string;
  /** UNTRUSTED transport hint; sanitized before it becomes display metadata. */
  readonly declaredFilename: string;
  readonly idempotencyKey: string;
}

export interface ListNoteAttachmentsInput extends ScopedInput {
  readonly noteId: string;
}

export interface AttachmentSelectorInput extends ScopedInput {
  readonly attachmentId: string;
}

export interface ReadAttachmentContentInput extends AttachmentSelectorInput {
  readonly variant: AttachmentServableVariant;
}

export interface AttachmentContent {
  readonly stream: Readable;
  readonly mimeType: string;
  readonly contentLength: number;
  readonly etag: string;
  readonly filename: string;
}

interface AttachmentRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly noteId: string;
  readonly originalName: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly mediaType: "image" | "file";
  readonly processingStatus: AttachmentStatus;
  readonly variants: AttachmentVariantRecord | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly createdById: string;
  readonly createdAt: Date;
}

@Injectable()
export class AttachmentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
    @Inject(ObjectStorageService) private readonly objects: ObjectStore,
    @Inject(IMAGE_PROCESSOR) private readonly processor: ImageProcessor,
    @Inject(SECURITY_CONFIG) private readonly security: SecurityConfig,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Ceiling handed to the multipart parser. The image ceiling is the binding one
   * because ingestion buffers and decodes the whole payload in-process; the
   * operator's `MAX_UPLOAD_SIZE_BYTES` can only lower it, never raise it.
   *
   * Part 41 added `processor.maximumInputBytes` so the operator-configurable
   * `MAX_IMAGE_UPLOAD_BYTES` reaches the parser, which is the only place an
   * oversize upload can be refused with a clean 413 before bytes are buffered.
   * The shared contract's static ceiling and the generic transport ceiling both
   * still apply — every source can only lower the result.
   */
  get maximumImageUploadBytes(): number {
    return Math.min(
      this.processor.maximumInputBytes,
      MAX_IMAGE_UPLOAD_BYTES,
      this.security.maximumUploadBytes,
    );
  }

  /**
   * ADR 0005 four-step upload. `file.upload` is authorized against the TARGET
   * NOTE, so a viewer or a revoked share can never attach to it.
   */
  async uploadImage(input: UploadImageInput): Promise<AttachmentUploadResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "file.upload",
      resource: { kind: "note", id: input.noteId },
      requestId: input.requestId,
    });

    const sniffed = sniffImageMediaType(input.buffer.subarray(0, IMAGE_SIGNATURE_HEAD_BYTES));
    if (sniffed === null || !this.processor.supports(sniffed)) {
      // Refused before any row exists, so an unsupported format never leaves a
      // `failed` row behind for the sweeper to reconcile.
      throw new ApiHttpException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, {
        code: "UNPROCESSABLE_ENTITY",
        message: "The uploaded file is not a supported image.",
      });
    }
    const names = sanitizeAttachmentFilename(input.declaredFilename, sniffed);

    return this.authorizationEntry.run(operation, async () => {
      const attachmentId = randomUUID();
      const originalKey = buildAttachmentObjectKey({
        workspaceId: input.workspaceId,
        attachmentId,
        variant: "original",
        extension: attachmentObjectExtension(sniffed),
      });
      const idempotency = createApiIdempotencyIdentity({
        actorUserId: input.principal.userId,
        operation: `attachment.upload:${input.workspaceId}`,
        key: input.idempotencyKey,
        payload: {
          noteId: input.noteId,
          sizeBytes: input.buffer.byteLength,
          contentHash: createHash("sha256").update(input.buffer).digest("hex"),
        },
      });

      // --- tx1: durable intent. Commits before a single byte is written. ---
      const reserved = await this.database.transaction(async (tx) => {
        await lockApiIdempotency(tx, idempotency);
        const replay = await loadApiIdempotency(tx, idempotency);
        if (replay !== null) {
          assertIdempotencyPayload(replay, idempotency);
          return { replayOf: replay.resourceId } as const;
        }
        await this.readNote(tx, input.noteId);
        await this.reserveQuota(tx, input.buffer.byteLength);
        const values = assertWorkspaceInsertValues(
          {
            id: attachmentId,
            noteId: input.noteId,
            workspaceId: activeWorkspaceId(this.tenantContext),
            originalName: names.originalName,
            filename: names.filename,
            mimeType: sniffed,
            sizeBytes: input.buffer.byteLength,
            storageKey: originalKey,
            mediaType: "image" as const,
            processingStatus: "pending" as const,
            variants: {} satisfies AttachmentVariantRecord,
            createdById: input.principal.userId,
          },
          this.tenantContext,
          "attachment.upload",
        );
        await tx.insert(attachments).values(values);
        await this.writeAudit(tx, "uploadStarted", attachmentId, input, {
          sizeBytes: input.buffer.byteLength,
          mimeType: sniffed,
        });
        await storeApiIdempotency(tx, idempotency, attachmentId);
        return { replayOf: null } as const;
      });

      if (reserved.replayOf !== null) {
        return Object.freeze({ attachment: await this.readMedia(reserved.replayOf) });
      }

      // --- tx1b: the state becomes observable while bytes are in flight. ---
      await this.setStatus(attachmentId, "processing");

      const written: string[] = [];
      try {
        // --- Step 2: bytes. No transaction is open across this boundary. ---
        const processed = await this.processor.process({ buffer: input.buffer, sniffed });
        const variants: Record<string, unknown> = {};
        for (const object of processed.objects) {
          const key =
            object.variant === "original"
              ? originalKey
              : buildAttachmentObjectKey({
                  workspaceId: input.workspaceId,
                  attachmentId,
                  variant: object.variant,
                  extension: attachmentObjectExtension(object.mimeType),
                });
          await this.objects.putObject(ATTACHMENTS_BUCKET, key, object.body, {
            contentType: object.mimeType,
            contentLength: object.body.byteLength,
            cacheControl: CONTENT_CACHE_CONTROL,
          });
          written.push(key);
          variants[object.variant] = {
            key,
            width: object.width,
            height: object.height,
            bytes: object.body.byteLength,
            mimeType: object.mimeType,
          } satisfies AttachmentVariantObject;
        }
        if (processed.blur !== null) variants.blur = processed.blur;
        const record = variants as AttachmentVariantRecord;

        // --- tx3: ready + audit + outbox intent, atomically. ---
        await this.database.transaction(async (tx) => {
          await tx
            .update(attachments)
            .set({
              processingStatus: "ready",
              processingError: null,
              width: processed.width,
              height: processed.height,
              variants: record,
            })
            .where(
              and(
                eq(attachments.id, attachmentId),
                whereWorkspace(attachments, this.tenantContext),
              ),
            );
          await this.recordMutation(tx, "created", attachmentId, input, {
            sizeBytes: input.buffer.byteLength,
            mimeType: sniffed,
          });
        });
      } catch (error: unknown) {
        await this.compensate(attachmentId, input, written, error);
      }

      return Object.freeze({ attachment: await this.readMedia(attachmentId) });
    });
  }

  /**
   * Metadata for every live attachment on a note; object keys are stripped.
   *
   * Authorized as `note.read`, not `file.read`: the central policy's
   * `RESOURCE_KINDS_BY_ACTION` table binds `file.read` to a `file` resource, and
   * this route addresses a note. Listing a note's attachments is exactly "read
   * this note", so the note action is both permitted and semantically correct.
   */
  async listForNote(input: ListNoteAttachmentsInput): Promise<AttachmentListResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "note.read",
      resource: { kind: "note", id: input.noteId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const rows = await this.database.db
        .select(this.selection())
        .from(attachments)
        .where(
          and(
            eq(attachments.noteId, input.noteId),
            inArray(attachments.processingStatus, ["pending", "processing", "ready"]),
            whereWorkspace(attachments, this.tenantContext),
          ),
        )
        .orderBy(asc(attachments.createdAt), asc(attachments.id));
      return Object.freeze({ items: Object.freeze(rows.map((row) => this.toMedia(row))) });
    });
  }

  /**
   * Resolve one servable variant to a byte stream. The database record — not the
   * object key — is the authority: a caller who somehow knows a valid key still
   * gets 404 unless a `ready` row for it exists in their workspace.
   */
  async readContent(input: ReadAttachmentContentInput): Promise<AttachmentContent> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "file.read",
      resource: { kind: "file", id: input.attachmentId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const row = await this.readRow(input.attachmentId);
      if (row.processingStatus !== "ready") return this.notFound();
      const variant = this.resolveVariant(row.variants, input.variant);
      if (variant === null) return this.notFound();
      // Storage being switched off is an OPERATOR condition, not a caller
      // mistake: surface it as a stable 503 rather than letting the raw
      // `ObjectStorageDisabledError` escape as an anonymous 500. The write path
      // already maps this to the `storage_unavailable` processing code; this is
      // the matching treatment for the read path.
      const stat = await this.readStorage(() =>
        this.objects.statObject(ATTACHMENTS_BUCKET, variant.key),
      );
      // A clean 404 beats a stream that dies mid-response.
      if (stat === null) return this.notFound();
      const stream = await this.readStorage(() =>
        this.objects.getObjectStream(ATTACHMENTS_BUCKET, variant.key),
      );
      return Object.freeze({
        stream,
        mimeType: variant.mimeType,
        contentLength: stat.size,
        etag: stat.etag,
        filename: row.filename,
      });
    });
  }

  /**
   * Mark the record unavailable and record deletion intent in ONE transaction;
   * remove objects only after that commit, idempotently.
   */
  async delete(input: AttachmentSelectorInput): Promise<AttachmentDeleteResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "file.delete",
      resource: { kind: "file", id: input.attachmentId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const keys = await this.database.transaction(async (tx) => {
        const row = await this.readRow(input.attachmentId, tx);
        const deleted = await tx
          .delete(attachments)
          .where(
            and(
              eq(attachments.id, input.attachmentId),
              whereWorkspace(attachments, this.tenantContext),
            ),
          )
          .returning({ id: attachments.id });
        if (deleted.length !== 1) return this.notFound();
        await this.recordMutation(tx, "deleted", input.attachmentId, input);
        return this.variantKeys(row.variants);
      });
      await this.objects.removeObjects(ATTACHMENTS_BUCKET, keys);
      return Object.freeze({ id: input.attachmentId, deleted: true as const });
    });
  }

  /**
   * Serialize concurrent uploads for one workspace on the workspace row, then
   * derive usage from the attachment rows themselves. `pending`/`processing`
   * rows ARE the reservation, which is why no `storage_used_bytes` column is
   * needed and no reservation can be lost by a crash.
   */
  private async reserveQuota(tx: DatabaseTransaction, additionalBytes: number): Promise<void> {
    const [workspace] = await tx
      .select({ limit: workspaces.storageLimitBytes })
      .from(workspaces)
      .where(eq(workspaces.id, activeWorkspaceId(this.tenantContext)))
      .limit(1)
      .for("update");
    if (workspace === undefined) return this.notFound();

    const [usage] = await tx
      .select({ used: sql<number>`coalesce(sum(${attachments.sizeBytes}), 0)::bigint` })
      .from(attachments)
      .where(
        and(
          inArray(attachments.processingStatus, ["pending", "processing", "ready"]),
          whereWorkspace(attachments, this.tenantContext),
        ),
      );
    const used = Number(usage?.used ?? 0);
    const limit = Math.min(
      workspace.limit ?? this.security.maximumWorkspaceStorageBytes,
      this.security.maximumWorkspaceStorageBytes,
    );
    if (used + additionalBytes > limit) {
      throw new ApiHttpException(HttpStatus.PAYLOAD_TOO_LARGE, {
        code: "PAYLOAD_TOO_LARGE",
        message: "The workspace storage quota is exhausted.",
      });
    }
  }

  private async readNote(tx: DatabaseTransaction, noteId: string): Promise<void> {
    const [note] = await tx
      .select({ id: notes.id })
      .from(notes)
      .where(
        and(
          eq(notes.id, noteId),
          eq(notes.isDeleted, false),
          whereWorkspace(notes, this.tenantContext),
        ),
      )
      .limit(1);
    if (note === undefined) this.notFound();
  }

  private async setStatus(attachmentId: string, status: AttachmentStatus): Promise<void> {
    await this.database.db
      .update(attachments)
      .set({ processingStatus: status })
      .where(
        and(eq(attachments.id, attachmentId), whereWorkspace(attachments, this.tenantContext)),
      );
  }

  /**
   * ADR 0005 step 4. Commit the failed state FIRST, then best-effort remove the
   * objects already written. Cleanup failures are logged and swallowed: the row
   * is already terminal and Part 45's sweeper is the backstop.
   */
  private async compensate(
    attachmentId: string,
    input: UploadImageInput,
    written: readonly string[],
    error: unknown,
  ): Promise<never> {
    const code = this.failureCode(error);
    await this.database.transaction(async (tx) => {
      await tx
        .update(attachments)
        .set({ processingStatus: "failed", processingError: code })
        .where(
          and(eq(attachments.id, attachmentId), whereWorkspace(attachments, this.tenantContext)),
        );
      await this.writeAudit(tx, "uploadFailed", attachmentId, input, { reason: code });
    });
    await this.objects.removeObjects(ATTACHMENTS_BUCKET, written);
    this.logger.warn("Attachment upload failed; objects scheduled for cleanup");
    throw error instanceof ApiHttpException
      ? error
      : new ApiHttpException(HttpStatus.UNPROCESSABLE_ENTITY, {
          code: "UNPROCESSABLE_ENTITY",
          message: "The uploaded image could not be processed.",
        });
  }

  private failureCode(error: unknown): AttachmentProcessingErrorCode {
    if (error instanceof ImageProcessingError) return error.code;
    return ATTACHMENT_PROCESSING_ERRORS.storageUnavailable;
  }

  private resolveVariant(
    record: AttachmentVariantRecord | null,
    requested: AttachmentServableVariant,
  ): AttachmentVariantObject | null {
    if (record === null) return null;
    for (const name of ATTACHMENT_VARIANT_FALLBACKS[requested]) {
      const candidate = record[name];
      if (candidate !== undefined) return candidate;
    }
    return null;
  }

  /** Every object this row owns, including a Part 44 generic-file preview, so
   * deletion cleanup never strands bytes. */
  private variantKeys(record: AttachmentVariantRecord | null): readonly string[] {
    if (record === null) return [];
    const names = ["original", "full", "medium", "thumbnail", "preview"] as const;
    return names
      .map((name) => record[name]?.key)
      .filter((key): key is string => typeof key === "string");
  }

  private async readRow(attachmentId: string, tx?: DatabaseTransaction): Promise<AttachmentRow> {
    const [row] = await (tx ?? this.database.db)
      .select(this.selection())
      .from(attachments)
      .where(and(eq(attachments.id, attachmentId), whereWorkspace(attachments, this.tenantContext)))
      .limit(1);
    if (row === undefined) return this.notFound();
    return row;
  }

  private async readMedia(attachmentId: string): Promise<AttachmentMedia> {
    return this.toMedia(await this.readRow(attachmentId));
  }

  private selection() {
    return {
      id: attachments.id,
      workspaceId: attachments.workspaceId,
      noteId: attachments.noteId,
      originalName: attachments.originalName,
      filename: attachments.filename,
      mimeType: attachments.mimeType,
      sizeBytes: attachments.sizeBytes,
      mediaType: attachments.mediaType,
      processingStatus: attachments.processingStatus,
      variants: attachments.variants,
      width: attachments.width,
      height: attachments.height,
      createdById: attachments.createdById,
      createdAt: attachments.createdAt,
    };
  }

  /** Wire projection. `variants[*].key` is stripped here and nowhere else. */
  private toMedia(row: AttachmentRow): AttachmentMedia {
    const record = row.variants ?? {};
    const variants: Record<string, unknown> = {};
    for (const name of ["original", "full", "medium", "thumbnail"] as const) {
      const object = record[name];
      if (object === undefined) continue;
      variants[name] = {
        width: object.width > 0 ? object.width : null,
        height: object.height > 0 ? object.height : null,
        bytes: object.bytes,
        mimeType: object.mimeType,
      };
    }
    if (record.blur !== undefined) variants.blur = record.blur;
    return Object.freeze({
      id: row.id,
      workspaceId: row.workspaceId,
      noteId: row.noteId,
      displayName: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      status: row.processingStatus,
      width: row.width,
      height: row.height,
      createdAt: row.createdAt.toISOString(),
      mediaType: row.mediaType,
      variants: Object.freeze(variants) as AttachmentVariantSet,
      contentPath: `/api/v1/workspaces/${row.workspaceId}/attachments/${row.id}/content`,
    });
  }

  private async writeAudit(
    tx: DatabaseTransaction,
    action: keyof typeof ATTACHMENT_AUDIT_ACTIONS,
    attachmentId: string,
    input: ScopedInput,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      workspaceId: activeWorkspaceId(this.tenantContext),
      userId: input.principal.userId,
      action: ATTACHMENT_AUDIT_ACTIONS[action],
      entityType: ATTACHMENT_AUDIT_ENTITY_TYPE,
      entityId: attachmentId,
      metadata,
      requestId: input.requestId ?? null,
    });
  }

  /** Audit row and identifier-only outbox intent in the caller's transaction. */
  private async recordMutation(
    tx: DatabaseTransaction,
    mutation: AttachmentMutation,
    attachmentId: string,
    input: ScopedInput,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.writeAudit(
      tx,
      mutation === "created" ? "uploadCompleted" : "delete",
      attachmentId,
      input,
      metadata,
    );
    const intentId = randomUUID();
    const eventName = ATTACHMENT_DOMAIN_EVENTS[mutation];
    const payload: JobOutboxPayload = Object.freeze({
      action: eventName,
      intentId,
      workspaceId: activeWorkspaceId(this.tenantContext),
      resourceIds: Object.freeze([attachmentId]),
      actorId: input.principal.userId,
    });
    await tx.insert(jobOutbox).values({
      id: intentId,
      workspaceId: activeWorkspaceId(this.tenantContext),
      queueName: ATTACHMENT_DOMAIN_EVENT_QUEUE,
      jobType: eventName,
      payloadVersion: ATTACHMENT_DOMAIN_EVENT_PAYLOAD_VERSION,
      payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      idempotencyKey: `${ATTACHMENT_DOMAIN_EVENT_IDEMPOTENCY_PREFIX}${eventName}:${attachmentId}:${intentId}`,
      correlationId: input.requestId ?? null,
    });
  }

  /**
   * Runs a storage read, converting "object storage is not configured" into a
   * stable 503. Every other storage error keeps propagating untouched, so a
   * genuine fault is never disguised as a clean unavailability.
   */
  private async readStorage<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error: unknown) {
      if (error instanceof ObjectStorageDisabledError) {
        throw new ApiHttpException(HttpStatus.SERVICE_UNAVAILABLE, {
          code: "SERVICE_UNAVAILABLE",
          message: "Attachment storage is unavailable.",
        });
      }
      throw error;
    }
  }

  /** One shared shape for "absent" and "not yours" — no existence leak. */
  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
  }
}
