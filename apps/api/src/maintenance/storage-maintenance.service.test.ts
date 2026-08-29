// Part 45 — the four sweeps, against a recording Drizzle double and an in-memory
// object store.
//
// The four contracts this file exists to hold are the ones stated at the top of
// `storage-maintenance.service.ts`:
//
//   1. nothing reachable from a live row is ever deleted,
//   2. two consecutive runs produce the same result,
//   3. `dryRun` mutates NOTHING,
//   4. reports carry counts and UUIDs only.
//
// The database double records every statement in the same ordered log the object
// store writes to, so "the keys were read BEFORE the cascade delete" is asserted
// as an ordering fact rather than inferred from a passing test.

import { storageMaintenanceReportSchema } from "@notted/shared-validators";
import { describe, expect, it, vi } from "vitest";

import { parseRetentionConfig } from "../config/retention.config";
import { parseStorageConfig } from "../config/storage.config";
import { attachments, auditLogs, exportJobs, notes, workspaces } from "../database/schema";
import { createTenantContext, TenantContextService } from "../tenant";

import { STORAGE_MAINTENANCE_NOTES } from "./maintenance.constants";
import { StorageMaintenanceService } from "./storage-maintenance.service";

import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { StructuredLogger } from "../common/logging/structured-logger.service";
import type { DatabaseService } from "../database/database.service";
import type {
  ListObjectsResult,
  ObjectStore,
  PutObjectResult,
  StorageBucket,
  StoredObjectStat,
} from "../infrastructure/minio/object-storage.service";
import type {
  AuthenticatedPrincipal,
  StorageMaintenanceReport,
  StorageMaintenanceSweepName,
  StorageMaintenanceSweepReport,
} from "@notted/shared-types";
import type { Readable } from "node:stream";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = new Date("2026-08-07T12:00:00.000Z");

const userId = "60000000-0000-4000-8000-000000000001";
const workspaceId = "60000000-0000-4000-8100-000000000001";
const noteId = "60000000-0000-4000-8500-000000000001";
const childNoteId = "60000000-0000-4000-8500-000000000002";
const attachmentId = "60000000-0000-4000-8900-000000000001";
const exportId = "60000000-0000-4000-8a00-000000000001";

function token(seed: string): string {
  return seed.repeat(32).slice(0, 32);
}

function objectKey(variant: string, seed: string, extension = ".png"): string {
  return `w/${workspaceId}/a/${attachmentId}/${variant}/${token(seed)}${extension}`;
}

const ORIGINAL_KEY = objectKey("original", "a");
const FULL_KEY = objectKey("full", "b");
const MEDIUM_KEY = objectKey("medium", "c");
const THUMBNAIL_KEY = objectKey("thumbnail", "d", ".webp");
/**
 * Part 44's generic-file preview. `preview` is deliberately NOT in the
 * parseable variant vocabulary, so this key proves the row's own key list — not
 * the key parser — is what decides which objects a row owns.
 */
const PREVIEW_KEY = `w/${workspaceId}/a/${attachmentId}/preview/${token("e")}.webp`;
const EXPORT_OBJECT_KEY = "exports/2026/08/quarterly-report.zip";

function ago(milliseconds: number): Date {
  return new Date(NOW.getTime() - milliseconds);
}

function principal(): AuthenticatedPrincipal {
  return Object.freeze({
    userId,
    sessionId: "session",
    method: "opaque-session",
    assurance: "single-factor",
    authenticatedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    isFresh: true,
  });
}

/* -------------------------------------------------------------------------- */
/* Doubles                                                                     */
/* -------------------------------------------------------------------------- */

type Row = Readonly<Record<string, unknown>>;

interface MutationRecord {
  readonly kind: "delete" | "insert" | "update";
  readonly table: string;
  readonly values?: Row;
}

/**
 * Every query the service issues, named by the table it reads and the exact
 * projection it selects. Naming them keeps the test fixtures readable and makes
 * an unexpected extra query fail loudly instead of silently returning [].
 */
const SELECT_NAMES: Readonly<Record<string, string>> = {
  "attachments:createdAt,id,processingError,status,storageKey,variants": "abandonedCandidates",
  "attachments:id": "unreferencedAttachments",
  "attachments:id,storageKey,variants,workspaceId": "objectOwners",
  "attachments:createdAt,id,status,storageKey": "missingObjectCandidates",
  "attachments:storageKey,variants": "subtreeAttachmentKeys",
  "exportJobs:id,objectExpiresAt,objectKey,status": "exportCandidates",
  "notes:deletedAt,id,isDeleted,plan": "deletedNoteCandidates",
  "notes:id": "liveDescendants",
};

