// Part 62 — export job lifecycle: the application service.
//
// WHAT LIVES HERE. Every read and every state change of an `exports` row goes
// through this service, so the REST controller, the tRPC router and the
// generation worker share one authority (ADR 0002). The transports own
// authorization and HTTP shape; this file owns the state machine, the
// transaction, and the tenant scope.
//
// THE STATE MACHINE IS ENFORCED IN SQL, NOT IN JAVASCRIPT. Every transition is
// a single conditional UPDATE that carries the expected PRIOR status in its
// `WHERE`. There is no read-then-write, so there is no window in which two
// actors both observe `queued` and both proceed. Zero rows affected therefore
// means "another actor won the race", which is a legitimate outcome reported as
// `null`/`false` — NEVER an exception. A cancel racing a claim, a retried job
// racing a completed one, and a double-delivered BullMQ message all land in
// that branch, and none of them is an error worth waking anybody for.
//
//   queued      -> processing   `claim`
//   processing  -> ready        `markReady`
//   queued|processing -> failed `markFailed`
//   queued|processing -> cancelled `cancel`
//   ready       -> expired      (the Part 45 storage sweep, not this service)
//
// TENANT SCOPE. `exports` is workspace-owned, so every statement applies
// `whereWorkspace(exportJobs, tenantContext)` (ADR 0009). The worker paths
// (`claim`/`markReady`/`markFailed`) must therefore be called from inside
// `tenantContext.run(createTenantContext({ workspaceId }), …)`, exactly like
// every other job handler in this codebase.
//
// WHAT NEVER LEAVES THIS FILE. `object_key` and any signed URL are storage
// addresses, never authority (ADR 0005). `toJob` cannot emit them, and the
// structured logs below carry identifiers and outcomes only — never a key, a
// URL, a note title or a byte of content.

import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import {
  EXPORT_API_PATHS,
  SUPPORTED_EXPORT_FORMATS,
  SUPPORTED_EXPORT_SOURCES,
} from "@notted/shared-types";
import { exportOptionsSchema } from "@notted/shared-validators";
import { and, desc, eq, inArray } from "drizzle-orm";

import { recordAudit } from "../audit/audit-record";
import { ApiHttpException } from "../common/errors/api-http.exception";
import {
  assertIdempotencyPayload,
  createApiIdempotencyIdentity,
  loadApiIdempotency,
  lockApiIdempotency,
  storeApiIdempotency,
} from "../common/idempotency/api-idempotency";
import { StructuredLogger } from "../common/logging/structured-logger.service";
import {
  DatabaseService,
  type Database,
  type DatabaseTransaction,
} from "../database/database.service";
import { exportJobs, notes } from "../database/schema";
import {
  ObjectStorageDisabledError,
  ObjectStorageService,
  type ObjectStore,
} from "../infrastructure/minio/object-storage.service";
import {
  activeWorkspaceId,
  assertActiveWorkspace,
  TenantContextService,
  whereWorkspace,
} from "../tenant";

import { ExportJobProducer } from "./export-job.producer";
import { exportDownloadFilename } from "./export-object-key";
import { EXPORT_FORMAT_MEDIA } from "./export-renderers";

import type {
  AuthenticatedPrincipal,
  ExportFormat,
  ExportJob,
  ExportOptions,
  ExportPage,
  ExportSource,
  ExportStatus,
} from "@notted/shared-types";
import type { ExportOptionsOutput } from "@notted/shared-validators";
import type { Readable } from "node:stream";

/** The bucket is private; see `export-object-key.ts`. */
const EXPORTS_BUCKET = "exports" as const;

/** Notted.md: "Download link expires after 7 days". */
const EXPORT_DOWNLOAD_GRANT_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * ADR 0007 object retention. Deliberately INDEPENDENT of the download grant
 * above even though both are seven days today: the storage-maintenance sweep
 * consumes this one to delete bytes and flip the row to `expired`, while the
 * grant only decides whether a new download may start. Collapsing them into one
 * constant would silently couple two lifecycles that ADR 0007 splits on purpose.
 */
const EXPORT_OBJECT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/** Statuses a generation may still be taken away from. */
const CANCELLABLE_STATUSES = ["queued", "processing"] as const;

type ExportRow = typeof exportJobs.$inferSelect;
type ExportQueryRunner = Database | DatabaseTransaction;

export interface CreateExportServiceInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly format: ExportFormat;
  readonly sourceType: ExportSource;
  readonly sourceId: string | null;
  readonly options: ExportOptionsOutput;
  readonly idempotencyKey: string;
  readonly correlationId?: string | null;
}

