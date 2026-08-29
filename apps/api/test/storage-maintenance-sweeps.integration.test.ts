// Part 45 — the four sweeps, against live PostgreSQL and MinIO.
// Fixtures and helpers live in `storage-maintenance-fixtures.ts`.

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildAttachmentObjectKey } from "../src/attachments/attachment-storage-key";
import { ATTACHMENT_PROCESSING_ERRORS } from "../src/attachments/attachments.constants";
import { attachments, auditLogs, exportJobs, notes, schema } from "../src/database/schema";
import { ObjectStorageService } from "../src/infrastructure/minio/object-storage.service";
import { STORAGE_MAINTENANCE_NOTES } from "../src/maintenance/maintenance.constants";

import { HAS_DATABASE, requireDatabase } from "./database-test-helpers";
import { HAS_MINIO, isMinioReachable } from "./minio-test-helpers";
import {
  AGGRESSIVE_RETENTION,
  AGGRESSIVE_STORAGE,
  CONSERVATIVE_RETENTION,
  CONSERVATIVE_STORAGE,
  DATABASE_URL,
  DAY_MS,
  HOUR_MS,
  MIGRATIONS_FOLDER,
  PNG,
  RollbackMaintenanceTest,
  StoredAttachment,
  WorkspaceFixture,
  attachmentRowIds,
  buildMaintenanceService,
  createExpiredExport,
  createInFlightAttachment,
  createOrphanedObject,
  createReadyAttachment,
  createWorkspaceFixture,
  createdExportKeys,
  createdWorkspaceIds,
  expectObjectsAbsent,
  expectObjectsPresent,
  expectSafeReport,
  insertNote,
  keysUnderWorkspace,
  mutationCounts,
  primaryKey,
  principal,
  realStorage,
  retentionConfig,
  scopedDatabase,
  storageConfig,
  sweep,
} from "./storage-maintenance-fixtures";

import type { StorageMaintenanceReport } from "@notted/shared-types";

/* ========================================================================== */
/* The object plane — PostgreSQL + MinIO                                       */
/* ========================================================================== */

