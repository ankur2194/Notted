// Part 45: the four storage-maintenance sweeps, proven against live PostgreSQL
// and live MinIO.
//
// WHY THIS SUITE HAS TO TOUCH REAL BYTES
// `storage-maintenance.selection.ts` is pure and can be proven with no clock and
// no I/O. What it CANNOT prove is the half that makes the sweeps dangerous:
// that the SQL narrows to the right candidates, that `whereWorkspace` really
// confines a scoped run, that the key set read before a cascade is the key set
// deleted after it, and that "removed" means the object is gone from the bucket
// rather than gone from a mock's Map. Every acceptance claim of this part is
// about the object plane, so the object plane is real here.
//
// ISOLATION MODEL — read this before adding a test
// 1. PostgreSQL: every test runs inside ONE transaction that always ends by
//    throwing `RollbackMaintenanceTest`. Nothing is committed, so this suite
//    never contends with the shared `SEED_IDS` rows that `vitest.config.ts`
//    serializes on, and it creates its own users/workspaces/notes instead.
// 2. MinIO cannot join that transaction. Attachment objects MUST live at real
//    `w/{workspaceId}/a/{attachmentId}/{variant}/{token}{ext}` keys or the sweep
//    cannot parse them, so `testKeyPrefix()` is unusable for them. The isolation
//    comes from the workspace partition instead: every workspace id is a fresh
//    `randomUUID()`, so `w/{id}/` is a per-run island that `afterEach` removes.
//    Export objects are not in that key family, so they DO use `testKeyPrefix()`.
//
// WINDOW OVERRIDES — and the one place a zero window is unavoidable
// Row ages are faked by back-dating `created_at` / `deleted_at` with SQL; no
// test ever sleeps. An OBJECT's age is `lastModified`, which MinIO owns and
// which cannot be back-dated, so the only way to make a freshly written object
// look old is to shrink `orphanedObjectCleanupDays` to `0`. That is safe here
// ONLY because every run that uses the aggressive config is workspace-SCOPED,
// which narrows the bucket listing to `w/{ourFreshWorkspaceId}/`. A SYSTEM-scope
// run lists `w/` — the whole bucket — so it is never given a shortened window.
//
// Configs are constructed as literal frozen values rather than by poking
// `process.env`: `StorageConfigProvider` snapshots the environment at
// construction, so an env mutation would be both invisible to an existing
// provider and a cross-suite side effect in Vitest's shared process.

//
// SPLIT FROM `storage-maintenance.integration.test.ts` (1 666 lines): the
// fixtures live here, the authorization suite and the sweep suite are their own
// files. Vitest gives every TEST FILE its own module registry, so each suite now
// gets a private copy of `createdWorkspaceIds` and `createdExportKeys` — the
// isolation the shared mutable arrays previously needed an `afterEach` reset to
// fake. Those resets stay: deleting them would be a behaviour change to a test,
// and they cost nothing.
//

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Readable } from "node:stream";

import { eq } from "drizzle-orm";
import { Client as MinioClient } from "minio";
import { expect, vi } from "vitest";

import { buildAttachmentObjectKey } from "../src/attachments/attachment-storage-key";
import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import { parseMinioConfig } from "../src/config/minio.config";
import { DatabaseService, type DatabaseTransaction } from "../src/database/database.service";
import {
  attachments,
  exportJobs,
  notes,
  users,
  workspaceMembers,
  workspaces,
} from "../src/database/schema";
import { ObjectStorageService } from "../src/infrastructure/minio/object-storage.service";
import { StorageMaintenanceService } from "../src/maintenance/storage-maintenance.service";
import { TenantContextService } from "../src/tenant";

import { testKeyPrefix } from "./minio-test-helpers";

import type { StructuredLogger } from "../src/common/logging/structured-logger.service";
import type { RetentionConfig } from "../src/config/retention.config";
import type { SecurityConfig } from "../src/config/security.config";
import type { StorageConfig } from "../src/config/storage.config";
import type { AttachmentVariantRecord } from "../src/database/schema";
import type {
  ListObjectsOptions,
  ListObjectsResult,
  ObjectStore,
  StorageBucket,
  StoredObjectStat,
} from "../src/infrastructure/minio/object-storage.service";
import type {
  AuthenticatedPrincipal,
  StorageMaintenanceReport,
  StorageMaintenanceSweepName,
  StorageMaintenanceSweepReport,
  WorkspacePlan,
} from "@notted/shared-types";

export const DATABASE_URL = process.env.DATABASE_URL;
export const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");