export interface ListExportsServiceInput {
  readonly workspaceId: string;
  readonly requestedById: string;
  readonly page: number;
  readonly limit: number;
  readonly status?: ExportStatus;
}

export interface ExportSelector {
  readonly workspaceId: string;
  readonly exportId: string;
}

/** What the worker needs to generate. Identifier + options only. */
export interface ExportClaim {
  readonly id: string;
  readonly workspaceId: string;
  readonly requestedById: string;
  readonly format: ExportFormat;
  readonly sourceType: ExportSource;
  readonly sourceId: string | null;
  readonly options: ExportOptions;
}

export interface MarkExportReadyInput extends ExportSelector {
  readonly objectKey: string;
  readonly byteLength: number;
}

export interface MarkExportFailedInput extends ExportSelector {
  /** Machine-readable, from a CLOSED set. Never an exception message. */
  readonly errorCode: ExportFailureCode;
}

export type ExportFailureCode =
  | "source_unavailable"
  | "source_forbidden"
  | "format_unsupported"
  | "generation_failed"
  | "storage_unavailable";

/**
 * The ONLY text that may ever reach `exports.error_message`. Exception messages
 * and stack traces routinely quote note titles, object keys, SQL fragments and
 * connection strings, and this column is echoed straight back to the requester
 * — so the mapping is a closed table, not a passthrough. A new failure mode
 * gets a new code and a new sentence here; it never gets `error.message`.
 */
const EXPORT_FAILURE_MESSAGES: Readonly<Record<ExportFailureCode, string>> = Object.freeze({
  source_unavailable: "The item being exported is no longer available.",
  source_forbidden: "You no longer have permission to export this item.",
  format_unsupported: "This export format is not supported yet.",
  generation_failed: "The export could not be generated. Please try again.",
  storage_unavailable: "Export storage is unavailable. Please try again later.",
});

export interface ExportDownloadContent {
  readonly stream: Readable;
  readonly filename: string;
  readonly mimeType: string;
  readonly contentLength: number;
}

