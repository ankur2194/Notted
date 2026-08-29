// Part 45 — the authorization and tenant-scope half of the storage sweeps.
// Fixtures and helpers live in `storage-maintenance-fixtures.ts`.

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { auditLogs, schema } from "../src/database/schema";
import {
  STORAGE_MAINTENANCE_AUDIT_ACTION,
  STORAGE_MAINTENANCE_AUDIT_ENTITY_TYPE,
} from "../src/maintenance/maintenance.constants";

import { HAS_DATABASE, requireDatabase } from "./database-test-helpers";
import {
  AGGRESSIVE_RETENTION,
  AGGRESSIVE_STORAGE,
  DATABASE_URL,
  HOUR_MS,
  MIGRATIONS_FOLDER,
  MemoryObjectStore,
  RollbackMaintenanceTest,
  attachmentRowIds,
  buildMaintenanceService,
  createInFlightAttachment,
  createWorkspaceFixture,
  createdExportKeys,
  createdWorkspaceIds,
  expectSafeReport,
  mutationCounts,
  primaryKey,
  principal,
  scopedDatabase,
  sweep,
} from "./storage-maintenance-fixtures";

import type { StorageMaintenanceReport } from "@notted/shared-types";

/* ========================================================================== */
/* Authorization and tenant scope — PostgreSQL only                            */
/* ========================================================================== */

describe.skipIf(!HAS_DATABASE)(
  "Part 45 storage maintenance authorization (live PostgreSQL)",
  () => {
    let pool: Pool | undefined;
    let db: NodePgDatabase<typeof schema> | undefined;

    beforeAll(async () => {
      await requireDatabase();

      pool = new Pool({ connectionString: DATABASE_URL as string, max: 4 });
      db = drizzle(pool, { schema });
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    });

    // Nothing here writes a real object, but the fixture builders still record
    // the workspace ids they create. Clear them so the MinIO describe below
    // starts with an empty cleanup list.
    afterEach(() => {
      createdWorkspaceIds.length = 0;
      createdExportKeys.length = 0;
    });

    afterAll(async () => {
      await pool?.end().catch(() => undefined);
    });

    it("lets only owners and admins trigger maintenance, and audits counts only", async ({
      skip,
    }) => {
      if (db === undefined) {
        skip("skipped: no reachable PostgreSQL — run dev compose");
        return;
      }

      await expect(
        db.transaction(async (tx) => {
          const fixture = await createWorkspaceFixture(tx);
          const store = new MemoryObjectStore();
          const database = scopedDatabase(tx);
          const service = buildMaintenanceService({
            database,
            objects: store,
            storage: AGGRESSIVE_STORAGE,
            retention: AGGRESSIVE_RETENTION,
          });

          // Genuinely sweepable work, so a denial that silently succeeded would
          // be visible as a deleted row rather than as a missing exception.
          const abandoned = await createInFlightAttachment(tx, store, {
            workspaceId: fixture.workspaceId,
            noteId: fixture.liveNoteId,
            createdById: fixture.owner,
            status: "pending",
            ageMs: 2 * HOUR_MS,
          });

          const run = (userId: string): Promise<StorageMaintenanceReport> =>
            service.runForWorkspace({
              principal: principal(userId),
              workspaceId: fixture.workspaceId,
              dryRun: false,
            });

          // `settings.update` means owner/admin in the central policy, so an
          // editor and a viewer are refused with 403 and no side effect.
          for (const denied of [fixture.editor, fixture.viewer]) {
            await expect(run(denied)).rejects.toMatchObject({
              name: "AuthorizationDeniedError",
              decision: {
                allowed: false,
                code: "authorization.forbidden",
                httpStatus: 403,
                safeMessage: "You are not allowed to do that.",
              },
            });
          }
          // A non-member gets the concealed 404 shape instead: refusing with
          // "forbidden" would confirm the workspace exists.
          await expect(run(fixture.outsider)).rejects.toMatchObject({
            decision: {
              allowed: false,
              code: "authorization.concealed",
              httpStatus: 404,
              safeMessage: "The requested resource was not found.",
            },
          });

          // Three refusals, zero mutations.
          expect(await attachmentRowIds(tx, fixture.workspaceId)).toEqual([
            { id: abandoned.id, status: "pending" },
          ]);
          expect(store.objects.has(primaryKey(abandoned))).toBe(true);
          expect(
            await tx
              .select({ id: auditLogs.id })
              .from(auditLogs)
              .where(eq(auditLogs.workspaceId, fixture.workspaceId)),
          ).toEqual([]);

          // The owner may run it, and it does the work the refusals did not.
          const ownerReport = await run(fixture.owner);
          expect(ownerReport.scope).toBe("workspace");
          expect(ownerReport.dryRun).toBe(false);
          expect(sweep(ownerReport, "abandonedUploads").rowsRemoved).toBe(1);
          expect(await attachmentRowIds(tx, fixture.workspaceId)).toEqual([]);

          // An admin may run it too; there is simply nothing left to do.
          const adminReport = await run(fixture.admin);
          expect(mutationCounts(adminReport)).toEqual({
            rowsRemoved: 0,
            rowsMarked: 0,
            objectsRemoved: 0,
          });

          // --- The audit trail records counts, never content. ---
          const audits = await tx
            .select({
              action: auditLogs.action,
              entityType: auditLogs.entityType,
              entityId: auditLogs.entityId,
              userId: auditLogs.userId,
              metadata: auditLogs.metadata,
            })
            .from(auditLogs)
            .where(eq(auditLogs.workspaceId, fixture.workspaceId));
          expect(audits).toHaveLength(2);
          for (const entry of audits) {
            expect(entry.action).toBe(STORAGE_MAINTENANCE_AUDIT_ACTION);
            expect(entry.entityType).toBe(STORAGE_MAINTENANCE_AUDIT_ENTITY_TYPE);
            expect(entry.entityId).toBe(fixture.workspaceId);
          }
          expect(audits.map((entry) => entry.userId).sort()).toEqual(
            [fixture.owner, fixture.admin].sort(),
          );
          const auditJson = JSON.stringify(audits.map((entry) => entry.metadata));
          expect(auditJson).not.toContain(primaryKey(abandoned));
          expect(auditJson).not.toContain("in-flight-pending.png");

          expectSafeReport(ownerReport, [primaryKey(abandoned), "in-flight-pending.png"]);

          throw new RollbackMaintenanceTest("rollback maintenance authorization fixture");
        }),
      ).rejects.toBeInstanceOf(RollbackMaintenanceTest);
    });
  },
);