export const GIB = 1_024 * 1_024 * 1_024;
export const HOUR_MS = 60 * 60 * 1_000;
export const DAY_MS = 24 * HOUR_MS;

/** Small, generated at test time. A committed binary fixture cannot be reviewed. */
export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(120, 0x22),
]);

export const security = {
  maximumUploadBytes: 50 * 1_024 * 1_024,
  maximumWorkspaceStorageBytes: 10 * GIB,
  signedUrlTtlSeconds: 900,
} as unknown as SecurityConfig;

export class RollbackMaintenanceTest extends Error {}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

export function storageConfig(overrides: Partial<StorageConfig> = {}): StorageConfig {
  return Object.freeze({
    planDefaultBytes: Object.freeze({ free: GIB, pro: 10 * GIB, enterprise: 100 * GIB }),
    abandonedUploadHours: 24,
    maintenanceEnabled: false,
    maintenanceDryRun: false,
    maintenanceIntervalMs: 3_600_000,
    maintenanceBatchLimit: 200,
    maintenanceObjectScanLimit: 5_000,
    ...overrides,
  });
}

export function retentionConfig(overrides: Partial<RetentionConfig> = {}): RetentionConfig {
  return Object.freeze({
    deletedNoteRetentionDaysFree: 30,
    deletedNoteRetentionDaysPro: null,
    deletedNoteRetentionDaysEnterprise: null,
    noteVersionRetentionDaysFree: 30,
    noteVersionRetentionDaysPro: null,
    noteVersionRetentionDaysEnterprise: null,
    auditLogRetentionDays: 365,
    exportObjectRetentionDays: 7,
    sessionShortLivedHours: 24,
    sessionRememberMeDays: 30,
    orphanedObjectCleanupDays: 7,
    ...overrides,
  });
}

/**
 * Windows short enough that back-dated rows and freshly written objects are
 * both selectable. `orphanedObjectCleanupDays: 0` removes the object-age grace
 * period entirely — see the header. ONLY EVER USED WITH `runForWorkspace`.
 */
export const AGGRESSIVE_STORAGE = storageConfig({ abandonedUploadHours: 1 });
export const AGGRESSIVE_RETENTION = retentionConfig({ orphanedObjectCleanupDays: 0 });

/**
 * Windows so long that nothing anywhere is selectable. Used for the one run this
 * suite performs at SYSTEM scope with `dryRun: false`: that run deliberately
 * crosses every workspace in the database, so it must not be able to delete a
 * row or an object belonging to anyone.
 *
 * The expired-export sweep is the one sweep with no window to lengthen — it is
 * driven by `exports.object_expires_at`. The `exports` table has no producer
 * until Part 62, and this suite creates no export row in the fixture used for
 * the system-scope run, so that sweep has nothing to act on.
 */
export const CONSERVATIVE_STORAGE = storageConfig({ abandonedUploadHours: 24 * 365 });
export const CONSERVATIVE_RETENTION = retentionConfig({
  orphanedObjectCleanupDays: 36_500,
  deletedNoteRetentionDaysFree: 36_500,
});

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

export function principal(userId: string): AuthenticatedPrincipal {
  return Object.freeze({
    userId,
    sessionId: `session:${userId}`,
    method: "opaque-session",
    assurance: "single-factor",
    authenticatedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isFresh: true,
  });
}

export function scopedDatabase(tx: DatabaseTransaction): DatabaseService {
  return {
    db: tx,
    transaction: <T>(work: (scope: DatabaseTransaction) => Promise<T>): Promise<T> =>
      tx.transaction(work),
  } as unknown as DatabaseService;
}

export function silentLogger(): StructuredLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as StructuredLogger;
}

export function realStorage(): ObjectStorageService {
  const config = parseMinioConfig(process.env);
  const client = new MinioClient({
    endPoint: config.endPoint,
    port: config.port,
    useSSL: config.useSsl,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    region: config.region,
  });
  return new ObjectStorageService(client, config, security, silentLogger());
}

export function buildMaintenanceService(input: {
  readonly database: DatabaseService;
  readonly objects: ObjectStore;
  readonly storage?: StorageConfig;
  readonly retention?: RetentionConfig;
}): StorageMaintenanceService {
  const tenant = new TenantContextService();
  const entry = new AuthorizationEntryService(
    new AuthorizationRepository(input.database, tenant),
    new AuthorizationPolicyService(),
    tenant,
  );
  return new StorageMaintenanceService(
    input.database,
    entry,
    tenant,
    input.objects,
    input.retention ?? retentionConfig(),
    input.storage ?? storageConfig(),
    silentLogger(),
  );
}