@Injectable()
export class ExportService {
  constructor(
    private readonly database: DatabaseService,
    private readonly tenantContext: TenantContextService,
    private readonly producer: ExportJobProducer,
    // Same provider as everywhere else; typed as the narrow `ObjectStore` port
    // so the unit suite can substitute an in-memory double (the exact pattern
    // `AttachmentsService` uses).
    @Inject(ObjectStorageService) private readonly objects: ObjectStore,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Record an export request and its generation intent in ONE transaction
   * (ADR 0006). The row and the outbox intent commit together or not at all, so
   * a `queued` row can never exist with nothing scheduled to claim it.
   */
  async create(input: CreateExportServiceInput): Promise<ExportJob> {
    // Capability gate FIRST, before any SQL: an export we cannot render must
    // never become a queued row that the worker will only fail later. Both
    // checks read the shared arrays, so Parts 63/64 widen support by editing
    // `SUPPORTED_EXPORT_FORMATS` / `SUPPORTED_EXPORT_SOURCES` and adding a
    // renderer case — nothing here changes.
    if (!SUPPORTED_EXPORT_SOURCES.includes(input.sourceType)) {
      // Deliberately the SAME stable code as the format refusal. There is no
      // `EXPORT_SOURCE_UNSUPPORTED` code, and minting one would widen the
      // public `ApiErrorCode` union (and every client switch over it) for a
      // distinction the message already carries. Out of scope for Part 62.
      throw new ApiHttpException(HttpStatus.UNPROCESSABLE_ENTITY, {
        code: "EXPORT_FORMAT_UNSUPPORTED",
        message: `Exporting a ${input.sourceType} is not supported yet.`,
      });
    }
    if (!SUPPORTED_EXPORT_FORMATS.includes(input.format)) {
      throw new ApiHttpException(HttpStatus.UNPROCESSABLE_ENTITY, {
        code: "EXPORT_FORMAT_UNSUPPORTED",
        message: `The ${input.format} export format is not supported yet.`,
      });
    }
    // The shared create schema already enforces this pairing; repeating it is
    // defence in depth for any future caller that assembles the input by hand.
    if (input.sourceId === null) {
      throw new ApiHttpException(HttpStatus.UNPROCESSABLE_ENTITY, {
        code: "VALIDATION_ERROR",
        message: "sourceId is required for this export source.",
      });
    }
    assertActiveWorkspace(input.workspaceId, this.tenantContext, "export.create");

    const identity = createApiIdempotencyIdentity({
      actorUserId: input.principal.userId,
      operation: `export.create:${input.workspaceId}`,
      key: input.idempotencyKey,
      payload: {
        format: input.format,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        options: input.options,
      },
    });

    const row = await this.database.transaction(async (tx) => {
      await lockApiIdempotency(tx, identity);
      const replay = await loadApiIdempotency(tx, identity);
      if (replay !== null) {
        // A replay is a lookup of the ORIGINAL creation, not a second one — no
        // audit row here, or one create request would appear to create twice.
        assertIdempotencyPayload(replay, identity);
        return this.readRow(tx, { workspaceId: input.workspaceId, exportId: replay.resourceId });
      }
      const exportId = randomUUID();
      const [created] = await tx
        .insert(exportJobs)
        .values({
          id: exportId,
          workspaceId: input.workspaceId,
          requestedById: input.principal.userId,
          format: input.format,
          status: "queued",
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          // Store the PARSED options object, so the column can only ever hold a
          // shape every reader understands.
          options: input.options,
        })
        .returning();
      if (created === undefined) {
        throw new ApiHttpException(HttpStatus.INTERNAL_SERVER_ERROR, {
          code: "INTERNAL_SERVER_ERROR",
          message: "The export could not be created.",
        });
      }
      await this.producer.scheduleExportGeneration(tx, {
        workspaceId: input.workspaceId,
        exportId,
        requestedById: input.principal.userId,
        correlationId: input.correlationId,
      });
      await storeApiIdempotency(tx, identity, exportId);
      // Identifiers only — `input.options` never reaches an audit row.
      await recordAudit(tx, {
        workspaceId: activeWorkspaceId(this.tenantContext),
        userId: input.principal.userId,
        action: "export.create",
        entityType: "export",
        entityId: exportId,
        metadata: {
          format: input.format,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
        },
      });
      return created;
    });

    return this.toJob(row);
  }

  /**
   * The requester's OWN exports, newest first. Scoped by workspace AND by
   * `requested_by_id`: an export is a private artefact of one person's request,
   * so workspace membership alone does not make somebody else's visible.
   */
  async list(input: ListExportsServiceInput): Promise<ExportPage> {
    assertActiveWorkspace(input.workspaceId, this.tenantContext, "export.list");
    const offset = (input.page - 1) * input.limit;
    const filter = and(
      whereWorkspace(exportJobs, this.tenantContext),
      eq(exportJobs.requestedById, input.requestedById),
      ...(input.status === undefined ? [] : [eq(exportJobs.status, input.status)]),
    );
    // Bounded: one extra row answers `hasMore` without a second COUNT.
    const rows = await this.database.db
      .select()
      .from(exportJobs)
      .where(filter)
      .orderBy(desc(exportJobs.createdAt), desc(exportJobs.id))
      .limit(input.limit + 1)
      .offset(offset);
    return Object.freeze({
      items: Object.freeze(rows.slice(0, input.limit).map((row) => this.toJob(row))),
      page: input.page,
      limit: input.limit,
      hasMore: rows.length > input.limit,
    });
  }

  async read(input: ExportSelector): Promise<ExportJob> {
    return this.toJob(await this.readRow(this.database.db, input));
  }

  /**
   * `queued|processing -> cancelled`. A row that already settled is returned
   * UNCHANGED rather than refused: the caller asked for "this export must not
   * produce anything", and a finished, failed or already-cancelled row already
   * satisfies that. Throwing here would turn a harmless double-click into an
   * error the UI has to explain.
   */
  async cancel(input: ExportSelector): Promise<ExportJob> {
    // Wrapped in a transaction (the state machine elsewhere in this file
    // deliberately is not) purely so the audit row commits atomically with a
    // real transition, per ADR 0006 — the conditional UPDATE itself needs no
    // transaction of its own.
    return this.database.transaction(async (tx) => {
      const [cancelled] = await tx
        .update(exportJobs)
        .set({ status: "cancelled", completedAt: new Date() })
        .where(and(this.rowScope(input), inArray(exportJobs.status, [...CANCELLABLE_STATUSES])))
        .returning();
      if (cancelled === undefined) {
        // Lost the race (or nothing to cancel, e.g. a double-click): report the
        // row as it actually is and write no audit row — a no-op transition is
        // not an event. `readRow` still 404s for a row outside this workspace,
        // so this branch cannot be used to probe for foreign export ids.
        return this.toJob(await this.readRow(tx, input));
      }
      await recordAudit(tx, {
        workspaceId: activeWorkspaceId(this.tenantContext),
        userId: this.tenantContext.get().userId,
        action: "export.cancel",
        entityType: "export",
        entityId: cancelled.id,
        metadata: {},
      });
      return this.toJob(cancelled);
    });
  }

  /**
   * Stream the bytes of a `ready` export. The DATABASE ROW is the authority:
   * the object key is derived from it and never accepted from a caller, and
   * every gate below is re-evaluated live at download time (ADR 0007).
   */
  async openDownload(input: ExportSelector): Promise<ExportDownloadContent> {
    const row = await this.readRow(this.database.db, input);
    // The authorization policy already refuses a download for a non-`ready`
    // row; this is the defence-in-depth copy that does not depend on it.
    if (row.status !== "ready") {
      throw new ApiHttpException(HttpStatus.CONFLICT, {
        code: "EXPORT_OBJECT_UNAVAILABLE",
        message: "This export is not ready to download.",
      });
    }
    if (row.signedUrlExpiresAt === null || row.signedUrlExpiresAt.getTime() <= Date.now()) {
      throw new ApiHttpException(HttpStatus.CONFLICT, {
        code: "EXPORT_EXPIRED",
        message: "This export download link has expired.",
      });
    }
    const objectKey = row.objectKey;
    if (objectKey === null) {
      throw new ApiHttpException(HttpStatus.CONFLICT, {
        code: "EXPORT_OBJECT_UNAVAILABLE",
        message: "The export file is no longer available.",
      });
    }

    const stat = await this.readStorage(() => this.objects.statObject(EXPORTS_BUCKET, objectKey));
    // A clean refusal beats a stream that dies mid-response. The retention
    // sweep may have deleted the bytes before flipping the row to `expired`.
    if (stat === null) {
      throw new ApiHttpException(HttpStatus.CONFLICT, {
        code: "EXPORT_OBJECT_UNAVAILABLE",
        message: "The export file is no longer available.",
      });
    }
    const media = EXPORT_FORMAT_MEDIA[row.format];
    const stream = await this.readStorage(() =>
      this.objects.getObjectStream(EXPORTS_BUCKET, objectKey),
    );
    // Written only here, after every gate above has passed and the stream is
    // in hand — a refused or unavailable download must never be recorded as a
    // download. No transaction: this read path has none of its own.
    await recordAudit(this.database.db, {
      workspaceId: activeWorkspaceId(this.tenantContext),
      userId: this.tenantContext.get().userId,
      action: "export.download",
      entityType: "export",
      entityId: row.id,
      metadata: { format: row.format },
    });
    return Object.freeze({
      stream,
      filename: exportDownloadFilename(await this.sourceLabel(row), media.fileExtension),
      mimeType: media.mimeType,
      contentLength: stat.size,
    });
  }

  /**
   * `queued -> processing`. `null` when the row was already claimed or settled,
   * which is the normal outcome of a redelivered BullMQ message and of a job
   * that raced a cancellation — both are replays, not failures.
   */
  async claim(input: ExportSelector): Promise<ExportClaim | null> {
    const [claimed] = await this.database.db
      .update(exportJobs)
      .set({ status: "processing" })
      .where(and(this.rowScope(input), eq(exportJobs.status, "queued")))
      .returning();
    if (claimed === undefined) return null;
    return Object.freeze({
      id: claimed.id,
      workspaceId: claimed.workspaceId,
      requestedById: claimed.requestedById,
      format: claimed.format,
      sourceType: claimed.sourceType as ExportSource,
      sourceId: claimed.sourceId,
      options: this.readOptions(claimed.options),
    });
  }

  /** `processing -> ready`. `false` on a lost race (typically a cancellation). */
  async markReady(input: MarkExportReadyInput): Promise<boolean> {
    const now = Date.now();
    const updated = await this.database.db
      .update(exportJobs)
      .set({
        status: "ready",
        objectKey: input.objectKey,
        signedUrlExpiresAt: new Date(now + EXPORT_DOWNLOAD_GRANT_MS),
        objectExpiresAt: new Date(now + EXPORT_OBJECT_RETENTION_MS),
        completedAt: new Date(now),
        errorCode: null,
        errorMessage: null,
      })
      .where(and(this.rowScope(input), eq(exportJobs.status, "processing")))
      .returning({ id: exportJobs.id });
    if (updated.length === 0) {
      // Identifiers and an outcome only — never the object key or the size.
      this.logger.info(
        { workspaceId: input.workspaceId, exportId: input.exportId, outcome: "ready_race_lost" },
        "Export was settled by another actor before it could be marked ready",
      );
      return false;
    }
    return true;
  }

  /** `queued|processing -> failed`. `false` on a lost race. */
  async markFailed(input: MarkExportFailedInput): Promise<boolean> {
    const updated = await this.database.db
      .update(exportJobs)
      .set({
        status: "failed",
        errorCode: input.errorCode,
        // Closed-table lookup. See `EXPORT_FAILURE_MESSAGES`: raw exception text
        // must never reach this column.
        errorMessage: EXPORT_FAILURE_MESSAGES[input.errorCode],
        completedAt: new Date(),
      })
      .where(and(this.rowScope(input), inArray(exportJobs.status, [...CANCELLABLE_STATUSES])))
      .returning({ id: exportJobs.id });
    return updated.length > 0;
  }

  /**
   * Row -> wire shape. Public so the worker can label a notification or an
   * email without a second query.
   */
  toJob(row: ExportRow): ExportJob {
    const grantActive =
      row.signedUrlExpiresAt !== null && row.signedUrlExpiresAt.getTime() > Date.now();
    return Object.freeze({
      id: row.id,
      workspaceId: row.workspaceId,
      requestedById: row.requestedById,
      format: row.format,
      status: row.status,
      sourceType: row.sourceType as ExportSource,
      sourceId: row.sourceId,
      options: this.readOptions(row.options),
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      downloadExpiresAt: row.signedUrlExpiresAt?.toISOString() ?? null,
      // No `objectKey`, no signed URL, ever. The path is login-gated and
      // re-authorized per request; it is only offered while the grant holds.
      downloadPath:
        row.status === "ready" && grantActive
          ? EXPORT_API_PATHS.download(row.workspaceId, row.id)
          : null,
    });
  }

  /**
   * The `where` fragment every single-row statement shares: the id AND the
   * active workspace. Never the id alone.
   */
  private rowScope(input: ExportSelector) {
    // The tenant context is the authority for scoping, but the caller also
    // DECLARES a workspace. Proving they agree turns a caller that passes a
    // mismatched pair (a worker built from the wrong context, a future batch
    // path) into an immediate refusal instead of a statement that silently
    // operates on a different workspace than the caller believes.
    assertActiveWorkspace(input.workspaceId, this.tenantContext, "export");
    return and(eq(exportJobs.id, input.exportId), whereWorkspace(exportJobs, this.tenantContext));
  }

  private async readRow(runner: ExportQueryRunner, input: ExportSelector): Promise<ExportRow> {
    const [row] = await runner.select().from(exportJobs).where(this.rowScope(input)).limit(1);
    if (row === undefined) {
      // One shape for "absent" and "not yours": no cross-workspace existence
      // leak, even though the authorization guard has already run.
      throw new ApiHttpException(HttpStatus.NOT_FOUND, {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      });
    }
    return row;
  }

  /**
   * `options` is `jsonb`, so it arrives as `unknown`. A legacy or hand-edited
   * `{}` row must render a list, not crash it — the schema's defaults are the
   * fallback.
   */
  private readOptions(value: unknown): ExportOptions {
    const parsed = exportOptionsSchema.safeParse(value);
    return Object.freeze(parsed.success ? parsed.data : exportOptionsSchema.parse({}));
  }

  /**
   * Human-readable stem for the download filename, read from the live source.
   * A deleted source is expected and harmless: the export outlives its note
   * (the schema deliberately has no FK on `source_id`), so the artefact stays
   * downloadable under a generic name.
   */
  private async sourceLabel(row: ExportRow): Promise<string> {
    if (row.sourceType !== "note" || row.sourceId === null) return "export";
    const [note] = await this.database.db
      .select({ title: notes.title })
      .from(notes)
      .where(and(eq(notes.id, row.sourceId), whereWorkspace(notes, this.tenantContext)))
      .limit(1);
    return note?.title ?? "export";
  }

  /**
   * Runs a storage read, converting "object storage is not configured" into a
   * stable 503. Every other storage error keeps propagating untouched, so a
   * genuine fault is never disguised as a clean unavailability. Copied from
   * `AttachmentsService#readStorage` so both read paths degrade identically.
   */
  private async readStorage<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error: unknown) {
      if (error instanceof ObjectStorageDisabledError) {
        throw new ApiHttpException(HttpStatus.SERVICE_UNAVAILABLE, {
          code: "SERVICE_UNAVAILABLE",
          message: "Export storage is unavailable.",
        });
      }
      throw error;
    }
  }
}