interface SelectChain {
  innerJoin(): SelectChain;
  where(): SelectChain;
  orderBy(): SelectChain;
  limit(): SelectChain;
  then(resolve: (value: readonly Row[]) => unknown): unknown;
}

interface MaintenanceDatabaseOptions {
  /** FIFO of result sets per named query; an exhausted queue yields []. */
  readonly selects?: Readonly<Record<string, readonly (readonly Row[])[]>>;
  /** FIFO of `.returning()` rows per `${kind}:${table}`. */
  readonly returning?: Readonly<Record<string, readonly (readonly Row[])[]>>;
  /** Ids the recursive subtree CTE reports, for every note it is asked about. */
  readonly subtreeIds?: readonly string[];
}

function tableName(table: unknown): string {
  if (table === attachments) return "attachments";
  if (table === notes) return "notes";
  if (table === exportJobs) return "exportJobs";
  if (table === workspaces) return "workspaces";
  if (table === auditLogs) return "auditLogs";
  return "unknown";
}

function fakeMaintenanceDatabase(options: MaintenanceDatabaseOptions = {}, log: string[] = []) {
  const mutations: MutationRecord[] = [];
  const queues = new Map<string, (readonly Row[])[]>();
  for (const [name, results] of Object.entries(options.selects ?? {})) {
    queues.set(`select:${name}`, [...results]);
  }
  for (const [name, results] of Object.entries(options.returning ?? {})) {
    queues.set(`returning:${name}`, [...results]);
  }

  function next(key: string): readonly Row[] {
    return queues.get(key)?.shift() ?? [];
  }

  function chain(rows: readonly Row[]): SelectChain {
    const value: SelectChain = {
      innerJoin: () => value,
      where: () => value,
      orderBy: () => value,
      limit: () => value,
      then: (resolve) => resolve(rows),
    };
    return value;
  }

  function record(kind: MutationRecord["kind"], table: unknown, values?: Row): readonly Row[] {
    const name = tableName(table);
    log.push(`${kind}:${name}`);
    mutations.push({ kind, table: name, ...(values === undefined ? {} : { values }) });
    return next(`returning:${kind}:${name}`);
  }

  const builder = {
    select: (projection: Readonly<Record<string, unknown>>) => ({
      from: (table: unknown): SelectChain => {
        const signature = `${tableName(table)}:${Object.keys(projection).sort().join(",")}`;
        const name = SELECT_NAMES[signature] ?? signature;
        log.push(`select:${name}`);
        return chain(next(`select:${name}`));
      },
    }),
    /*
     * `reconcileExportObjects` enumerates the workspaces that have export rows,
     * because export keys are `<workspace>/<export>.<ext>` with no shared root
     * and `listObjects` refuses an empty prefix. These tests queue no rows for
     * it, so a system-scoped run finds no prefixes to scan and the phase is a
     * no-op — which keeps every existing expectation about the attachments
     * bucket unchanged.
     */
    selectDistinct: () => ({
      from: () => ({ limit: () => Promise.resolve([]) }),
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: () => ({
          returning: () => Promise.resolve(record("update", table, values)),
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: () => ({
        returning: () => Promise.resolve(record("delete", table)),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Row) => {
        record("insert", table, values);
        return Promise.resolve();
      },
    }),
    execute: () => {
      log.push("execute:subtree");
      return Promise.resolve({ rows: (options.subtreeIds ?? []).map((id) => ({ id })) });
    },
  };

  const database = {
    db: builder,
    transaction: <T>(work: (tx: typeof builder) => Promise<T>) => work(builder),
  } as unknown as DatabaseService;

  return { database, mutations, log };
}

/** In-memory `ObjectStore` that records its calls into the shared log. */
class FakeObjectStore implements ObjectStore {
  enabled = true;
  listing: ListObjectsResult = Object.freeze({ objects: Object.freeze([]), truncated: false });
  readonly presentKeys = new Set<string>();
  readonly removedKeys: string[] = [];
  removeObjectFails = false;

  constructor(private readonly log: string[]) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  putObject(): Promise<PutObjectResult> {
    return Promise.reject(new Error("the maintenance sweeps never write objects"));
  }

  getObjectStream(): Promise<Readable> {
    return Promise.reject(new Error("the maintenance sweeps never read object bodies"));
  }

  statObject(_bucket: StorageBucket, key: string): Promise<StoredObjectStat | null> {
    this.log.push("statObject");
    return Promise.resolve(
      this.presentKeys.has(key)
        ? { size: 1, etag: "etag", lastModified: ago(365 * DAY), contentType: null }
        : null,
    );
  }

  listObjects(): Promise<ListObjectsResult> {
    this.log.push("listObjects");
    return Promise.resolve(this.listing);
  }

  removeObject(_bucket: StorageBucket, key: string): Promise<void> {
    this.log.push("removeObject");
    if (this.removeObjectFails) return Promise.reject(new Error("storage removal failed"));
    this.removedKeys.push(key);
    return Promise.resolve();
  }

  removeObjects(_bucket: StorageBucket, keys: readonly string[]): Promise<void> {
    this.log.push(`removeObjects:${keys.length}`);
    this.removedKeys.push(...keys);
    return Promise.resolve();
  }

  presignedGetUrl(): Promise<string> {
    return Promise.resolve("https://storage.invalid/signed");
  }
}

interface BuildOptions {
  readonly database?: MaintenanceDatabaseOptions;
  readonly environment?: Readonly<Record<string, string>>;
  readonly denied?: boolean;
}

function build(options: BuildOptions = {}) {
  const log: string[] = [];
  const tenant = new TenantContextService();
  const fake = fakeMaintenanceDatabase(options.database ?? {}, log);
  const store = new FakeObjectStore(log);
  const authorizeUser =
    options.denied === true
      ? vi.fn().mockRejectedValue(new Error("denied"))
      : vi.fn().mockResolvedValue({ workspaceId, userId });
  const entry = {
    authorizeUser,
    run: <T>(_operation: unknown, work: () => T): T =>
      tenant.run(createTenantContext({ workspaceId, userId }), work),
  } as unknown as AuthorizationEntryService;
  const logger = { info: vi.fn(), failure: vi.fn(), warn: vi.fn() } as unknown as StructuredLogger;
  const service = new StorageMaintenanceService(
    fake.database,
    entry,
    tenant,
    store,
    parseRetentionConfig({}),
    parseStorageConfig(options.environment ?? {}),
    logger,
  );
  // `log` deliberately comes from `fake` only: `fakeMaintenanceDatabase` was
  // handed this exact array, so listing it twice made TypeScript's duplicate-key
  // rule fire on an alias of itself.
  return { service, store, logger, authorizeUser, ...fake };
}

function sweep(
  report: StorageMaintenanceReport,
  name: StorageMaintenanceSweepName,
): StorageMaintenanceSweepReport {
  const found = report.sweeps.find((entry) => entry.sweep === name);
  if (found === undefined) throw new Error(`the report is missing the ${name} sweep`);
  return found;
}

/**
 * A fixture in which ALL FOUR sweeps have work to do, so one run exercises every
 * mutating branch at once.
 */
function busyFixture(): MaintenanceDatabaseOptions {
  return {
    selects: {
      abandonedCandidates: [
        [
          {
            id: attachmentId,
            processingError: null,
            status: "pending",
            createdAt: ago(10 * DAY),
            storageKey: ORIGINAL_KEY,
            variants: {
              original: {
                key: ORIGINAL_KEY,
                width: 10,
                height: 10,
                bytes: 1,
                mimeType: "image/png",
              },
            },
          },
        ],
      ],
      unreferencedAttachments: [[{ id: attachmentId }]],
      missingObjectCandidates: [
        [
          {
            id: attachmentId,
            status: "ready",
            createdAt: ago(30 * DAY),
            storageKey: ORIGINAL_KEY,
          },
        ],
      ],
      exportCandidates: [
        [
          {
            id: exportId,
            status: "ready",
            objectExpiresAt: ago(DAY),
            objectKey: EXPORT_OBJECT_KEY,
          },
        ],
        [
          {
            id: exportId,
            status: "expired",
            objectExpiresAt: ago(DAY),
            objectKey: EXPORT_OBJECT_KEY,
          },
        ],
      ],
      deletedNoteCandidates: [
        [{ id: noteId, plan: "free", isDeleted: true, deletedAt: ago(60 * DAY) }],
      ],
      liveDescendants: [[]],
      subtreeAttachmentKeys: [[{ storageKey: FULL_KEY, variants: { full: { key: FULL_KEY } } }]],
    },
    returning: {
      "delete:attachments": [[{ id: attachmentId }]],
      "update:attachments": [[{ id: attachmentId }]],
      "update:exportJobs": [[{ id: exportId }], [{ id: exportId }]],
      "delete:notes": [[{ id: noteId }]],
    },
    subtreeIds: [noteId],
  };
}

/* -------------------------------------------------------------------------- */
/* dryRun                                                                      */
/* -------------------------------------------------------------------------- */

describe("StorageMaintenanceService dry run", () => {
  it("selects work but mutates absolutely nothing", async () => {
    const context = build({ database: busyFixture() });
    const report = await context.service.runSystemSweeps({ dryRun: true });

    expect(report.dryRun).toBe(true);
    // Something WAS selected — otherwise "nothing was mutated" is vacuous.
    const selected = report.sweeps.reduce((total, entry) => total + entry.selected, 0);
    expect(selected).toBeGreaterThan(0);
    for (const name of ["abandonedUploads", "expiredExports", "deletedNoteRetention"] as const) {
      expect(sweep(report, name).selected).toBeGreaterThan(0);
    }

    // No statement that could change state was ever issued.
    expect(context.mutations).toEqual([]);
    expect(context.log.filter((entry) => entry.startsWith("delete:"))).toEqual([]);
    expect(context.log.filter((entry) => entry.startsWith("update:"))).toEqual([]);
    expect(context.log.filter((entry) => entry.startsWith("insert:"))).toEqual([]);
    expect(context.store.removedKeys).toEqual([]);
    expect(context.log.some((entry) => entry.startsWith("removeObject"))).toBe(false);

    for (const entry of report.sweeps) {
      expect(entry.rowsRemoved).toBe(0);
      expect(entry.rowsMarked).toBe(0);
      expect(entry.objectsRemoved).toBe(0);
    }
  });

  it("does mutate the same fixture once dryRun is false", async () => {
    // The paired assertion that keeps the test above honest.
    const context = build({ database: busyFixture() });
    const report = await context.service.runSystemSweeps({ dryRun: false });

    expect(context.mutations.map((mutation) => `${mutation.kind}:${mutation.table}`)).toEqual([
      "delete:attachments",
      "update:attachments",
      "update:exportJobs",
      "update:exportJobs",
      "delete:notes",
    ]);
    expect(sweep(report, "abandonedUploads").rowsRemoved).toBe(1);
    expect(sweep(report, "orphanedObjects").rowsMarked).toBe(1);
    expect(sweep(report, "expiredExports").rowsMarked).toBe(2);
    expect(sweep(report, "deletedNoteRetention").rowsRemoved).toBe(1);
    expect(context.store.removedKeys.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Sweep 1 — abandoned uploads                                                 */
/* -------------------------------------------------------------------------- */

describe("StorageMaintenanceService abandoned uploads", () => {
  it("removes EVERY object key an attachment row owns, including the preview", async () => {
    const context = build({
      database: {
        selects: {
          abandonedCandidates: [
            [
              {
                id: attachmentId,
                processingError: null,
                status: "processing",
                createdAt: ago(3 * DAY),
                storageKey: ORIGINAL_KEY,
                variants: {
                  original: {
                    key: ORIGINAL_KEY,
                    width: 10,
                    height: 10,
                    bytes: 1,
                    mimeType: "image/png",
                  },
                  full: { key: FULL_KEY, width: 8, height: 8, bytes: 1, mimeType: "image/webp" },
                  medium: {
                    key: MEDIUM_KEY,
                    width: 6,
                    height: 6,
                    bytes: 1,
                    mimeType: "image/webp",
                  },
                  thumbnail: {
                    key: THUMBNAIL_KEY,
                    width: 4,
                    height: 4,
                    bytes: 1,
                    mimeType: "image/webp",
                  },
                  preview: {
                    key: PREVIEW_KEY,
                    mimeType: "image/webp",
                    width: 4,
                    height: 4,
                  },
                  // `blur` is an inline data URI, NOT an object key, so it must
                  // never reach the object store.
                  blur: { dataUri: "data:image/webp;base64,AAAA", width: 4, height: 4 },
                },
              },
            ],
          ],
        },
        returning: { "delete:attachments": [[{ id: attachmentId }]] },
      },
    });

    const report = await context.service.runSystemSweeps({ dryRun: false });
    expect(new Set(context.store.removedKeys)).toEqual(
      new Set([ORIGINAL_KEY, FULL_KEY, MEDIUM_KEY, THUMBNAIL_KEY, PREVIEW_KEY]),
    );
    expect(sweep(report, "abandonedUploads").objectsRemoved).toBe(5);
    expect(context.store.removedKeys.join(",")).not.toContain("data:image");
  });

  it("deletes the row BEFORE the objects, so a crash strands bytes rather than rows", async () => {
    const context = build({
      database: {
        selects: {
          abandonedCandidates: [
            [
              {
                id: attachmentId,
                processingError: null,
                status: "pending",
                createdAt: ago(3 * DAY),
                storageKey: ORIGINAL_KEY,
                variants: {},
              },
            ],
          ],
        },
        returning: { "delete:attachments": [[{ id: attachmentId }]] },
      },
    });
    await context.service.runSystemSweeps({ dryRun: false });
    const deletedAt = context.log.indexOf("delete:attachments");
    const removedAt = context.log.findIndex((entry) => entry.startsWith("removeObjects:"));
    expect(deletedAt).toBeGreaterThanOrEqual(0);
    expect(removedAt).toBeGreaterThan(deletedAt);
  });

  it("reports truncation and stops at the configured batch limit", async () => {
    const rows = [1, 2, 3].map((index) => ({
      id: `60000000-0000-4000-8900-00000000000${index}`,
      status: "pending",
      createdAt: ago(3 * DAY),
      storageKey: ORIGINAL_KEY,
      variants: {},
    }));
    const context = build({
      environment: { STORAGE_MAINTENANCE_BATCH_LIMIT: "2" },
      database: {
        selects: { abandonedCandidates: [rows] },
        returning: { "delete:attachments": [[{ id: attachmentId }, { id: attachmentId }]] },
      },
    });
    const report = await context.service.runSystemSweeps({ dryRun: true });
    const abandoned = sweep(report, "abandonedUploads");
    expect(abandoned.truncated).toBe(true);
    expect(abandoned.examined).toBe(2);
    expect(abandoned.selected).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Sweep 2 — orphans, missing objects, and the report-only class               */
/* -------------------------------------------------------------------------- */

describe("StorageMaintenanceService orphan reconciliation", () => {
  it("treats unreferenced attachments as REPORT ONLY and removes nothing", async () => {
    const secondAttachmentId = "60000000-0000-4000-8900-000000000002";
    const context = build({
      database: {
        selects: {
          unreferencedAttachments: [[{ id: attachmentId }, { id: secondAttachmentId }]],
        },
      },
    });
    // Not a dry run: the class must be untouched even when deletion is allowed.
    const report = await context.service.runSystemSweeps({ dryRun: false });
    const orphans = sweep(report, "orphanedObjects");

    expect(orphans.notes).toContain(STORAGE_MAINTENANCE_NOTES.unreferencedAttachmentsDetected);
    expect(orphans.sampleIds).toEqual([attachmentId, secondAttachmentId]);
    expect(orphans.rowsRemoved).toBe(0);
    expect(orphans.objectsRemoved).toBe(0);
    expect(context.mutations).toEqual([]);
    expect(context.store.removedKeys).toEqual([]);
  });

  it("handles disabled object storage with a note code instead of a crash", async () => {
    const context = build({ database: busyFixture() });
    context.store.enabled = false;

    const report = await context.service.runSystemSweeps({ dryRun: false });
    expect(sweep(report, "orphanedObjects").notes).toContain(
      STORAGE_MAINTENANCE_NOTES.storageDisabled,
    );
    expect(sweep(report, "expiredExports").notes).toContain(
      STORAGE_MAINTENANCE_NOTES.storageDisabled,
    );
    // No bucket was listed, no object was statted, and no object was removed.
    expect(context.log).not.toContain("listObjects");
    expect(context.log).not.toContain("statObject");
    expect(context.store.removedKeys).toEqual([]);
    for (const entry of report.sweeps) expect(entry.objectsRemoved).toBe(0);
    // The database-only work still ran, so a storage outage does not stall the
    // row-side sweeps.
    expect(sweep(report, "abandonedUploads").rowsRemoved).toBe(1);
  });

  it("refuses unparsable keys and workspace mismatches, noting both", async () => {
    const foreignWorkspaceKey = `w/${workspaceId}/a/${attachmentId}/full/${token("f")}.png`;
    const context = build({
      database: {
        selects: {
          objectOwners: [
            [
              {
                id: attachmentId,
                // The row says it lives in another workspace than the key's
                // partition: corruption, not a cleanup task.
                workspaceId: "60000000-0000-4000-8100-000000000002",
                storageKey: ORIGINAL_KEY,
                variants: {},
              },
            ],
          ],
        },
      },
    });
    context.store.listing = Object.freeze({
      objects: Object.freeze([
        { key: "test/island/fixture.bin", size: 1, lastModified: ago(365 * DAY) },
        { key: foreignWorkspaceKey, size: 1, lastModified: ago(365 * DAY) },
      ]),
      truncated: false,
    });

    const report = await context.service.runSystemSweeps({ dryRun: false });
    const orphans = sweep(report, "orphanedObjects");
    expect(orphans.notes).toContain(STORAGE_MAINTENANCE_NOTES.unparsableKeysSkipped);
    expect(orphans.notes).toContain(STORAGE_MAINTENANCE_NOTES.workspaceMismatchSkipped);
    expect(orphans.selected).toBe(0);
    expect(context.store.removedKeys).toEqual([]);
  });

  it("collects an object no live row claims, sampling the id and never the key", async () => {
    const context = build({
      database: { selects: { objectOwners: [[]] } },
    });
    context.store.listing = Object.freeze({
      objects: Object.freeze([{ key: ORIGINAL_KEY, size: 1, lastModified: ago(365 * DAY) }]),
      truncated: true,
    });

    const report = await context.service.runSystemSweeps({ dryRun: false });
    const orphans = sweep(report, "orphanedObjects");
    expect(orphans.selected).toBe(1);
    expect(orphans.objectsRemoved).toBe(1);
    expect(orphans.truncated).toBe(true);
    expect(orphans.notes).toContain(STORAGE_MAINTENANCE_NOTES.objectScanTruncated);
    expect(context.store.removedKeys).toEqual([ORIGINAL_KEY]);
    // The SAMPLE is the attachment id parsed out of the key, never the key.
    expect(orphans.sampleIds).toEqual([attachmentId]);
    expect(JSON.stringify(orphans)).not.toContain(ORIGINAL_KEY);
  });

  it("marks a ready row whose bytes are gone rather than deleting the row", async () => {
    const context = build({
      database: {
        selects: {
          missingObjectCandidates: [
            [
              {
                id: attachmentId,
                status: "ready",
                createdAt: ago(30 * DAY),
                storageKey: ORIGINAL_KEY,
              },
            ],
          ],
        },
        returning: { "update:attachments": [[{ id: attachmentId }]] },
      },
    });

    const report = await context.service.runSystemSweeps({ dryRun: false });
    const orphans = sweep(report, "orphanedObjects");
    expect(orphans.rowsMarked).toBe(1);
    expect(orphans.rowsRemoved).toBe(0);
    expect(orphans.notes).toContain(STORAGE_MAINTENANCE_NOTES.missingObjectsMarked);
    expect(context.mutations).toEqual([
      {
        kind: "update",
        table: "attachments",
        values: { processingStatus: "failed", processingError: "storage_object_missing" },
      },
    ]);
  });

  it("leaves a ready row alone when storage confirms its object is present", async () => {
    const context = build({
      database: {
        selects: {
          missingObjectCandidates: [
            [
              {
                id: attachmentId,
                status: "ready",
                createdAt: ago(30 * DAY),
                storageKey: ORIGINAL_KEY,
              },
            ],
          ],
        },
      },
    });
    context.store.presentKeys.add(ORIGINAL_KEY);

    const report = await context.service.runSystemSweeps({ dryRun: false });
    expect(sweep(report, "orphanedObjects").selected).toBe(0);
    expect(context.mutations).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Sweep 3 — expired exports                                                   */
/* -------------------------------------------------------------------------- */

describe("StorageMaintenanceService expired exports", () => {
  it("keeps the object key when a failed removal means the bytes are still there", async () => {
    const context = build({
      database: {
        selects: {
          exportCandidates: [
            [],
            [
              {
                id: exportId,
                status: "expired",
                objectExpiresAt: ago(DAY),
                objectKey: EXPORT_OBJECT_KEY,
              },
            ],
          ],
        },
      },
    });
    context.store.removeObjectFails = true;

    const report = await context.service.runSystemSweeps({ dryRun: false });
    const exports = sweep(report, "expiredExports");
    expect(exports.notes).toContain(STORAGE_MAINTENANCE_NOTES.exportObjectRemovalFailed);
    expect(exports.objectsRemoved).toBe(0);
    // The key column is NOT nulled: it is the only pointer to bytes nothing else
    // can reclaim, because export keys are outside the attachment key family.
    expect(context.mutations).toEqual([]);
  });

  it("removes the object first and only then nulls the key", async () => {
    const context = build({
      database: {
        selects: {
          exportCandidates: [
            [],
            [
              {
                id: exportId,
                status: "cancelled",
                objectExpiresAt: null,
                objectKey: EXPORT_OBJECT_KEY,
              },
            ],
          ],
        },
        returning: { "update:exportJobs": [[{ id: exportId }]] },
      },
    });

    await context.service.runSystemSweeps({ dryRun: false });
    expect(context.store.removedKeys).toEqual([EXPORT_OBJECT_KEY]);
    expect(context.log.indexOf("removeObject")).toBeLessThan(
      context.log.indexOf("update:exportJobs"),
    );
    expect(context.mutations).toEqual([
      { kind: "update", table: "exportJobs", values: { objectKey: null } },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Sweep 4 — deleted-note retention                                            */
/* -------------------------------------------------------------------------- */

describe("StorageMaintenanceService deleted-note retention", () => {
  it("reads the subtree's attachment keys BEFORE the cascade delete removes them", async () => {
    const context = build({ database: busyFixture() });
    await context.service.runSystemSweeps({ dryRun: false });

    const keysReadAt = context.log.indexOf("select:subtreeAttachmentKeys");
    const deletedAt = context.log.indexOf("delete:notes");
    expect(keysReadAt).toBeGreaterThanOrEqual(0);
    expect(deletedAt).toBeGreaterThan(keysReadAt);
    // …and the objects go afterwards, so a crash strands bytes the orphan sweep
    // reclaims rather than losing the only pointer to them.
    const removedAt = context.log.reduce(
      (last, entry, index) => (entry.startsWith("removeObjects:") ? index : last),
      -1,
    );
    expect(removedAt).toBeGreaterThan(deletedAt);
    expect(context.store.removedKeys).toContain(FULL_KEY);
  });

  it("SKIPS a note whose subtree still contains a live descendant", async () => {
    const context = build({
      database: {
        selects: {
          deletedNoteCandidates: [
            [{ id: noteId, plan: "free", isDeleted: true, deletedAt: ago(60 * DAY) }],
          ],
          // The recursive CTE reports a child, and the child is NOT deleted.
          liveDescendants: [[{ id: childNoteId }]],
        },
        subtreeIds: [noteId, childNoteId],
      },
    });

    const report = await context.service.runSystemSweeps({ dryRun: false });
    const purge = sweep(report, "deletedNoteRetention");
    expect(purge.notes).toEqual([STORAGE_MAINTENANCE_NOTES.notePurgeSkippedLiveDescendant]);
    expect(purge.selected).toBe(0);
    expect(purge.rowsRemoved).toBe(0);
    expect(purge.sampleIds).toEqual([]);
    expect(context.mutations).toEqual([]);
    expect(context.store.removedKeys).toEqual([]);
  });

  it("never purges a paid workspace whose plan has an unlimited window", async () => {
    const context = build({
      database: {
        selects: {
          deletedNoteCandidates: [
            [
              { id: noteId, plan: "pro", isDeleted: true, deletedAt: ago(400 * DAY) },
              { id: childNoteId, plan: "enterprise", isDeleted: true, deletedAt: ago(400 * DAY) },
            ],
          ],
        },
        subtreeIds: [noteId],
      },
    });

    const report = await context.service.runSystemSweeps({ dryRun: false });
    // The rows are SCANNED (the cutoff uses the shortest finite window) but the
    // per-plan predicate refuses them, so nothing is deleted.
    expect(sweep(report, "deletedNoteRetention").examined).toBe(2);
    expect(sweep(report, "deletedNoteRetention").selected).toBe(0);
    expect(context.mutations).toEqual([]);
  });

  it("never purges a row whose deleted_at is null", async () => {
    const context = build({
      database: {
        selects: {
          deletedNoteCandidates: [[{ id: noteId, plan: "free", isDeleted: true, deletedAt: null }]],
        },
        subtreeIds: [noteId],
      },
    });
    const report = await context.service.runSystemSweeps({ dryRun: false });
    expect(sweep(report, "deletedNoteRetention").selected).toBe(0);
    expect(context.mutations).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Reports, logs, and the authorized entry point                               */
/* -------------------------------------------------------------------------- */

describe("StorageMaintenanceService reporting", () => {
  it("never leaks a key, a filename, or a URL into the report", async () => {
    const context = build({ database: busyFixture() });
    context.store.listing = Object.freeze({
      objects: Object.freeze([{ key: ORIGINAL_KEY, size: 1, lastModified: ago(365 * DAY) }]),
      truncated: false,
    });

    const report = await context.service.runSystemSweeps({ dryRun: false });
    const serialized = JSON.stringify(report);

    for (const secret of [
      ORIGINAL_KEY,
      FULL_KEY,
      MEDIUM_KEY,
      THUMBNAIL_KEY,
      PREVIEW_KEY,
      EXPORT_OBJECT_KEY,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    for (const fragment of [
      "/original/",
      "/thumbnail/",
      "quarterly-report",
      ".png",
      ".webp",
      ".zip",
      "https://",
      '"key"',
      "storage.invalid",
    ]) {
      expect(serialized).not.toContain(fragment);
    }

    const allowedNotes = new Set<string>(Object.values(STORAGE_MAINTENANCE_NOTES));
    const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
    for (const entry of report.sweeps) {
      for (const note of entry.notes) expect(allowedNotes.has(note)).toBe(true);
      for (const id of entry.sampleIds) expect(id).toMatch(uuidPattern);
    }
    // The shared contract is `.strict()`, so any extra field would fail here.
    expect(() => storageMaintenanceReportSchema.parse(report)).not.toThrow();
  });

  it("returns a frozen report naming every sweep exactly once, in plan order", async () => {
    const context = build();
    const report = await context.service.runSystemSweeps({ dryRun: true });
    expect(report.sweeps.map((entry) => entry.sweep)).toEqual([
      "abandonedUploads",
      "orphanedObjects",
      "expiredExports",
      "deletedNoteRetention",
    ]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(report.scope).toBe("system");
    expect(Date.parse(report.finishedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
  });

  it("logs counts per sweep and no key, filename, or free-form reason", async () => {
    const context = build({ database: busyFixture() });
    await context.service.runSystemSweeps({ dryRun: true });
    const info = vi.mocked(context.logger.info);
    expect(info).toHaveBeenCalledTimes(4);
    for (const [metadata] of info.mock.calls) {
      expect(Object.keys(metadata).sort()).toEqual([
        "dryRun",
        "examined",
        "objectsRemoved",
        "rowsMarked",
        "rowsRemoved",
        "scope",
        "selected",
        "sweep",
        "truncated",
      ]);
      expect(JSON.stringify(metadata)).not.toContain("/a/");
    }
  });
});

describe("StorageMaintenanceService.runForWorkspace", () => {
  it("authorizes settings.update and audits COUNTS only", async () => {
    const context = build({ database: busyFixture() });
    const report = await context.service.runForWorkspace({
      principal: principal(),
      workspaceId,
      dryRun: true,
      requestId: "request-9",
    });

    expect(context.authorizeUser).toHaveBeenCalledWith({
      principal: expect.objectContaining({ userId }),
      workspaceId,
      action: "settings.update",
      resource: { kind: "settings" },
      requestId: "request-9",
    });
    expect(report.scope).toBe("workspace");

    const audit = context.mutations.find((mutation) => mutation.table === "auditLogs");
    expect(audit?.kind).toBe("insert");
    expect(audit?.values).toMatchObject({
      workspaceId,
      userId,
      action: "storage.maintenance",
      entityType: "workspace",
      entityId: workspaceId,
      requestId: "request-9",
    });
    // The audit metadata is counts, never keys or filenames.
    expect(JSON.stringify(audit?.values)).not.toContain("/a/");
    expect(JSON.stringify(audit?.values)).not.toContain(EXPORT_OBJECT_KEY);
  });

  it("stops at the authorization entry before any SQL runs", async () => {
    const context = build({ database: busyFixture(), denied: true });
    await expect(
      context.service.runForWorkspace({
        principal: principal(),
        workspaceId,
        dryRun: true,
        requestId: null,
      }),
    ).rejects.toThrow("denied");
    expect(context.log).toEqual([]);
    expect(context.mutations).toEqual([]);
  });

  it("scans only the workspace's own key partition", async () => {
    const context = build();
    const listObjects = vi.spyOn(context.store, "listObjects");
    await context.service.runForWorkspace({
      principal: principal(),
      workspaceId,
      dryRun: true,
      requestId: null,
    });
    expect(listObjects).toHaveBeenCalledWith("attachments", {
      prefix: `w/${workspaceId}/`,
      limit: parseStorageConfig({}).maintenanceObjectScanLimit,
    });
  });
});