/** In-memory `ObjectStore` for the assertions that need no real bytes. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();

  isEnabled(): boolean {
    return true;
  }

  putObject(_bucket: StorageBucket, key: string, body: Buffer): Promise<{ etag: string }> {
    this.objects.set(key, body);
    return Promise.resolve({ etag: "etag" });
  }

  getObjectStream(_bucket: StorageBucket, key: string): Promise<Readable> {
    const body = this.objects.get(key);
    return body === undefined
      ? Promise.reject(new Error("NoSuchKey"))
      : Promise.resolve(Readable.from([body]));
  }

  statObject(_bucket: StorageBucket, key: string): Promise<StoredObjectStat | null> {
    const body = this.objects.get(key);
    return Promise.resolve(
      body === undefined
        ? null
        : { size: body.byteLength, etag: "etag", lastModified: new Date(), contentType: null },
    );
  }

  listObjects(_bucket: StorageBucket, options: ListObjectsOptions): Promise<ListObjectsResult> {
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(options.prefix))
      .slice(0, options.limit)
      .map(([key, body]) => ({ key, size: body.byteLength, lastModified: new Date(0) }));
    return Promise.resolve({ objects, truncated: false });
  }

  removeObject(_bucket: StorageBucket, key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  removeObjects(_bucket: StorageBucket, keys: readonly string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
    return Promise.resolve();
  }

  presignedGetUrl(): Promise<string> {
    return Promise.resolve("https://storage.invalid/signed");
  }
}

/* -------------------------------------------------------------------------- */
/* Fixture builders                                                            */
/* -------------------------------------------------------------------------- */

export interface WorkspaceFixture {
  readonly workspaceId: string;
  readonly owner: string;
  readonly admin: string;
  readonly editor: string;
  readonly viewer: string;
  readonly outsider: string;
  readonly liveNoteId: string;
}

/** Ids of every workspace whose `w/{id}/` object island must be swept up. */
export const createdWorkspaceIds: string[] = [];
/** Export-bucket keys created under a `test/` prefix. */
export const createdExportKeys: string[] = [];

export async function insertUser(tx: DatabaseTransaction, label: string): Promise<string> {
  const id = randomUUID();
  await tx.insert(users).values({ id, email: `${label}.${id}@maintenance.invalid`, name: label });
  return id;
}

export async function insertNote(
  tx: DatabaseTransaction,
  input: {
    readonly workspaceId: string;
    readonly createdById: string;
    readonly title: string;
    readonly deletedDaysAgo?: number;
  },
): Promise<string> {
  const id = randomUUID();
  await tx.insert(notes).values({
    id,
    workspaceId: input.workspaceId,
    title: input.title,
    createdById: input.createdById,
  });
  if (input.deletedDaysAgo !== undefined) {
    // Back-dated rather than waited for: the sweep reads `deleted_at`, so a
    // direct update is indistinguishable from real elapsed time.
    await tx
      .update(notes)
      .set({ isDeleted: true, deletedAt: new Date(Date.now() - input.deletedDaysAgo * DAY_MS) })
      .where(eq(notes.id, id));
  }
  return id;
}

export async function createWorkspaceFixture(
  tx: DatabaseTransaction,
  plan: WorkspacePlan = "free",
): Promise<WorkspaceFixture> {
  const owner = await insertUser(tx, "owner");
  const admin = await insertUser(tx, "admin");
  const editor = await insertUser(tx, "editor");
  const viewer = await insertUser(tx, "viewer");
  const outsider = await insertUser(tx, "outsider");

  const workspaceId = randomUUID();
  await tx.insert(workspaces).values({
    id: workspaceId,
    name: `maintenance fixture ${workspaceId}`,
    slug: `maintenance-fixture-${workspaceId}`,
    plan,
    createdById: owner,
  });
  createdWorkspaceIds.push(workspaceId);

  await tx.insert(workspaceMembers).values([
    { workspaceId, userId: owner, role: "owner" },
    { workspaceId, userId: admin, role: "admin" },
    { workspaceId, userId: editor, role: "editor" },
    { workspaceId, userId: viewer, role: "viewer" },
  ]);

  const liveNoteId = await insertNote(tx, {
    workspaceId,
    createdById: owner,
    title: "Live note",
  });
  return Object.freeze({ workspaceId, owner, admin, editor, viewer, outsider, liveNoteId });
}

export interface StoredAttachment {
  readonly id: string;
  /** Every object key the row claims. `[0]` is always the primary `storage_key`. */
  readonly keys: readonly string[];
}

