// Part 45: the four idempotent storage-maintenance sweeps.
//
// CONTRACT THIS FILE MUST HOLD
// 1. A sweep never deletes anything reachable from a live row. Every deletion is
//    approved by a pure predicate in `storage-maintenance.selection.ts`; the SQL
//    only NARROWS the candidate set, it never authorizes a deletion by itself.
// 2. Two consecutive runs produce the same result. Every sweep's selection
//    predicate is false for the state its own first run leaves behind.
// 3. `dryRun` mutates nothing. There is exactly one `if (dryRun) return` style
//    guard per mutating step and no side effect precedes it.
// 4. Reports carry counts and UUIDs only — never a filename, an object key, a
//    signed URL, or document content (`docs/standards/observability.md`).
//
// ORDERING (ADR 0005): the database is made authoritative FIRST, then objects
// are removed idempotently after commit. A crash in between strands bytes, which
// the orphaned-object sweep reclaims; the reverse order could delete bytes a
// still-live row claims to own.
//
// TWO ENTRY POINTS, TWO AUTHORITIES
// - `runForWorkspace` is a user action. It authorizes `settings.update` through
//   the central policy (owner/admin), then runs every query inside the
//   authorized tenant context using `whereWorkspace`, so a missing or wrong
//   scope fails closed.
// - `runSystemSweeps` is explicitly modelled system maintenance (ADR 0006). It
//   runs with NO tenant context and deliberately crosses workspaces, which is
//   the exception `TenantContextService.tryGet` documents for Part 45. It is
//   unreachable from any transport; only the scheduler and the report CLI call it.

import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNotNull, lte, ne, or, sql, type SQL } from "drizzle-orm";

import { attachmentObjectKeys } from "../attachments/attachment-object-keys";
import { parseAttachmentObjectKey } from "../attachments/attachment-storage-key";
import { ATTACHMENT_PROCESSING_ERRORS } from "../attachments/attachments.constants";
import { recordAudit } from "../audit/audit-record";
import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { StructuredLogger } from "../common/logging/structured-logger.service";
import { RETENTION_CONFIG, type RetentionConfig } from "../config/retention.config";
import { STORAGE_CONFIG, type StorageConfig } from "../config/storage.config";
import { DatabaseService } from "../database/database.service";
import { attachments, exportJobs, notes, workspaces } from "../database/schema";
import {
  ObjectStorageService,
  type ObjectStore,
} from "../infrastructure/minio/object-storage.service";
import {
  activeWorkspaceId,
  TenantContextService,
  whereWorkspace,
  type WorkspaceScopedTable,
} from "../tenant";

import {
  STORAGE_MAINTENANCE_AUDIT_ACTION,
  STORAGE_MAINTENANCE_AUDIT_ENTITY_TYPE,
  STORAGE_MAINTENANCE_NOTES,
} from "./maintenance.constants";
import {
  decideAbandonedUpload,
  decideExportSweep,
  decideOrphanObject,
  shouldMarkMissingObject,
  shouldPurgeDeletedNote,
  SweepAccumulator,
  type DeletedNoteRetentionWindows,
  type ObjectOwnerFacts,
  type SweepWindows,
} from "./storage-maintenance.selection";

import type {
  AuthenticatedPrincipal,
  StorageMaintenanceReport,
  StorageMaintenanceSweepReport,
} from "@notted/shared-types";

const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

/** The attachment key family's fixed root segment (`w/{workspaceId}/a/...`). */
const ATTACHMENT_KEY_ROOT = "w/";

export type MaintenanceScope =
  { readonly kind: "workspace"; readonly workspaceId: string } | { readonly kind: "system" };

export interface RunWorkspaceMaintenanceInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly dryRun: boolean;
  readonly requestId?: string | null;
}

interface SweepContext {
  readonly scope: MaintenanceScope;
  readonly dryRun: boolean;
  readonly windows: SweepWindows;
}