describe.skipIf(!HAS_DATABASE || !HAS_MINIO)(
  "Part 45 storage maintenance sweeps (live PostgreSQL + MinIO)",
  () => {
    let pool: Pool | undefined;
    let db: NodePgDatabase<typeof schema> | undefined;
    let minioReachable = false;
    let storage: ObjectStorageService | undefined;

    beforeAll(async () => {
      await requireDatabase();
      minioReachable = await isMinioReachable();
      pool = new Pool({ connectionString: DATABASE_URL as string, max: 4 });
      db = drizzle(pool, { schema });
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      if (minioReachable) {
        storage = realStorage();
        await storage.ensureBuckets();
      }
    });

    // MinIO cannot roll back with PostgreSQL, so every object this suite writes
    // lives under a per-run workspace partition that is removed here. A crashed
    // run leaves an identifiable, disposable island rather than shared litter.
    afterEach(async () => {
      if (storage !== undefined) {
        for (const workspaceId of createdWorkspaceIds) {
          try {
            const keys = await keysUnderWorkspace(storage, workspaceId);
            if (keys.length > 0) await storage.removeObjects("attachments", keys);
          } catch {
            // Objects under a random workspace partition are disposable.
          }
        }
        for (const key of createdExportKeys) {
          await storage.removeObject("exports", key).catch(() => undefined);
        }
      }
      createdWorkspaceIds.length = 0;
      createdExportKeys.length = 0;
    });

    afterAll(async () => {
      await pool?.end().catch(() => undefined);
    });

    it("never removes an active file, in either scope, dry-run or live", async ({ skip }) => {
      if (db === undefined || !minioReachable || storage === undefined) {
        skip("skipped: no reachable PostgreSQL + MinIO — run dev compose");
        return;
      }
      const store = storage;

      await expect(
        db.transaction(async (tx) => {
          const fixture = await createWorkspaceFixture(tx);
          const database = scopedDatabase(tx);
          const active = await createReadyAttachment(tx, store, {
            workspaceId: fixture.workspaceId,
            noteId: fixture.liveNoteId,
            createdById: fixture.owner,
            originalName: "active-file.png",
            // Older than every window in play, so nothing about its survival is
            // owed to an age guard: only "a live row claims these keys" is.
            createdDaysAgo: 400,
          });

          const aggressive = buildMaintenanceService({
            database,
            objects: store,
            storage: AGGRESSIVE_STORAGE,
            retention: AGGRESSIVE_RETENTION,
          });
          const conservative = buildMaintenanceService({
            database,
            objects: store,
            storage: CONSERVATIVE_STORAGE,
            retention: CONSERVATIVE_RETENTION,
          });

          const scopedRun = (dryRun: boolean): Promise<StorageMaintenanceReport> =>
            aggressive.runForWorkspace({
              principal: principal(fixture.owner),
              workspaceId: fixture.workspaceId,
              dryRun,
            });

          const scopedDry = await scopedRun(true);
          const scopedLive = await scopedRun(false);
          // System scope crosses every workspace in the database, so the dry-run
          // may use the aggressive windows (it mutates nothing) while the LIVE
          // one may not (see the header).
          const systemDry = await aggressive.runSystemSweeps({ dryRun: true });
          const systemLive = await conservative.runSystemSweeps({ dryRun: false });
          const reports: StorageMaintenanceReport[] = [
            scopedDry,
            scopedLive,
            systemDry,
            systemLive,
          ];

          expect(reports.map((report) => report.scope)).toEqual([
            "workspace",
            "workspace",
            "system",
            "system",
          ]);

          for (const report of reports) {
            expectSafeReport(report, [...active.keys, "active-file.png"]);
            // The active attachment is never even a CANDIDATE for removal.
            for (const entry of report.sweeps) {
              expect(entry.sampleIds, entry.sweep).not.toContain(active.id);
            }
          }

          // Both dry runs mutate nothing, by definition.
          for (const report of [scopedDry, systemDry]) {
            expect(mutationCounts(report)).toEqual({
              rowsRemoved: 0,
              rowsMarked: 0,
              objectsRemoved: 0,
            });
          }
          /*
           * The conservative system run is bounded by construction FOR THE
           * SWEEPS THE WINDOWS GOVERN: the abandoned-upload window is a year and
           * the orphan and deleted-note windows are past a century, so none of
           * them can select a row no matter what else is in the database.
           *
           * `expiredExports` is excluded, and that is a property of the sweep
           * rather than a concession. An export is selected on its own
           * `object_expires_at` column (`sweepExpiredExports`), which no
           * retention window widens or narrows — so any database that already
           * holds expired exports will legitimately have them swept. A blanket
           * zero here was therefore asserting A PRISTINE DATABASE rather than a
           * property of the code, and it held only while `MINIO_*` never reached
           * the test process and this whole suite skipped. Run against a
           * long-lived development database it reports 132 rows marked and 66
           * objects removed, all of them expired exports from earlier work.
           *
           * What this test actually needs from the system run is that it never
           * touches THIS fixture — stated directly by the `sampleIds` loop above
           * and by the row and object assertions below.
           */
          const windowGoverned = systemLive.sweeps.filter(
            (entry) => entry.sweep !== "expiredExports",
          );
          expect(windowGoverned.length).toBeGreaterThan(0);
          for (const entry of windowGoverned) {
            expect(
              {
                rowsRemoved: entry.rowsRemoved,
                rowsMarked: entry.rowsMarked,
                objectsRemoved: entry.objectsRemoved,
              },
              entry.sweep,
            ).toEqual({ rowsRemoved: 0, rowsMarked: 0, objectsRemoved: 0 });
          }

          // --- The whole point: the row and every one of its objects survive. ---
          const [row] = await tx
            .select({
              id: attachments.id,
              status: attachments.processingStatus,
              error: attachments.processingError,
            })
            .from(attachments)
            .where(eq(attachments.id, active.id));
          expect(row).toMatchObject({
            id: active.id,
            status: "ready",
            error: null,
          });
          expect(active.keys).toHaveLength(5);
          await expectObjectsPresent(store, active.keys);

          throw new RollbackMaintenanceTest("rollback active-file fixture");
        }),
      ).rejects.toBeInstanceOf(RollbackMaintenanceTest);
    });

    it("dry-run selects real work and changes nothing; the same run live removes exactly that work", async ({
      skip,
    }) => {
      if (db === undefined || !minioReachable || storage === undefined) {
        skip("skipped: no reachable PostgreSQL + MinIO — run dev compose");
        return;
      }
      const store = storage;

      await expect(
        db.transaction(async (tx) => {
          const fixture = await createWorkspaceFixture(tx);
          const database = scopedDatabase(tx);
          const service = buildMaintenanceService({
            database,
            objects: store,
            storage: AGGRESSIVE_STORAGE,
            retention: AGGRESSIVE_RETENTION,
          });

          // --- Genuinely sweepable state, one case per sweep. ---
          const active = await createReadyAttachment(tx, store, {
            workspaceId: fixture.workspaceId,
            noteId: fixture.liveNoteId,
            createdById: fixture.owner,
            originalName: "keep-me.png",
          });
          const abandoned = await createInFlightAttachment(tx, store, {
            workspaceId: fixture.workspaceId,
            noteId: fixture.liveNoteId,
            createdById: fixture.owner,
            status: "pending",
            ageMs: 2 * HOUR_MS,
          });
          const orphanKey = await createOrphanedObject(store, fixture.workspaceId);
          // A second object under the ACTIVE row's id that the row does not
          // claim — what reprocessing leaves behind, and the `unclaimed_variant`
          // branch. Its neighbours in `variants` must survive it.
          const unclaimedKey = buildAttachmentObjectKey({
            workspaceId: fixture.workspaceId,
            attachmentId: active.id,
            variant: "medium",
            extension: ".webp",
          });
          await store.putObject("attachments", unclaimedKey, PNG, {
            contentType: "image/webp",
            contentLength: PNG.byteLength,
          });
          const expired = await createExpiredExport(tx, store, {
            workspaceId: fixture.workspaceId,
            requestedById: fixture.owner,
          });
          const purgeableNote = await insertNote(tx, {
            workspaceId: fixture.workspaceId,
            createdById: fixture.owner,
            title: "Deleted long ago",
            deletedDaysAgo: 60,
          });
          const purgeableAttachment = await createReadyAttachment(tx, store, {
            workspaceId: fixture.workspaceId,
            noteId: purgeableNote,
            createdById: fixture.owner,
            originalName: "goes-with-the-note.png",
          });

          const rowsBefore = await attachmentRowIds(tx, fixture.workspaceId);
          const objectsBefore = await keysUnderWorkspace(store, fixture.workspaceId);

          // --- Dry run: finds the work, performs none of it. ---
          const dry = await service.runForWorkspace({
            principal: principal(fixture.owner),
            workspaceId: fixture.workspaceId,
            dryRun: true,
          });
          expect(dry.dryRun).toBe(true);
          expect(sweep(dry, "abandonedUploads").selected).toBe(1);
          // The orphan and the unclaimed variant; the five claimed keys are not
          // selectable at any age.
          expect(sweep(dry, "orphanedObjects").selected).toBe(2);
          expect(sweep(dry, "expiredExports").selected).toBeGreaterThanOrEqual(1);
          expect(sweep(dry, "deletedNoteRetention").selected).toBe(1);
          expect(mutationCounts(dry)).toEqual({
            rowsRemoved: 0,
            rowsMarked: 0,
            objectsRemoved: 0,
          });

          // Proving the dry run was a true no-op rather than a sweep that found
          // nothing: the counts above are non-zero AND nothing moved.
          expect(await attachmentRowIds(tx, fixture.workspaceId)).toEqual(rowsBefore);
          expect(await keysUnderWorkspace(store, fixture.workspaceId)).toEqual(objectsBefore);
          await expectObjectsPresent(store, [
            ...active.keys,
            ...abandoned.keys,
            ...purgeableAttachment.keys,
            orphanKey,
            unclaimedKey,
          ]);
          expect(await store.statObject("exports", expired.key)).not.toBeNull();
          const [exportBefore] = await tx
            .select({ status: exportJobs.status, objectKey: exportJobs.objectKey })
            .from(exportJobs)
            .where(eq(exportJobs.id, expired.id));
          expect(exportBefore).toMatchObject({ status: "ready", objectKey: expired.key });
          const [noteBefore] = await tx
            .select({ id: notes.id })
            .from(notes)
            .where(eq(notes.id, purgeableNote));
          expect(noteBefore?.id).toBe(purgeableNote);

          // --- Live: exactly the work the dry run named. ---
          const live = await service.runForWorkspace({
            principal: principal(fixture.owner),
            workspaceId: fixture.workspaceId,
            dryRun: false,
          });
          expect(live.dryRun).toBe(false);
          expect(sweep(live, "abandonedUploads").rowsRemoved).toBe(1);
          expect(sweep(live, "orphanedObjects").objectsRemoved).toBe(2);
          expect(sweep(live, "deletedNoteRetention").rowsRemoved).toBe(1);

          // Abandoned upload: row and its object gone, quota released.
          expect(
            await tx
              .select({ id: attachments.id })
              .from(attachments)
              .where(eq(attachments.id, abandoned.id)),
          ).toEqual([]);
          await expectObjectsAbsent(store, abandoned.keys);
          // Orphan and unclaimed variant gone.
          await expectObjectsAbsent(store, [orphanKey, unclaimedKey]);
          // Export retired: object removed, key nulled, row kept as the record.
          const [exportAfter] = await tx
            .select({ status: exportJobs.status, objectKey: exportJobs.objectKey })
            .from(exportJobs)
            .where(eq(exportJobs.id, expired.id));
          expect(exportAfter).toMatchObject({ status: "expired", objectKey: null });
          expect(await store.statObject("exports", expired.key)).toBeNull();
          // Deleted note purged, its attachment cascaded, and — the criterion
          // that matters — EVERY object it owned is gone, not just the primary.
          expect(
            await tx.select({ id: notes.id }).from(notes).where(eq(notes.id, purgeableNote)),
          ).toEqual([]);
          expect(
            await tx
              .select({ id: attachments.id })
              .from(attachments)
              .where(eq(attachments.id, purgeableAttachment.id)),
          ).toEqual([]);
          expect(purgeableAttachment.keys).toHaveLength(5);
          await expectObjectsAbsent(store, purgeableAttachment.keys);

          // The live note, its attachment, and all five of its objects survived.
          expect(await attachmentRowIds(tx, fixture.workspaceId)).toEqual([
            { id: active.id, status: "ready" },
          ]);
          await expectObjectsPresent(store, active.keys);

          expectSafeReport(live, [
            ...active.keys,
            orphanKey,
            unclaimedKey,
            expired.key,
            "keep-me.png",
            "goes-with-the-note.png",
          ]);

          throw new RollbackMaintenanceTest("rollback dry-run fixture");
        }),
      ).rejects.toBeInstanceOf(RollbackMaintenanceTest);
    });

    it("produces the same safe result when the same sweeps are run twice live", async ({
      skip,
    }) => {
      if (db === undefined || !minioReachable || storage === undefined) {
        skip("skipped: no reachable PostgreSQL + MinIO — run dev compose");
        return;
      }
      const store = storage;

      await expect(
        db.transaction(async (tx) => {
          const fixture = await createWorkspaceFixture(tx);
          const database = scopedDatabase(tx);
          const service = buildMaintenanceService({
            database,
            objects: store,
            storage: AGGRESSIVE_STORAGE,
            retention: AGGRESSIVE_RETENTION,
          });

          const active = await createReadyAttachment(tx, store, {
            workspaceId: fixture.workspaceId,
            noteId: fixture.liveNoteId,
            createdById: fixture.owner,
            originalName: "survivor.png",
          });
          await createInFlightAttachment(tx, store, {
            workspaceId: fixture.workspaceId,
            noteId: fixture.liveNoteId,
            createdById: fixture.owner,
            status: "pending",
            ageMs: 2 * HOUR_MS,
          });
          await createInFlightAttachment(tx, store, {
            workspaceId: fixture.workspaceId,
            noteId: fixture.liveNoteId,
            createdById: fixture.owner,
            status: "failed",
            ageMs: 30 * DAY_MS,
          });
          await createOrphanedObject(store, fixture.workspaceId);
          await createExpiredExport(tx, store, {
            workspaceId: fixture.workspaceId,
            requestedById: fixture.owner,
          });
          const purgeableNote = await insertNote(tx, {
            workspaceId: fixture.workspaceId,
            createdById: fixture.owner,
            title: "Deleted long ago",
            deletedDaysAgo: 60,
          });
          await createReadyAttachment(tx, store, {
            workspaceId: fixture.workspaceId,
            noteId: purgeableNote,
            createdById: fixture.owner,
            originalName: "purged-with-note.png",
          });

          const run = (): Promise<StorageMaintenanceReport> =>
            service.runForWorkspace({
              principal: principal(fixture.owner),
              workspaceId: fixture.workspaceId,
              dryRun: false,
            });

          const first = await run();
          // The first pass must actually have done something, or "the second
          // pass did nothing" would be vacuous.
          const firstCounts = mutationCounts(first);
          expect(firstCounts.rowsRemoved).toBeGreaterThan(0);
          expect(firstCounts.objectsRemoved).toBeGreaterThan(0);
          expect(firstCounts.rowsMarked).toBeGreaterThan(0);

          const rowsAfterFirst = await attachmentRowIds(tx, fixture.workspaceId);
          const objectsAfterFirst = await keysUnderWorkspace(store, fixture.workspaceId);
          const exportsAfterFirst = await tx
            .select({
              id: exportJobs.id,
              status: exportJobs.status,
              objectKey: exportJobs.objectKey,
            })
            .from(exportJobs)
            .where(eq(exportJobs.workspaceId, fixture.workspaceId));
          const notesAfterFirst = await tx
            .select({ id: notes.id })
            .from(notes)
            .where(eq(notes.workspaceId, fixture.workspaceId));

          const second = await run();

          // Every sweep of the second pass is a no-op. The predicates are false
          // for the state the first pass left behind.
          for (const entry of second.sweeps) {
            expect(entry.rowsRemoved, entry.sweep).toBe(0);
            expect(entry.rowsMarked, entry.sweep).toBe(0);
            expect(entry.objectsRemoved, entry.sweep).toBe(0);
          }

          // ...and the world is byte-identical to where the first pass left it.
          expect(await attachmentRowIds(tx, fixture.workspaceId)).toEqual(rowsAfterFirst);
          expect(await keysUnderWorkspace(store, fixture.workspaceId)).toEqual(objectsAfterFirst);
          expect(
            await tx
              .select({
                id: exportJobs.id,
                status: exportJobs.status,
                objectKey: exportJobs.objectKey,
              })
              .from(exportJobs)
              .where(eq(exportJobs.workspaceId, fixture.workspaceId)),
          ).toEqual(exportsAfterFirst);
          expect(
            await tx
              .select({ id: notes.id })
              .from(notes)
              .where(eq(notes.workspaceId, fixture.workspaceId)),
          ).toEqual(notesAfterFirst);

          // The active file is what "safe" means here.
          expect(rowsAfterFirst).toEqual([{ id: active.id, status: "ready" }]);
          await expectObjectsPresent(store, active.keys);

          throw new RollbackMaintenanceTest("rollback idempotency fixture");
        }),
      ).rejects.toBeInstanceOf(RollbackMaintenanceTest);
    });

    /*
     * THE EXPORTS-BUCKET GAP. `ExportWorkerService` writes the object and only
     * then records the key on the row (`markReady` is the sole writer of
     * `object_key`), so a crash in between leaves bytes nothing points at. Both
     * export phases select on `isNotNull(objectKey)` and therefore cannot see
     * them, and the listing-based reconciler was hardcoded to the `attachments`
     * bucket — so this bucket had no orphan sweep at any layer.
     */
    it("reclaims export bytes no row references, and leaves a claimed object alone", async ({
      skip,
    }) => {
      if (db === undefined || !minioReachable || storage === undefined) {
        skip("skipped: no reachable PostgreSQL + MinIO — run dev compose");
        return;
      }
      const store = storage;

      await expect(
        db.transaction(async (tx) => {
          const fixture = await createWorkspaceFixture(tx);
          const database = scopedDatabase(tx);
          // Zero-day windows: MinIO owns `lastModified` and a freshly written
          // object cannot be back-dated.
          const aggressive = buildMaintenanceService({
            database,
            objects: store,
            storage: AGGRESSIVE_STORAGE,
            retention: AGGRESSIVE_RETENTION,
          });

          // A worker that died between `putObject` and `markReady`: canonical
          // key, no row anywhere.
          const strandedKey = `${fixture.workspaceId}/${randomUUID()}.zip`;
          createdExportKeys.push(strandedKey);
          await store.putObject("exports", strandedKey, PNG, {
            contentType: "application/zip",
            contentLength: PNG.byteLength,
          });

          // And a live export whose row DOES claim its key. Its key uses the
          // shared test prefix, so it is not in the canonical layout and is
          // refused as `unparsable_key` — which is itself the safe direction.
          const claimed = await createExpiredExport(tx, store, {
            workspaceId: fixture.workspaceId,
            requestedById: fixture.owner,
          });
          await tx
            .update(exportJobs)
            .set({ objectExpiresAt: new Date(Date.now() + 86_400_000) })
            .where(eq(exportJobs.id, claimed.id));

          await aggressive.runSystemSweeps({ dryRun: false });

          // Asserted on THIS fixture's own keys only. A system-scoped run
          // legitimately sweeps other workspaces' expired exports, so a blanket
          // count would assert a property of the database rather than of the
          // code — the same reasoning the dry-run test above records.
          expect(await store.statObject("exports", strandedKey)).toBeNull();
          // The claimed object survives: reconciliation reclaims bytes, never rows.
          expect(await store.statObject("exports", claimed.key)).not.toBeNull();

          throw new RollbackMaintenanceTest();
        }),
      ).rejects.toBeInstanceOf(RollbackMaintenanceTest);
    });

    it("removes an object no row owns and MARKS a row whose object vanished, without deleting it", async ({
      skip,
    }) => {
      if (db === undefined || !minioReachable || storage === undefined) {
        skip("skipped: no reachable PostgreSQL + MinIO — run dev compose");
        return;
      }
      const store = storage;

      await expect(
        db.transaction(async (tx) => {
          const fixture = await createWorkspaceFixture(tx);
          const database = scopedDatabase(tx);

          // --- Direction (a): bytes with no row. ---
          // Needs the zero-day object window, because MinIO owns `lastModified`
          // and a freshly written object cannot be back-dated.
          const aggressive = buildMaintenanceService({
            database,
            objects: store,
            storage: AGGRESSIVE_STORAGE,
            retention: AGGRESSIVE_RETENTION,
          });
          const orphanKey = await createOrphanedObject(store, fixture.workspaceId);
          const kept = await createReadyAttachment(tx, store, {
            workspaceId: fixture.workspaceId,
            noteId: fixture.liveNoteId,
            createdById: fixture.owner,
            originalName: "claimed.png",
          });

          const orphanRun = await aggressive.runForWorkspace({
            principal: principal(fixture.owner),
            workspaceId: fixture.workspaceId,
            dryRun: false,
          });
          expect(sweep(orphanRun, "orphanedObjects").objectsRemoved).toBe(1);
          await expectObjectsAbsent(store, [orphanKey]);
          await expectObjectsPresent(store, kept.keys);

          // --- Direction (b): a row whose bytes are gone. ---
          // Deliberately run with the REALISTIC seven-day window so nothing
          // below depends on the zero-day setting used above.
          const realistic = buildMaintenanceService({
            database,
            objects: store,
            storage: storageConfig(),
            retention: retentionConfig(),
          });
          const stranded = await createReadyAttachment(tx, store, {
            workspaceId: fixture.workspaceId,
            noteId: fixture.liveNoteId,
            createdById: fixture.owner,
            originalName: "bytes-vanished.png",
            // Older than the seven-day reconciliation grace period; a row
            // younger than that is never eligible to be marked.
            createdDaysAgo: 8,
          });
          // Delete the PRIMARY object out from under the row, the way an
          // operator with a bucket console can.
          await store.removeObject("attachments", primaryKey(stranded));

          const markRun = await realistic.runForWorkspace({
            principal: principal(fixture.owner),
            workspaceId: fixture.workspaceId,
            dryRun: false,
          });
          expect(sweep(markRun, "orphanedObjects").rowsMarked).toBe(1);
          expect(sweep(markRun, "orphanedObjects").notes).toContain(
            STORAGE_MAINTENANCE_NOTES.missingObjectsMarked,
          );
          expect(sweep(markRun, "orphanedObjects").rowsRemoved).toBe(0);

          const [marked] = await tx
            .select({
              id: attachments.id,
              status: attachments.processingStatus,
              error: attachments.processingError,
            })
            .from(attachments)
            .where(eq(attachments.id, stranded.id));
          expect(marked).toMatchObject({
            id: stranded.id,
            // Marked, never deleted: the row is the user's record that a file
            // existed, and it also releases the quota the phantom was holding.
            status: "failed",
            error: ATTACHMENT_PROCESSING_ERRORS.storageObjectMissing,
          });

          // The healthy row alongside it is untouched.
          const [healthy] = await tx
            .select({ status: attachments.processingStatus })
            .from(attachments)
            .where(eq(attachments.id, kept.id));
          expect(healthy?.status).toBe("ready");

          expectSafeReport(markRun, [...kept.keys, ...stranded.keys, "bytes-vanished.png"]);

          throw new RollbackMaintenanceTest("rollback reconciliation fixture");
        }),
      ).rejects.toBeInstanceOf(RollbackMaintenanceTest);
    });

    /**
     * REGRESSION GUARD for a data-loss bug this suite originally caught failing.
     *
     * `markRowsWithMissingObjects` states its contract in the source: "Marked,
     * never deleted: the row is the user's record that a file existed, and
     * destroying it would turn 'your file is broken' into 'your file never
     * happened'." The next sweep pass used to destroy it anyway, unconditionally
     * rather than as a race:
     *
     * - A row is only ELIGIBLE to be marked when `created_at <= now -
     *   orphanWindow`. So every row this path marks is, by construction, already
     *   older than the orphan window.
     * - `decideAbandonedUpload` reaped a `failed` row when `now - created_at >=
     *   orphanWindow` — measured from `created_at`, the same column.
     *
     * So 100% of the rows sweep 2 marked were selected for hard deletion by
     * sweep 1 of the very next run: the grace period the reaper meant to grant a
     * failed upload was already spent at the instant of marking. With the
     * default one-hour scheduler interval the "your file is broken" record
     * survived at most an hour, and "repeated runs produce the same safe result"
     * was false (pass N marks, pass N+1 destroys).
     *
     * FIX: a `failed` row carrying `processing_error =
     * 'storage_object_missing'` is exempt from sweep 1 permanently, in the SQL
     * and in `decideAbandonedUpload`. No schema column is needed, because the
     * error code already distinguishes "this row records a loss" from "this
     * upload never landed". Such a row owns no reclaimable bytes by definition —
     * its object is the thing that vanished.
     *
     * This run uses the SHIPPED seven-day default, not the zero-day window used
     * elsewhere in this file, so it exercises the real production timings.
     */
    it("keeps a row marked failed by reconciliation across the next sweep pass", async ({
      skip,
    }) => {
      if (db === undefined || !minioReachable || storage === undefined) {
        skip("skipped: no reachable PostgreSQL + MinIO — run dev compose");
        return;
      }
      const store = storage;

      await expect(
        db.transaction(async (tx) => {
          const fixture = await createWorkspaceFixture(tx);
          const service = buildMaintenanceService({
            database: scopedDatabase(tx),
            objects: store,
            // The SHIPPED defaults: 24-hour abandoned window, 7-day orphan window.
            storage: storageConfig(),
            retention: retentionConfig(),
          });
          const stranded = await createReadyAttachment(tx, store, {
            workspaceId: fixture.workspaceId,
            noteId: fixture.liveNoteId,
            createdById: fixture.owner,
            originalName: "still-a-record.png",
            createdDaysAgo: 8,
          });
          await store.removeObject("attachments", primaryKey(stranded));

          const run = (): Promise<StorageMaintenanceReport> =>
            service.runForWorkspace({
              principal: principal(fixture.owner),
              workspaceId: fixture.workspaceId,
              dryRun: false,
            });

          await run();
          const [afterFirst] = await tx
            .select({ status: attachments.processingStatus })
            .from(attachments)
            .where(eq(attachments.id, stranded.id));
          expect(afterFirst?.status).toBe("failed");

          const second = await run();

          // EXPECTED: the record of the broken file is still there for the user
          // and the operator to see. OBSERVED: sweep 1 hard-deletes it.
          expect(sweep(second, "abandonedUploads").rowsRemoved).toBe(0);
          const [afterSecond] = await tx
            .select({ status: attachments.processingStatus })
            .from(attachments)
            .where(eq(attachments.id, stranded.id));
          expect(afterSecond?.status).toBe("failed");

          throw new RollbackMaintenanceTest("rollback failed-row retention fixture");
        }),
      ).rejects.toBeInstanceOf(RollbackMaintenanceTest);
    });

    it("confines a workspace-scoped run to its own workspace's rows and objects", async ({
      skip,
    }) => {
      if (db === undefined || !minioReachable || storage === undefined) {
        skip("skipped: no reachable PostgreSQL + MinIO — run dev compose");
        return;
      }
      const store = storage;

      await expect(
        db.transaction(async (tx) => {
          const alpha = await createWorkspaceFixture(tx);
          const beta = await createWorkspaceFixture(tx);
          const database = scopedDatabase(tx);
          const service = buildMaintenanceService({
            database,
            objects: store,
            storage: AGGRESSIVE_STORAGE,
            retention: AGGRESSIVE_RETENTION,
          });

          /** Identically sweepable state in both workspaces. */
          const seed = async (
            fixture: WorkspaceFixture,
          ): Promise<{
            readonly abandoned: StoredAttachment;
            readonly orphanKey: string;
            readonly expired: { readonly id: string; readonly key: string };
            readonly purgeableNote: string;
          }> => {
            const abandoned = await createInFlightAttachment(tx, store, {
              workspaceId: fixture.workspaceId,
              noteId: fixture.liveNoteId,
              createdById: fixture.owner,
              status: "pending",
              ageMs: 2 * HOUR_MS,
            });
            const orphanKey = await createOrphanedObject(store, fixture.workspaceId);
            const expired = await createExpiredExport(tx, store, {
              workspaceId: fixture.workspaceId,
              requestedById: fixture.owner,
            });
            const purgeableNote = await insertNote(tx, {
              workspaceId: fixture.workspaceId,
              createdById: fixture.owner,
              title: "Deleted long ago",
              deletedDaysAgo: 60,
            });
            return { abandoned, orphanKey, expired, purgeableNote };
          };
          const alphaState = await seed(alpha);
          const betaState = await seed(beta);
          const betaRowsBefore = await attachmentRowIds(tx, beta.workspaceId);
          const betaObjectsBefore = await keysUnderWorkspace(store, beta.workspaceId);

          const report = await service.runForWorkspace({
            principal: principal(alpha.owner),
            workspaceId: alpha.workspaceId,
            dryRun: false,
          });

          // --- Alpha was swept. ---
          expect(sweep(report, "abandonedUploads").rowsRemoved).toBe(1);
          expect(sweep(report, "orphanedObjects").objectsRemoved).toBe(1);
          expect(sweep(report, "deletedNoteRetention").rowsRemoved).toBe(1);
          expect(await attachmentRowIds(tx, alpha.workspaceId)).toEqual([]);
          await expectObjectsAbsent(store, [alphaState.orphanKey, ...alphaState.abandoned.keys]);

          // --- Beta was not so much as read. ---
          expect(await attachmentRowIds(tx, beta.workspaceId)).toEqual(betaRowsBefore);
          expect(await keysUnderWorkspace(store, beta.workspaceId)).toEqual(betaObjectsBefore);
          await expectObjectsPresent(store, [betaState.orphanKey, ...betaState.abandoned.keys]);
          const [betaExport] = await tx
            .select({ status: exportJobs.status, objectKey: exportJobs.objectKey })
            .from(exportJobs)
            .where(eq(exportJobs.id, betaState.expired.id));
          expect(betaExport).toMatchObject({ status: "ready", objectKey: betaState.expired.key });
          expect(await store.statObject("exports", betaState.expired.key)).not.toBeNull();
          const [betaNote] = await tx
            .select({ id: notes.id, isDeleted: notes.isDeleted })
            .from(notes)
            .where(
              and(eq(notes.id, betaState.purgeableNote), eq(notes.workspaceId, beta.workspaceId)),
            );
          expect(betaNote).toMatchObject({ id: betaState.purgeableNote, isDeleted: true });

          // No audit row was written against the untouched workspace either.
          expect(
            await tx
              .select({ id: auditLogs.id })
              .from(auditLogs)
              .where(eq(auditLogs.workspaceId, beta.workspaceId)),
          ).toEqual([]);
          expect(
            await tx
              .select({ id: auditLogs.id })
              .from(auditLogs)
              .where(eq(auditLogs.workspaceId, alpha.workspaceId)),
          ).toHaveLength(1);

          expectSafeReport(report, [
            alphaState.orphanKey,
            betaState.orphanKey,
            betaState.expired.key,
          ]);

          throw new RollbackMaintenanceTest("rollback tenant-scope fixture");
        }),
      ).rejects.toBeInstanceOf(RollbackMaintenanceTest);
    });
  },
);