/** The row's `storage_key` — the only key `markRowsWithMissingObjects` stats. */
export function primaryKey(attachment: StoredAttachment): string {
  const key = attachment.keys[0];
  if (key === undefined) throw new Error("fixture attachment has no object key");
  return key;
}

/**
 * A `ready` attachment whose every declared variant really exists in the bucket.
 *
 * The `preview` slot is included because `attachmentObjectKeys` treats it as an
 * object-bearing variant: if a cleanup path ever forgot it, only a fixture that
 * carries one can catch the stranded bytes.
 */
export async function createReadyAttachment(
  tx: DatabaseTransaction,
  store: ObjectStore,
  input: {
    readonly workspaceId: string;
    readonly noteId: string;
    readonly createdById: string;
    readonly originalName: string;
    readonly createdDaysAgo?: number;
  },
): Promise<StoredAttachment> {
  const attachmentId = randomUUID();
  const objectKey = (
    variant: "original" | "full" | "medium" | "thumbnail",
    extension: ".png" | ".webp",
  ): string =>
    buildAttachmentObjectKey({ workspaceId: input.workspaceId, attachmentId, variant, extension });

  const original = objectKey("original", ".png");
  const full = objectKey("full", ".png");
  const medium = objectKey("medium", ".png");
  const thumbnail = objectKey("thumbnail", ".png");
  // `preview` has no key-builder variant of its own; Part 44 writes it into the
  // `thumbnail` slot family. A `thumbnail`-shaped key with a different token and
  // extension gives the record a fifth, distinct object the sweeps must account
  // for — `attachmentObjectKeys` treats `preview` as object-bearing.
  const preview = objectKey("thumbnail", ".webp");

  for (const key of [original, full, medium, thumbnail]) {
    await store.putObject("attachments", key, PNG, {
      contentType: "image/png",
      contentLength: PNG.byteLength,
    });
  }
  await store.putObject("attachments", preview, PNG, {
    contentType: "image/webp",
    contentLength: PNG.byteLength,
  });

  const dimensions = { width: 16, height: 16, bytes: PNG.byteLength, mimeType: "image/png" };
  const variants: AttachmentVariantRecord = {
    original: { key: original, ...dimensions },
    full: { key: full, ...dimensions },
    medium: { key: medium, ...dimensions },
    thumbnail: { key: thumbnail, ...dimensions },
    preview: { key: preview, mimeType: "image/webp", width: 4, height: 4 },
  };

  await tx.insert(attachments).values({
    id: attachmentId,
    noteId: input.noteId,
    workspaceId: input.workspaceId,
    originalName: input.originalName,
    filename: input.originalName,
    mimeType: "image/png",
    sizeBytes: PNG.byteLength,
    storageKey: original,
    // `image`, deliberately: the report-only unreferenced-attachment scan looks
    // at `file` rows, and keeping it out of that class keeps sweep counts exact.
    mediaType: "image",
    processingStatus: "ready",
    variants,
    createdById: input.createdById,
  });
  if (input.createdDaysAgo !== undefined) {
    await tx
      .update(attachments)
      .set({ createdAt: new Date(Date.now() - input.createdDaysAgo * DAY_MS) })
      .where(eq(attachments.id, attachmentId));
  }
  return Object.freeze({
    id: attachmentId,
    keys: Object.freeze([original, full, medium, thumbnail, preview]),
  });
}

/** A `pending`/`processing`/`failed` row that owns exactly its primary object. */
export async function createInFlightAttachment(
  tx: DatabaseTransaction,
  store: ObjectStore,
  input: {
    readonly workspaceId: string;
    readonly noteId: string;
    readonly createdById: string;
    readonly status: "pending" | "processing" | "failed";
    readonly ageMs: number;
  },
): Promise<StoredAttachment> {
  const attachmentId = randomUUID();
  const key = buildAttachmentObjectKey({
    workspaceId: input.workspaceId,
    attachmentId,
    variant: "original",
    extension: ".png",
  });
  await store.putObject("attachments", key, PNG, {
    contentType: "image/png",
    contentLength: PNG.byteLength,
  });
  await tx.insert(attachments).values({
    id: attachmentId,
    noteId: input.noteId,
    workspaceId: input.workspaceId,
    originalName: `in-flight-${input.status}.png`,
    filename: `in-flight-${input.status}.png`,
    mimeType: "image/png",
    sizeBytes: PNG.byteLength,
    storageKey: key,
    mediaType: "image",
    processingStatus: input.status,
    variants: {},
    createdById: input.createdById,
  });
  await tx
    .update(attachments)
    .set({ createdAt: new Date(Date.now() - input.ageMs) })
    .where(eq(attachments.id, attachmentId));
  return Object.freeze({ id: attachmentId, keys: Object.freeze([key]) });
}