@Injectable()
export class StorageMaintenanceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
    @Inject(ObjectStorageService) private readonly objects: ObjectStore,
    @Inject(RETENTION_CONFIG) private readonly retention: RetentionConfig,
    @Inject(STORAGE_CONFIG) private readonly storage: StorageConfig,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Administrative cleanup for ONE workspace, on behalf of a user.
   *
   * Authorized as `settings.update` against the `settings` resource. That action
   * already means owner/admin in the central policy — editors and viewers are
   * denied explicitly — so the endpoint gets the required role gate without
   * inventing a bespoke role check or a new action the policy has never seen.
   */
  async runForWorkspace(input: RunWorkspaceMaintenanceInput): Promise<StorageMaintenanceReport> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "settings.update",
      resource: { kind: "settings" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      // Read the id back out of the ACTIVE context rather than reusing the
      // request parameter, so every sweep below is scoped by the value the
      // authorization layer established.
      const scope: MaintenanceScope = {
        kind: "workspace",
        workspaceId: activeWorkspaceId(this.tenantContext),
      };
      const report = await this.run(scope, input.dryRun);
      await this.writeAudit(input, report);
      return report;
    });
  }

  /**
   * Cross-workspace maintenance under system authority. No transport reaches
   * this; the scheduler and the dry-run report CLI are the only callers.
   */
  runSystemSweeps(options: { readonly dryRun: boolean }): Promise<StorageMaintenanceReport> {
    return this.run({ kind: "system" }, options.dryRun);
  }

  private async run(scope: MaintenanceScope, dryRun: boolean): Promise<StorageMaintenanceReport> {
    const startedAt = new Date();
    const context: SweepContext = {
      scope,
      dryRun,
      windows: {
        now: startedAt,
        abandonedUploadMs: this.storage.abandonedUploadHours * HOUR_MS,
        orphanWindowMs: this.retention.orphanedObjectCleanupDays * DAY_MS,
      },
    };

    const sweeps: StorageMaintenanceSweepReport[] = [
      await this.sweepAbandonedUploads(context),
      await this.sweepOrphans(context),
      await this.sweepExpiredExports(context),
      await this.sweepDeletedNotes(context),
    ];

    const report = Object.freeze({
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      dryRun,
      scope: scope.kind,
      sweeps: Object.freeze(sweeps),
    });
    for (const sweep of sweeps) {
      this.logger.info(
        {
          sweep: sweep.sweep,
          scope: scope.kind,
          dryRun,
          examined: sweep.examined,
          selected: sweep.selected,
          rowsRemoved: sweep.rowsRemoved,
          rowsMarked: sweep.rowsMarked,
          objectsRemoved: sweep.objectsRemoved,
          truncated: sweep.truncated,
        },
        "Storage maintenance sweep completed",
      );
    }
    return report;
  }

  /* ---------------------------------------------------------------------- */
  /* Sweep 1 — abandoned uploads                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Reclaim attachment rows that reserved quota and never became content.
   *
   * Plan Part 45 calls this "abandoned multipart uploads". This API issues no S3
   * multipart upload — both upload paths buffer the payload and make a single
   * `putObject` call — so the equivalent abandoned state is a row stuck in
   * `pending`/`processing`, plus terminal `failed` rows past the ADR 0005 grace
   * period. Reclaiming them is what returns their reserved bytes to the
   * workspace quota.
   *
   * Idempotent by construction: the rows it deletes are the only rows it
   * selects, so a second pass selects nothing.
   */
  private async sweepAbandonedUploads(
    context: SweepContext,
  ): Promise<StorageMaintenanceSweepReport> {
    const accumulator = new SweepAccumulator("abandonedUploads");
    const limit = this.storage.maintenanceBatchLimit;
    const abandonedBefore = new Date(
      context.windows.now.getTime() - context.windows.abandonedUploadMs,
    );
    const orphanBefore = new Date(context.windows.now.getTime() - context.windows.orphanWindowMs);

    const candidates = await this.database.db
      .select({
        id: attachments.id,
        status: attachments.processingStatus,
        createdAt: attachments.createdAt,
        processingError: attachments.processingError,
        storageKey: attachments.storageKey,
        variants: attachments.variants,
      })
      .from(attachments)
      .where(
        and(
          // A `ready` row is excluded in SQL as well as in the predicate. Two
          // independent guards, because this is the one clause whose failure
          // would destroy live content.
          ne(attachments.processingStatus, "ready"),
          or(
            and(
              inArray(attachments.processingStatus, ["pending", "processing"]),
              lte(attachments.createdAt, abandonedBefore),
            ),
            and(
              eq(attachments.processingStatus, "failed"),
              // A row sweep 2 marked because its bytes vanished is the user's
              // record of that loss, and its grace period was already spent
              // when it was marked (both windows run from `created_at`).
              // Mirrored in `decideAbandonedUpload`, which explains why.
              // `is distinct from` rather than `<>`: a `failed` row with a NULL
              // `processing_error` must still be swept, and `<>` is NULL there.
              sql`${attachments.processingError} is distinct from ${ATTACHMENT_PROCESSING_ERRORS.storageObjectMissing}`,
              lte(attachments.createdAt, orphanBefore),
            ),
          ),
          this.workspacePredicate(attachments, context.scope),
        ),
      )
      .orderBy(asc(attachments.createdAt), asc(attachments.id))
      .limit(limit + 1);

    accumulator.truncated = candidates.length > limit;
    const batch = candidates.slice(0, limit);
    accumulator.examined = batch.length;

    const removableIds: string[] = [];
    const removableKeys = new Set<string>();
    for (const candidate of batch) {
      const decision = decideAbandonedUpload(candidate, context.windows);
      if (!decision.sweep) continue;
      accumulator.selected += 1;
      accumulator.sample(candidate.id);
      removableIds.push(candidate.id);
      for (const key of attachmentObjectKeys(candidate.variants, candidate.storageKey)) {
        removableKeys.add(key);
      }
    }
    if (context.dryRun || removableIds.length === 0) return accumulator.finish();

    // Database first, objects afterwards (ADR 0005). The `whereWorkspace`
    // predicate is repeated on the delete so a scoped run can never widen.
    await this.database.transaction(async (tx) => {
      const removed = await tx
        .delete(attachments)
        .where(
          and(
            inArray(attachments.id, removableIds),
            ne(attachments.processingStatus, "ready"),
            this.workspacePredicate(attachments, context.scope),
          ),
        )
        .returning({ id: attachments.id });
      accumulator.rowsRemoved = removed.length;
    });
    accumulator.objectsRemoved = await this.removeObjects("attachments", [...removableKeys]);
    return accumulator.finish();
  }

  /* ---------------------------------------------------------------------- */
  /* Sweep 2 — orphaned objects and rows                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Reconcile bytes against rows in both directions, and report the one class
   * this part deliberately refuses to reclaim.
   */
  private async sweepOrphans(context: SweepContext): Promise<StorageMaintenanceSweepReport> {
    const accumulator = new SweepAccumulator("orphanedObjects");
    await this.reportUnreferencedAttachments(context, accumulator);

    if (!this.objects.isEnabled()) {
      accumulator.note(STORAGE_MAINTENANCE_NOTES.storageDisabled);
      return accumulator.finish();
    }
    await this.sweepOrphanedObjects(context, accumulator);
    await this.markRowsWithMissingObjects(context, accumulator);
    return accumulator.finish();
  }

  /** (a) Objects in the bucket that no live row claims. */
  private async sweepOrphanedObjects(
    context: SweepContext,
    accumulator: SweepAccumulator,
  ): Promise<void> {
    // The prefix is the attachment key family's root, narrowed to one workspace
    // partition when the run is scoped. Test islands (`test/...`) and any future
    // key family therefore fall outside the scan entirely.
    const prefix =
      context.scope.kind === "workspace"
        ? `${ATTACHMENT_KEY_ROOT}${context.scope.workspaceId}/`
        : ATTACHMENT_KEY_ROOT;
    const listing = await this.objects.listObjects("attachments", {
      prefix,
      limit: this.storage.maintenanceObjectScanLimit,
    });
    if (listing.truncated) {
      accumulator.truncated = true;
      accumulator.note(STORAGE_MAINTENANCE_NOTES.objectScanTruncated);
    }
    accumulator.examined += listing.objects.length;
    if (listing.objects.length === 0) return;

    const parsedByKey = new Map<string, ReturnType<typeof parseAttachmentObjectKey>>();
    const attachmentIds = new Set<string>();
    for (const object of listing.objects) {
      const parsed = parseAttachmentObjectKey(object.key);
      parsedByKey.set(object.key, parsed);
      if (parsed !== null) attachmentIds.add(parsed.attachmentId);
    }
    const owners = await this.loadObjectOwners([...attachmentIds], context.scope);

    const removable: string[] = [];
    for (const object of listing.objects) {
      const decision = decideOrphanObject(
        {
          key: object.key,
          lastModified: object.lastModified,
          parsed: parsedByKey.get(object.key) ?? null,
          owner: owners.get(parsedByKey.get(object.key)?.attachmentId ?? "") ?? null,
        },
        context.windows,
      );
      if (!decision.sweep) {
        if (decision.reason === "unparsable_key") {
          accumulator.note(STORAGE_MAINTENANCE_NOTES.unparsableKeysSkipped);
        }
        if (decision.reason === "workspace_mismatch") {
          accumulator.note(STORAGE_MAINTENANCE_NOTES.workspaceMismatchSkipped);
        }
        continue;
      }
      if (removable.length >= this.storage.maintenanceBatchLimit) {
        accumulator.truncated = true;
        break;
      }
      accumulator.selected += 1;
      // The SAMPLE is the attachment id parsed from the key, never the key
      // itself: keys stay out of logs and responses (ADR 0005).
      const attachmentId = parsedByKey.get(object.key)?.attachmentId;
      if (attachmentId !== undefined) accumulator.sample(attachmentId);
      removable.push(object.key);
    }
    if (context.dryRun || removable.length === 0) return;
    accumulator.objectsRemoved += await this.removeObjects("attachments", removable);
  }

  /**
   * Load the rows that could own the listed objects, with the exact key set each
   * one currently claims.
   *
   * A scoped run adds `whereWorkspace`, so a key naming another workspace's id
   * resolves to no owner and is refused by the `workspace_mismatch` /
   * `no_owning_row` branches rather than being attributed across tenants.
   */
  private async loadObjectOwners(
    attachmentIds: readonly string[],
    scope: MaintenanceScope,
  ): Promise<Map<string, ObjectOwnerFacts>> {
    const owners = new Map<string, ObjectOwnerFacts>();
    if (attachmentIds.length === 0) return owners;
    const rows = await this.database.db
      .select({
        id: attachments.id,
        workspaceId: attachments.workspaceId,
        storageKey: attachments.storageKey,
        variants: attachments.variants,
      })
      .from(attachments)
      .where(
        and(
          inArray(attachments.id, [...attachmentIds]),
          this.workspacePredicate(attachments, scope),
        ),
      );
    for (const row of rows) {
      owners.set(
        row.id,
        Object.freeze({
          id: row.id,
          workspaceId: row.workspaceId,
          ownedKeys: attachmentObjectKeys(row.variants, row.storageKey),
        }),
      );
    }
    return owners;
  }

  /**
   * (b) Rows whose bytes are gone.
   *
   * Marked, never deleted: the row is the user's record that a file existed, and
   * destroying it would turn "your file is broken" into "your file never
   * happened". Marking `failed` also releases the quota the phantom row was
   * holding.
   *
   * The blast radius is bounded three ways, because a misconfigured storage
   * endpoint is the realistic failure mode: only rows older than the ADR 0005
   * grace window are considered, at most `maintenanceBatchLimit` rows are
   * touched per pass, and `statObject` resolves `null` ONLY for a positive 404 —
   * every other storage error propagates and aborts the sweep instead of being
   * read as absence.
   */
  private async markRowsWithMissingObjects(
    context: SweepContext,
    accumulator: SweepAccumulator,
  ): Promise<void> {
    const limit = this.storage.maintenanceBatchLimit;
    const olderThan = new Date(context.windows.now.getTime() - context.windows.orphanWindowMs);
    const candidates = await this.database.db
      .select({
        id: attachments.id,
        status: attachments.processingStatus,
        createdAt: attachments.createdAt,
        storageKey: attachments.storageKey,
      })
      .from(attachments)
      .where(
        and(
          eq(attachments.processingStatus, "ready"),
          lte(attachments.createdAt, olderThan),
          this.workspacePredicate(attachments, context.scope),
        ),
      )
      .orderBy(asc(attachments.createdAt), asc(attachments.id))
      .limit(limit + 1);

    if (candidates.length > limit) accumulator.truncated = true;
    const batch = candidates.slice(0, limit);
    accumulator.examined += batch.length;

    const missing: string[] = [];
    for (const candidate of batch) {
      const stat = await this.objects.statObject("attachments", candidate.storageKey);
      if (
        !shouldMarkMissingObject(
          { ...candidate, primaryObjectAbsent: stat === null },
          context.windows,
        )
      ) {
        continue;
      }
      accumulator.selected += 1;
      accumulator.sample(candidate.id);
      missing.push(candidate.id);
    }
    if (missing.length === 0) return;
    accumulator.note(STORAGE_MAINTENANCE_NOTES.missingObjectsMarked);
    if (context.dryRun) return;

    const marked = await this.database.db
      .update(attachments)
      .set({
        processingStatus: "failed",
        processingError: ATTACHMENT_PROCESSING_ERRORS.storageObjectMissing,
      })
      .where(
        and(
          inArray(attachments.id, missing),
          // Re-assert `ready` so a row that legitimately changed state between
          // the scan and the write is left alone.
          eq(attachments.processingStatus, "ready"),
          this.workspacePredicate(attachments, context.scope),
        ),
      )
      .returning({ id: attachments.id });
    accumulator.rowsMarked += marked.length;
  }

  /**
   * REPORT ONLY: `ready` file attachments that no note document mentions.
   *
   * Part 44 created this class. An attachment card can leave a document through
   * an ordinary edit — select and Delete, undo/redo, paste-over — while its row
   * and its bytes remain. Only the confirmation dialog deletes stored bytes.
   *
   * THIS SWEEP DOES NOT DELETE THEM, deliberately:
   *
   * - The note's TipTap JSON is a mutable, collaboratively edited projection. A
   *   card removed a second ago comes back with Ctrl+Z, with an autosave
   *   rollback, and (from Part 55) with a version restore. Deleting the bytes
   *   because the CURRENT document no longer mentions them would destroy content
   *   the product promises is recoverable, and no grace period fixes that: undo
   *   history and version restore both reach arbitrarily far back.
   * - There is no durable reference edge in the schema. `attachments.note_id`
   *   still points at the note, so the row IS reachable from a live row — which
   *   rule 1 of this file forbids deleting.
   *
   * So the sweep measures the class and hands the number to an operator. The
   * safe way to reclaim these is an explicit reference-tracking table maintained
   * on save, plus a retention window measured from "last referenced" rather than
   * from upload — recorded as follow-up work in the Part 45 completion record.
   *
   * The `like` test is an id-substring match against the serialized document.
   * That is intentionally conservative in the safe direction: a false "still
   * referenced" (an id appearing somewhere unexpected) only under-reports, while
   * a false "unreferenced" cannot cause a deletion because nothing here deletes.
   *
   * ponytail: that leading-wildcard `LIKE` over `notes.content::text` is not
   * sargable, so this is a sequential scan over every `ready` file attachment
   * joined to its note, serializing each document to text. The `LIMIT` bounds
   * the RESULT, not the scan, so this query sets the latency floor for the
   * whole sweep and will dominate it on a large workspace. Accepted because it
   * is report-only, runs on an hourly scheduler, and cannot corrupt anything.
   * Upgrade path is the reference-tracking table described above: it turns this
   * into an indexed anti-join and removes the ceiling.
   */
  private async reportUnreferencedAttachments(
    context: SweepContext,
    accumulator: SweepAccumulator,
  ): Promise<void> {
    const rows = await this.database.db
      .select({ id: attachments.id })
      .from(attachments)
      .innerJoin(notes, eq(notes.id, attachments.noteId))
      .where(
        and(
          eq(attachments.processingStatus, "ready"),
          eq(attachments.mediaType, "file"),
          eq(notes.isDeleted, false),
          sql`${notes.content}::text not like '%' || ${attachments.id}::text || '%'`,
          this.workspacePredicate(attachments, context.scope),
        ),
      )
      .orderBy(asc(attachments.createdAt), asc(attachments.id))
      .limit(this.storage.maintenanceBatchLimit);
    if (rows.length === 0) return;
    accumulator.note(STORAGE_MAINTENANCE_NOTES.unreferencedAttachmentsDetected);
    for (const row of rows) accumulator.sample(row.id);
  }

  /* ---------------------------------------------------------------------- */
  /* Sweep 3 — expired exports                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Retire export objects past `object_expires_at`.
   *
   * The `exports` table and its partial `object_expires_at` index have existed
   * since Part 18 with no consumer; this is that consumer. Part 62 will own
   * export CREATION, and this sweep is written so it needs no change when that
   * lands: it only reads the state machine the schema already documents.
   *
   * See `decideExportSweep` for why the two phases are ordered the way they are.
   */
  private async sweepExpiredExports(context: SweepContext): Promise<StorageMaintenanceSweepReport> {
    const accumulator = new SweepAccumulator("expiredExports");
    const limit = this.storage.maintenanceBatchLimit;

    // --- Phase 1: ready + past expiry -> expired, object key KEPT. ---
    const expiring = await this.database.db
      .select({
        id: exportJobs.id,
        status: exportJobs.status,
        objectExpiresAt: exportJobs.objectExpiresAt,
        objectKey: exportJobs.objectKey,
      })
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.status, "ready"),
          isNotNull(exportJobs.objectExpiresAt),
          lte(exportJobs.objectExpiresAt, context.windows.now),
          this.workspacePredicate(exportJobs, context.scope),
        ),
      )
      .orderBy(asc(exportJobs.objectExpiresAt), asc(exportJobs.id))
      .limit(limit + 1);
    if (expiring.length > limit) accumulator.truncated = true;
    const expiringBatch = expiring.slice(0, limit);
    accumulator.examined += expiringBatch.length;

    const expireIds = expiringBatch
      .filter((row) => decideExportSweep(row, context.windows) === "expire_row")
      .map((row) => row.id);
    accumulator.selected += expireIds.length;
    for (const id of expireIds) accumulator.sample(id);
    if (!context.dryRun && expireIds.length > 0) {
      const updated = await this.database.db
        .update(exportJobs)
        .set({ status: "expired", completedAt: context.windows.now })
        .where(
          and(
            inArray(exportJobs.id, expireIds),
            eq(exportJobs.status, "ready"),
            this.workspacePredicate(exportJobs, context.scope),
          ),
        )
        .returning({ id: exportJobs.id });
      accumulator.rowsMarked += updated.length;
    }

    // --- Phase 2: terminal rows that still own bytes -> remove, then null. ---
    const releasable = await this.database.db
      .select({
        id: exportJobs.id,
        status: exportJobs.status,
        objectExpiresAt: exportJobs.objectExpiresAt,
        objectKey: exportJobs.objectKey,
      })
      .from(exportJobs)
      .where(
        and(
          inArray(exportJobs.status, ["expired", "failed", "cancelled"]),
          isNotNull(exportJobs.objectKey),
          this.workspacePredicate(exportJobs, context.scope),
        ),
      )
      .orderBy(asc(exportJobs.id))
      .limit(limit + 1);
    if (releasable.length > limit) accumulator.truncated = true;
    const releasableBatch = releasable.slice(0, limit);
    accumulator.examined += releasableBatch.length;

    const storageEnabled = this.objects.isEnabled();
    if (!storageEnabled) accumulator.note(STORAGE_MAINTENANCE_NOTES.storageDisabled);
    for (const row of releasableBatch) {
      if (decideExportSweep(row, context.windows) !== "release_object") continue;
      accumulator.selected += 1;
      accumulator.sample(row.id);
      if (context.dryRun || !storageEnabled || row.objectKey === null) continue;
      try {
        // `removeObject` (singular) THROWS on a real storage failure and treats
        // only absence as success, which is what allows the key to survive a
        // failed removal instead of being nulled while bytes remain.
        await this.objects.removeObject("exports", row.objectKey);
      } catch {
        accumulator.note(STORAGE_MAINTENANCE_NOTES.exportObjectRemovalFailed);
        continue;
      }
      accumulator.objectsRemoved += 1;
      const cleared = await this.database.db
        .update(exportJobs)
        .set({ objectKey: null })
        .where(and(eq(exportJobs.id, row.id), this.workspacePredicate(exportJobs, context.scope)))
        .returning({ id: exportJobs.id });
      accumulator.rowsMarked += cleared.length;
    }
    return accumulator.finish();
  }

  /* ---------------------------------------------------------------------- */
  /* Sweep 4 — deleted-note retention                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Hard-delete soft-deleted notes past their plan's retention window.
   *
   * `attachments.note_id` cascades, so deleting the note row also removes its
   * attachment metadata — which is exactly why the object keys are read and
   * captured BEFORE the delete. Reading them afterwards would be reading rows
   * the cascade has already removed, and every purge would strand its own bytes.
   * The objects are then removed after the commit (ADR 0005), with the
   * orphaned-object sweep as the backstop for a crash in between.
   */
  private async sweepDeletedNotes(context: SweepContext): Promise<StorageMaintenanceSweepReport> {
    const accumulator = new SweepAccumulator("deletedNoteRetention");
    const windows: DeletedNoteRetentionWindows = {
      free: this.retention.deletedNoteRetentionDaysFree,
      pro: this.retention.deletedNoteRetentionDaysPro,
      enterprise: this.retention.deletedNoteRetentionDaysEnterprise,
    };
    const finite = [windows.free, windows.pro, windows.enterprise].filter(
      (value): value is number => value !== null,
    );
    if (finite.length === 0) {
      accumulator.note(STORAGE_MAINTENANCE_NOTES.deletedNoteRetentionUnlimited);
      return accumulator.finish();
    }
    // Cut off at the SHORTEST finite window so no purgeable note is missed; the
    // per-plan rule is then applied by the predicate, which is what keeps an
    // unlimited-retention workspace safe even though its rows are scanned.
    const cutoff = new Date(context.windows.now.getTime() - Math.min(...finite) * DAY_MS);
    const limit = this.storage.maintenanceBatchLimit;

    const candidates = await this.database.db
      .select({
        id: notes.id,
        plan: workspaces.plan,
        isDeleted: notes.isDeleted,
        deletedAt: notes.deletedAt,
      })
      .from(notes)
      .innerJoin(workspaces, eq(workspaces.id, notes.workspaceId))
      .where(
        and(
          eq(notes.isDeleted, true),
          isNotNull(notes.deletedAt),
          lte(notes.deletedAt, cutoff),
          this.workspacePredicate(notes, context.scope),
        ),
      )
      .orderBy(asc(notes.deletedAt), asc(notes.id))
      .limit(limit + 1);

    accumulator.truncated = accumulator.truncated || candidates.length > limit;
    const batch = candidates.slice(0, limit);
    accumulator.examined = batch.length;

    for (const candidate of batch) {
      if (!shouldPurgeDeletedNote(candidate, windows, context.windows.now)) {
        continue;
      }
      // `notes.parent_id` cascades, so purging a note removes its whole subtree.
      // A subtree containing a note the user has NOT deleted is reachable live
      // content, and rule 1 forbids touching it.
      if (await this.hasLiveDescendant(candidate.id)) {
        accumulator.note(STORAGE_MAINTENANCE_NOTES.notePurgeSkippedLiveDescendant);
        continue;
      }
      accumulator.selected += 1;
      accumulator.sample(candidate.id);
      if (context.dryRun) continue;

      const keys = await this.readSubtreeAttachmentKeys(candidate.id);
      await this.database.transaction(async (tx) => {
        const removed = await tx
          .delete(notes)
          .where(
            and(
              eq(notes.id, candidate.id),
              eq(notes.isDeleted, true),
              this.workspacePredicate(notes, context.scope),
            ),
          )
          .returning({ id: notes.id });
        accumulator.rowsRemoved += removed.length;
      });
      accumulator.objectsRemoved += await this.removeObjects("attachments", keys);
    }
    return accumulator.finish();
  }

  /**
   * Ids of `noteId` and every descendant reachable through `parent_id`.
   *
   * A recursive CTE rather than repeated queries: the subtree is what the
   * `parent_id` CASCADE will actually delete, so anything that reasons about the
   * blast radius has to see the same set the database will.
   *
   * DELIBERATELY NOT WORKSPACE-SCOPED, and neither are its two callers.
   * `notes.parent_id` is a plain self-reference with no composite
   * `(workspace_id, parent_id)` foreign key, so a cross-workspace parent edge is
   * representable. When one exists, `ON DELETE CASCADE` destroys the foreign
   * descendant regardless of any predicate this service writes — the purge
   * deletes only the anchor row, and the database does the rest. Filtering the
   * traversal by workspace would therefore not prevent that deletion; it would
   * only blind the two things that have to see it:
   *
   * - `hasLiveDescendant`, which REFUSES the purge when the cascade would reach
   *   a note the user has not deleted. Scoping it would let a scoped run destroy
   *   live content in another workspace.
   * - `readSubtreeAttachmentKeys`, which collects the object keys of every row
   *   the cascade removes. Scoping it would strand those bytes forever, because
   *   the rows naming them are gone.
   *
   * The anchor is already proven in-scope: `sweepDeletedNotes` selects it under
   * `workspacePredicate` and re-asserts that predicate on the DELETE. So the
   * breadth here is read-only reasoning about a deletion the schema has already
   * committed to, never a widening of what a scoped run may delete.
   */
  private async subtreeNoteIds(noteId: string): Promise<readonly string[]> {
    const result = await this.database.db.execute(sql`
      with recursive subtree as (
        select id from notes where id = ${noteId}
        union all
        select child.id from notes child join subtree parent on child.parent_id = parent.id
      )
      select id from subtree
    `);
    return result.rows.map((row) => String(row.id));
  }

  /** Any descendant of `noteId` that the user has not deleted. */
  private async hasLiveDescendant(noteId: string): Promise<boolean> {
    const subtree = await this.subtreeNoteIds(noteId);
    const descendants = subtree.filter((id) => id !== noteId);
    if (descendants.length === 0) return false;
    const live = await this.database.db
      .select({ id: notes.id })
      .from(notes)
      .where(and(inArray(notes.id, [...descendants]), eq(notes.isDeleted, false)))
      .limit(1);
    return live.length > 0;
  }

  /**
   * Every object key owned by the note and its descendants, read BEFORE the
   * cascade removes the rows that name them.
   *
   * Scoped by subtree membership only — see `subtreeNoteIds` for why adding a
   * workspace predicate here would strand bytes rather than protect a tenant.
   */
  private async readSubtreeAttachmentKeys(noteId: string): Promise<readonly string[]> {
    const subtree = await this.subtreeNoteIds(noteId);
    if (subtree.length === 0) return [];
    const rows = await this.database.db
      .select({ storageKey: attachments.storageKey, variants: attachments.variants })
      .from(attachments)
      .where(inArray(attachments.noteId, [...subtree]));
    const keys = new Set<string>();
    for (const row of rows) {
      for (const key of attachmentObjectKeys(row.variants, row.storageKey)) keys.add(key);
    }
    return [...keys];
  }

  /* ---------------------------------------------------------------------- */
  /* Shared helpers                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * The workspace predicate for the active scope.
   *
   * `whereWorkspace` reads the ACTIVE tenant context and throws when there is
   * none, so a scoped run that somehow lost its context fails closed rather than
   * quietly sweeping every tenant. A system run returns `undefined`, which
   * `and(...)` drops — that cross-workspace breadth is the explicit,
   * transport-unreachable exception documented at the top of this file.
   */
  private workspacePredicate(
    table: WorkspaceScopedTable,
    scope: MaintenanceScope,
  ): SQL | undefined {
    return scope.kind === "workspace" ? whereWorkspace(table, this.tenantContext) : undefined;
  }

  /**
   * Best-effort bulk object removal, returning how many keys were handed to
   * storage. `removeObjects` is idempotent and never throws, which is what makes
   * a repeated run safe: removing an already-removed object succeeds.
   */
  private async removeObjects(
    bucket: "attachments" | "exports",
    keys: readonly string[],
  ): Promise<number> {
    if (keys.length === 0 || !this.objects.isEnabled()) return 0;
    await this.objects.removeObjects(bucket, keys);
    return keys.length;
  }

  /**
   * One audit row per authorized run, recording COUNTS only.
   *
   * Written after the sweeps rather than before so the recorded numbers are what
   * actually happened. Only the workspace-scoped path audits: the system sweeper
   * has no workspace scope and no actor, and `audit_logs.workspace_id` is
   * `NOT NULL` — its trail is the structured log instead.
   */
  private async writeAudit(
    input: RunWorkspaceMaintenanceInput,
    report: StorageMaintenanceReport,
  ): Promise<void> {
    await recordAudit(this.database.db, {
      workspaceId: activeWorkspaceId(this.tenantContext),
      userId: input.principal.userId,
      action: STORAGE_MAINTENANCE_AUDIT_ACTION,
      entityType: STORAGE_MAINTENANCE_AUDIT_ENTITY_TYPE,
      entityId: activeWorkspaceId(this.tenantContext),
      metadata: {
        dryRun: report.dryRun,
        sweeps: report.sweeps.map((sweep) => ({
          sweep: sweep.sweep,
          selected: sweep.selected,
          rowsRemoved: sweep.rowsRemoved,
          rowsMarked: sweep.rowsMarked,
          objectsRemoved: sweep.objectsRemoved,
          truncated: sweep.truncated,
        })),
      },
      requestId: input.requestId ?? null,
    });
  }
}
