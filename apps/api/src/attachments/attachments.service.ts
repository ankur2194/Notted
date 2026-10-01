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
import {
  ATTACHMENT_INLINE_MIME_TYPES,
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MAX_IMAGE_UPLOAD_BYTES,
  documentReferencesAttachment,
  attachmentMimeTypeSchema,
} from "@notted/shared-validators";
import { and, asc, eq, inArray } from "drizzle-orm";

import { recordAudit } from "../audit/audit-record";
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
import { AUTH_CONFIG, type AuthConfig } from "../config/auth.config";
import { SECURITY_CONFIG, type SecurityConfig } from "../config/security.config";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import {
  attachments,
  jobOutbox,
  notePublicLinks,
  notes,
  type AttachmentVariantObject,
  type AttachmentVariantRecord,
  type JobOutboxPayload,
} from "../database/schema";
import {
  ObjectStorageDisabledError,
  ObjectStorageService,
  type ObjectStore,
} from "../infrastructure/minio/object-storage.service";
import { hashPublicLinkToken, PUBLIC_LINK_TOKEN_PATTERN } from "../notes/note-public-link-token";
import { NoteSearchIndexProducer } from "../search/note-search-index-producer";
import { StorageQuotaService } from "../storage/storage-quota.service";
import {
  activeWorkspaceId,
  assertWorkspaceInsertValues,
  TenantContextService,
  whereWorkspace,
} from "../tenant";

import { attachmentObjectKeys } from "./attachment-object-keys";
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
import {
  originalAttachmentObjectExtension,
  sanitizeAttachmentFilename,
  sanitizeFileAttachmentFilename,
} from "./filename";
import { IMAGE_PROCESSOR, ImageProcessingError, type ImageProcessor } from "./image-processing";
import { IMAGE_SIGNATURE_HEAD_BYTES, sniffImageMediaType } from "./image-signature";

import type {
  AttachmentDeleteResult,
  AttachmentListResult,
  AttachmentMedia,
  AttachmentMediaType,
  AttachmentServableVariant,
  AttachmentStatus,
  AttachmentUploadResult,
  AttachmentVariantSet,
  AuthenticatedPrincipal,
} from "@notted/shared-types";
import type { Readable } from "node:stream";

const ATTACHMENTS_BUCKET = "attachments" as const;

/** Attachments returned for one note. Reported via `truncated`, never silent. */
const MAX_NOTE_ATTACHMENTS_RETURNED = 200;
/** Keys are random and immutable, so a rendition can be cached indefinitely. */
const CONTENT_CACHE_CONTROL = "private, max-age=31536000, immutable";

/** MIME is descriptive metadata, never a generic-file admission or read gate. */
function descriptiveMimeType(value: string): string {
  const parsed = attachmentMimeTypeSchema.safeParse(value);
  return parsed.success ? parsed.data.toLowerCase() : "application/octet-stream";
}

const SERVABLE_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set<string>(
  ATTACHMENT_INLINE_MIME_TYPES,
);

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

/**
 * Part 44. Structurally identical to {@link UploadImageInput} — one multipart
 * part, one note, one idempotency key — because the two paths share the whole
 * ADR 0005 saga and differ only in what happens between "bytes arrived" and
 * "objects written". Kept as a separate type so a caller cannot accidentally
 * pass an image input to the file path or vice versa.
 */
export interface UploadFileInput extends ScopedInput {
  readonly noteId: string;
  readonly buffer: Buffer;
  /** Descriptive transport metadata only; invalid MIME falls back to octet-stream. */
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
  /**
   * Part 44. The transport needs this to choose the content disposition: an
   * image rendition may be served `inline`, a generic file never may. It is read
   * from the row rather than inferred from the MIME type, so the decision cannot
   * be flipped by a crafted type string.
   */
  readonly mediaType: AttachmentMediaType;
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
    // Part 45. The quota rules live in one service so the write path here and
    // the read-only usage endpoint can never disagree about what a workspace is
    // allowed to store.
    private readonly quota: StorageQuotaService,
    // Part 51.3. Re-sync the owning note when an attachment reaches `ready`
    // or is deleted so the index's `hasAttachments` flag converges.
    private readonly searchIndexProducer: NoteSearchIndexProducer,
    // Optional in the TypeScript constructor for existing upload-only service
    // fixtures; Nest still resolves this token for the real service instance.
    @Inject(AUTH_CONFIG) private readonly authConfig?: AuthConfig,
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
   * Ceiling for a generic file upload (Part 44).
   *
   * `Notted.md` §6 documents 50 MB per file, which is also the default of
   * `MAX_UPLOAD_SIZE_BYTES`. The same rule as the image ceiling applies and for
   * the same reason: **an operator may lower the effective bound, never raise
   * it.** `MAX_UPLOAD_SIZE_BYTES` accepts up to 2 GiB so that other, future
   * transports can use it; letting that value raise this one would silently
   * grant a per-request 2 GiB buffer.
   */
  get maximumFileUploadBytes(): number {
    return Math.min(MAX_ATTACHMENT_UPLOAD_BYTES, this.security.maximumUploadBytes);
  }