/** An object with a valid attachment key whose attachment id belongs to no row. */
export async function createOrphanedObject(
  store: ObjectStore,
  workspaceId: string,
): Promise<string> {
  const key = buildAttachmentObjectKey({
    workspaceId,
    attachmentId: randomUUID(),
    variant: "original",
    extension: ".png",
  });
  await store.putObject("attachments", key, PNG, {
    contentType: "image/png",
    contentLength: PNG.byteLength,
  });
  return key;
}

/** A `ready` export past its object expiry, with its object present. */
export async function createExpiredExport(
  tx: DatabaseTransaction,
  store: ObjectStore,
  input: { readonly workspaceId: string; readonly requestedById: string },
): Promise<{ readonly id: string; readonly key: string }> {
  // Export keys are NOT in the attachment key family, so this one can and does
  // use the shared test prefix. `removeTestObjects` only sweeps the attachments
  // bucket, so `afterEach` removes it from the exports bucket explicitly.
  const key = `${testKeyPrefix()}export.zip`;
  createdExportKeys.push(key);
  await store.putObject("exports", key, PNG, {
    contentType: "application/zip",
    contentLength: PNG.byteLength,
  });
  const id = randomUUID();
  await tx.insert(exportJobs).values({
    id,
    workspaceId: input.workspaceId,
    requestedById: input.requestedById,
    format: "zip",
    status: "ready",
    sourceType: "workspace",
    objectKey: key,
    objectExpiresAt: new Date(Date.now() - DAY_MS),
  });
  return { id, key };
}

/* -------------------------------------------------------------------------- */
/* Assertion helpers                                                           */
/* -------------------------------------------------------------------------- */

export function sweep(
  report: StorageMaintenanceReport,
  name: StorageMaintenanceSweepName,
): StorageMaintenanceSweepReport {
  const found = report.sweeps.find((entry) => entry.sweep === name);
  if (found === undefined) throw new Error(`report is missing the ${name} sweep`);
  return found;
}

export function mutationCounts(report: StorageMaintenanceReport): {
  rowsRemoved: number;
  rowsMarked: number;
  objectsRemoved: number;
} {
  return report.sweeps.reduce(
    (total, entry) => ({
      rowsRemoved: total.rowsRemoved + entry.rowsRemoved,
      rowsMarked: total.rowsMarked + entry.rowsMarked,
      objectsRemoved: total.objectsRemoved + entry.objectsRemoved,
    }),
    { rowsRemoved: 0, rowsMarked: 0, objectsRemoved: 0 },
  );
}

/**
 * Every sweep name must appear exactly once, in the documented order, and the
 * serialized report must contain nothing but counts, UUIDs, and fixed codes.
 */
export function expectSafeReport(
  report: StorageMaintenanceReport,
  secrets: readonly string[],
): void {
  expect(report.sweeps.map((entry) => entry.sweep)).toEqual([
    "abandonedUploads",
    "orphanedObjects",
    "expiredExports",
    "deletedNoteRetention",
  ]);
  const serialized = JSON.stringify(report);
  for (const secret of secrets) {
    expect(serialized, `report leaked ${secret}`).not.toContain(secret);
  }
  // Nothing that looks like an object key or a file extension may appear.
  expect(serialized).not.toMatch(/w\/[\da-f-]{36}\/a\//u);
  expect(serialized).not.toMatch(/\.(?:png|webp|zip|bin|jpg)/u);
}

export async function keysUnderWorkspace(
  storage: ObjectStorageService,
  workspaceId: string,
): Promise<string[]> {
  const listing = await storage.listObjects("attachments", {
    prefix: `w/${workspaceId}/`,
    limit: 1_000,
  });
  return listing.objects.map((object) => object.key).sort();
}

export async function attachmentRowIds(
  tx: DatabaseTransaction,
  workspaceId: string,
): Promise<{ readonly id: string; readonly status: string }[]> {
  const rows = await tx
    .select({ id: attachments.id, status: attachments.processingStatus })
    .from(attachments)
    .where(eq(attachments.workspaceId, workspaceId));
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export async function expectObjectsPresent(
  storage: ObjectStorageService,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    // `statObject` resolves `null` ONLY for a positive 404, so this really does
    // distinguish "still there" from "storage had a bad day".
    expect(await storage.statObject("attachments", key), "object was removed").not.toBeNull();
  }
}

export async function expectObjectsAbsent(
  storage: ObjectStorageService,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    expect(await storage.statObject("attachments", key), "object was stranded").toBeNull();
  }
}