  /**
   * The bound handed to the multipart parser, which must be chosen BEFORE the
   * body is read and therefore before the media type is known.
   *
   * It is the larger of the two, so the pre-transfer `Content-Length` refusal
   * still fires for a genuinely oversize request. The narrower image bound is
   * then re-applied inside `uploadImage` once the bytes have identified
   * themselves — see the guard there. Nothing is buffered that the generic
   * ceiling did not already permit, so this widens no exposure.
   */
  get maximumUploadBytes(): number {
    return Math.max(this.maximumImageUploadBytes, this.maximumFileUploadBytes);
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
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "The uploaded file is not a supported image.",
      });
    }
    // Part 44: the parser now runs at the WIDER generic ceiling, because it has
    // to pick a bound before the media type is known. The image bound is
    // therefore re-applied here, once the bytes have identified themselves —
    // otherwise a 40 MiB payload with a PNG header would reach Sharp.
    if (input.buffer.byteLength > this.maximumImageUploadBytes) {
      throw new ApiHttpException(HttpStatus.PAYLOAD_TOO_LARGE, {
        code: "PAYLOAD_TOO_LARGE",
        message: "The uploaded image is larger than the allowed size.",
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
          // Part 51.3: an attachment reaching `ready` flips the owning note's
          // `hasAttachments` flag in the index. Re-sync that one note.
          await this.searchIndexProducer.scheduleSearchSync(tx, input.workspaceId, [input.noteId], {
            mutation: ATTACHMENT_DOMAIN_EVENTS.created,
            correlationId: input.requestId,
            actorId: input.principal.userId,
          });
        });
      } catch (error: unknown) {
        await this.compensate(attachmentId, input, written, error);
      }

      return Object.freeze({ attachment: await this.readMedia(attachmentId) });
    });
  }

  /**
   * ADR 0005 four-step upload for a generic (non-image) file — Part 44.
   *
   * Deliberately the SAME saga as `uploadImage`, step for step, using the same
   * `reserveQuota`, the same `compensate` ordering, the same idempotency record,
   * and the same audit + outbox intent. Only the middle differs: there is no
   * decoder or type/content check. Exactly one object is written (`original`,
   * the uploaded bytes verbatim), `width`/`height` stay `null`, and no derived variant is produced.
   *
   * Bytes are buffered in memory rather than spooled to a temporary file. The
   * ceiling is `maximumFileUploadBytes` (50 MiB by default), the multipart parser
   * enforces it before *and* during transfer, and a temp file would add a second
   * copy on disk plus a new orphan class to reconcile on every failure path.
   * Streaming straight from the request into `putObject` — the only version
   * worth the complexity — needs a stream-accepting `ObjectStore.putObject`,
   * which is a storage-interface change this part deliberately does not make;
   * see the completion record.
   */
  async uploadFile(input: UploadFileInput): Promise<AttachmentUploadResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "file.upload",
      resource: { kind: "note", id: input.noteId },
      requestId: input.requestId,
    });

    if (input.buffer.byteLength === 0) {
      throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
        code: "VALIDATION_ERROR",
        message: "The uploaded file is empty.",
      });
    }
    const mimeType = descriptiveMimeType(input.declaredMimeType);
    if (input.buffer.byteLength > this.maximumFileUploadBytes) {
      throw new ApiHttpException(HttpStatus.PAYLOAD_TOO_LARGE, {
        code: "PAYLOAD_TOO_LARGE",
        message: "The uploaded file is larger than the allowed size.",
      });
    }
    const names = sanitizeFileAttachmentFilename(input.declaredFilename);

    return this.authorizationEntry.run(operation, async () => {
      const attachmentId = randomUUID();
      const originalKey = buildAttachmentObjectKey({
        workspaceId: input.workspaceId,
        attachmentId,
        variant: "original",
        extension: originalAttachmentObjectExtension(names.filename),
      });
      const idempotency = createApiIdempotencyIdentity({
        actorUserId: input.principal.userId,
        operation: `attachment.upload:${input.workspaceId}`,
        key: input.idempotencyKey,
        payload: {
          kind: "file",
          filename: names.filename,
          mimeType,
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
            mimeType,
            sizeBytes: input.buffer.byteLength,
            storageKey: originalKey,
            mediaType: "file" as const,
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
          mimeType,
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
        await this.objects.putObject(ATTACHMENTS_BUCKET, originalKey, input.buffer, {
          contentType: mimeType,
          contentLength: input.buffer.byteLength,
          cacheControl: CONTENT_CACHE_CONTROL,
        });
        written.push(originalKey);
        const record: AttachmentVariantRecord = {
          original: {
            key: originalKey,
            // A generic file has no pixel dimensions. `0` is the record's
            // "not applicable" value and `toMedia` maps it back to `null`.
            width: 0,
            height: 0,
            bytes: input.buffer.byteLength,
            mimeType,
          },
        };

        // --- tx3: ready + audit + outbox intent, atomically. ---
        await this.database.transaction(async (tx) => {
          await tx
            .update(attachments)
            .set({ processingStatus: "ready", processingError: null, variants: record })
            .where(
              and(
                eq(attachments.id, attachmentId),
                whereWorkspace(attachments, this.tenantContext),
              ),
            );
          await this.recordMutation(tx, "created", attachmentId, input, {
            sizeBytes: input.buffer.byteLength,
            mimeType,
          });
          // Part 51.3: same `hasAttachments` flip as the image ready path.
          await this.searchIndexProducer.scheduleSearchSync(tx, input.workspaceId, [input.noteId], {
            mutation: ATTACHMENT_DOMAIN_EVENTS.created,
            correlationId: input.requestId,
            actorId: input.principal.userId,
          });
        });
      } catch (error: unknown) {
        await this.compensate(
          attachmentId,
          input,
          written,
          error,
          "The uploaded file could not be stored.",
        );
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
        .orderBy(asc(attachments.createdAt), asc(attachments.id))
        // `limit + 1` then slice — the same shape `NoteSharesService.list` uses —
        // so truncation is observed rather than inferred. This list previously
        // had no bound at all.
        .limit(MAX_NOTE_ATTACHMENTS_RETURNED + 1);
      const visible = rows.slice(0, MAX_NOTE_ATTACHMENTS_RETURNED);
      return Object.freeze({
        items: Object.freeze(visible.map((row) => this.toMedia(row))),
        limit: MAX_NOTE_ATTACHMENTS_RETURNED,
        returned: visible.length,
        truncated: rows.length > MAX_NOTE_ATTACHMENTS_RETURNED,
      });
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
      const variant = this.resolveVariant(row.variants, input.variant, row.mediaType);
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
        mimeType: row.mediaType === "file" ? "application/octet-stream" : variant.mimeType,
        contentLength: stat.size,
        etag: stat.etag,
        filename:
          row.mediaType === "file"
            ? sanitizeFileAttachmentFilename(row.originalName || row.filename).filename
            : row.filename,
        mediaType: row.mediaType,
      });
    });
  }

  /** One authoritative lookup per request: token, live note, exact tenant/note
   * attachment, and current persisted document. No storage I/O on any denial.
   * The raw bearer token never leaves this method or enters a log. */
  async readPublicContent(input: {
    readonly token: string;
    readonly attachmentId: string;
  }): Promise<AttachmentContent | null> {
    if (!PUBLIC_LINK_TOKEN_PATTERN.test(input.token)) return null;
    if (this.authConfig === undefined)
      throw new Error("Public link token configuration unavailable");
    const tokenHash = hashPublicLinkToken(input.token, this.authConfig.secret);
    const [row] = await this.database.db
      .select({ attachment: this.selection(), content: notes.content })
      .from(notePublicLinks)
      .innerJoin(
        notes,
        and(
          eq(notes.id, notePublicLinks.noteId),
          eq(notes.workspaceId, notePublicLinks.workspaceId),
        ),
      )
      .innerJoin(
        attachments,
        and(
          eq(attachments.id, input.attachmentId),
          eq(attachments.noteId, notes.id),
          eq(attachments.workspaceId, notes.workspaceId),
        ),
      )
      .where(
        and(
          eq(notePublicLinks.tokenHash, tokenHash),
          eq(notes.isDeleted, false),
          eq(attachments.processingStatus, "ready"),
        ),
      )
      .limit(1);
    if (row === undefined) return null;
    const attachment = row.attachment;
    if (!documentReferencesAttachment(row.content, attachment.id, attachment.mediaType))
      return null;
    const variant = this.resolveVariant(attachment.variants, "full", attachment.mediaType);
    if (variant === null) return null;
    if (attachment.mediaType === "image" && !SERVABLE_IMAGE_MIME_TYPES.has(variant.mimeType))
      return null;
    const stat = await this.readStorage(() =>
      this.objects.statObject(ATTACHMENTS_BUCKET, variant.key),
    );
    if (stat === null) return null;
    let stream: Readable;
    try {
      stream = await this.readStorage(() =>
        this.objects.getObjectStream(ATTACHMENTS_BUCKET, variant.key),
      );
    } catch (error: unknown) {
      // The object may disappear after stat (cleanup or concurrent deletion).
      // Only a known object-absence error gets the same 404 as a missing stat;
      // operator/storage failures remain visible as failures, not denial.
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        ["NoSuchKey", "NotFound", "NoSuchObject", "ResourceNotFound"].includes(String(error.code))
      )
        return null;
      throw error;
    }
    return Object.freeze({
      stream,
      mimeType: attachment.mediaType === "file" ? "application/octet-stream" : variant.mimeType,
      contentLength: stat.size,
      etag: stat.etag,
      filename:
        attachment.mediaType === "file"
          ? sanitizeFileAttachmentFilename(attachment.originalName || attachment.filename).filename
          : attachment.filename,
      mediaType: attachment.mediaType,
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
        // Part 51.3: capture the owning note id BEFORE the row is deleted so
        // the sync intent can target it. After the delete, the link is gone
        // and the note's `hasAttachments` flag must be re-derived by the
        // handler's authoritative read.
        const owningNoteId = row.noteId;
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
        await this.searchIndexProducer.scheduleSearchSync(tx, input.workspaceId, [owningNoteId], {
          mutation: ATTACHMENT_DOMAIN_EVENTS.deleted,
          correlationId: input.requestId,
          actorId: input.principal.userId,
        });
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
   *
   * Part 45 moved the SQL into `StorageQuotaService` so the read-only usage
   * endpoint computes the SAME number this write path enforces. The locking,
   * the charged states, and the 413 are unchanged; the only behavioural
   * difference is that a workspace with `storage_limit_bytes IS NULL` now
   * resolves its PLAN default instead of falling straight through to
   * `MAX_WORKSPACE_STORAGE_BYTES` (which remains an absolute ceiling).
   */
  private reserveQuota(tx: DatabaseTransaction, additionalBytes: number): Promise<void> {
    return this.quota.reserve(tx, additionalBytes);
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
    input: ScopedInput,
    written: readonly string[],
    error: unknown,
    // Part 44: the two upload paths differ only in the wording a caller sees
    // when an unclassified failure is converted into a stable envelope.
    fallbackMessage = "The uploaded image could not be processed.",
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
          message: fallbackMessage,
        });
  }

  private failureCode(error: unknown): AttachmentProcessingErrorCode {
    if (error instanceof ImageProcessingError) return error.code;
    return ATTACHMENT_PROCESSING_ERRORS.storageUnavailable;
  }

  /**
   * Which stored object answers a requested variant.
   *
   * An image walks the Part 40 fallback table, so `thumbnail` degrades to
   * `medium`, then `full`, then `original`.
   *
   * A generic file has exactly ONE stored object and no renditions, so it
   * deliberately does **not** walk that table: only the default `full` request
   * resolves, and an explicit `medium` or `thumbnail` returns `null` and becomes
   * the shared not-found shape. Serving a 40 MiB archive in answer to a request
   * for a thumbnail would be both wasteful and a lie about what came back.
   */
  private resolveVariant(
    record: AttachmentVariantRecord | null,
    requested: AttachmentServableVariant,
    mediaType: AttachmentMediaType,
  ): AttachmentVariantObject | null {
    if (record === null) return null;
    if (mediaType === "file") {
      return requested === "full" ? (record.original ?? null) : null;
    }
    for (const name of ATTACHMENT_VARIANT_FALLBACKS[requested]) {
      const candidate = record[name];
      if (candidate !== undefined) return candidate;
    }
    return null;
  }

  /**
   * Every object this row owns, including a Part 44 generic-file preview, so
   * deletion cleanup never strands bytes.
   *
   * Part 45 moved the list itself into `attachment-object-keys.ts` because the
   * storage-maintenance sweeps must agree with this method exactly; two copies
   * of the variant-name list would strand bytes the first time they diverged.
   */
  private variantKeys(record: AttachmentVariantRecord | null): readonly string[] {
    return attachmentObjectKeys(record);
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
        mimeType: row.mediaType === "file" ? descriptiveMimeType(object.mimeType) : object.mimeType,
      };
    }
    if (record.blur !== undefined) variants.blur = record.blur;
    return Object.freeze({
      id: row.id,
      workspaceId: row.workspaceId,
      noteId: row.noteId,
      displayName:
        row.mediaType === "file"
          ? sanitizeFileAttachmentFilename(row.originalName || row.filename).filename
          : row.filename,
      mimeType: row.mediaType === "file" ? descriptiveMimeType(row.mimeType) : row.mimeType,
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
    await recordAudit(tx, {
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
