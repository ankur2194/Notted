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

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Readable } from "node:stream";

import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client as MinioClient } from "minio";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { buildAttachmentObjectKey } from "../src/attachments/attachment-storage-key";
import { ATTACHMENT_PROCESSING_ERRORS } from "../src/attachments/attachments.constants";
import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import { parseMinioConfig } from "../src/config/minio.config";
import { DatabaseService, type DatabaseTransaction } from "../src/database/database.service";
import {
  attachments,
  auditLogs,
  exportJobs,
  notes,
  schema,
  users,
  workspaceMembers,
  workspaces,
} from "../src/database/schema";
import { ObjectStorageService } from "../src/infrastructure/minio/object-storage.service";
import {
  STORAGE_MAINTENANCE_AUDIT_ACTION,
  STORAGE_MAINTENANCE_AUDIT_ENTITY_TYPE,
  STORAGE_MAINTENANCE_NOTES,
} from "../src/maintenance/maintenance.constants";
import { StorageMaintenanceService } from "../src/maintenance/storage-maintenance.service";
import { TenantContextService } from "../src/tenant";

import { HAS_DATABASE, requireDatabase } from "./database-test-helpers";
import { HAS_MINIO, isMinioReachable, testKeyPrefix } from "./minio-test-helpers";

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

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");

const GIB = 1_024 * 1_024 * 1_024;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

/** Small, generated at test time. A committed binary fixture cannot be reviewed. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(120, 0x22),
]);

const security = {
  maximumUploadBytes: 50 * 1_024 * 1_024,
  maximumWorkspaceStorageBytes: 10 * GIB,
  signedUrlTtlSeconds: 900,
} as unknown as SecurityConfig;

class RollbackMaintenanceTest extends Error {}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

function storageConfig(overrides: Partial<StorageConfig> = {}): StorageConfig {
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

function retentionConfig(overrides: Partial<RetentionConfig> = {}): RetentionConfig {
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
const AGGRESSIVE_STORAGE = storageConfig({ abandonedUploadHours: 1 });
const AGGRESSIVE_RETENTION = retentionConfig({ orphanedObjectCleanupDays: 0 });

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
const CONSERVATIVE_STORAGE = storageConfig({ abandonedUploadHours: 24 * 365 });
const CONSERVATIVE_RETENTION = retentionConfig({
  orphanedObjectCleanupDays: 36_500,
  deletedNoteRetentionDaysFree: 36_500,
});

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

function principal(userId: string): AuthenticatedPrincipal {
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

function scopedDatabase(tx: DatabaseTransaction): DatabaseService {
  return {
    db: tx,
    transaction: <T>(work: (scope: DatabaseTransaction) => Promise<T>): Promise<T> =>
      tx.transaction(work),
  } as unknown as DatabaseService;
}

function silentLogger(): StructuredLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as StructuredLogger;
}

function realStorage(): ObjectStorageService {
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

function buildMaintenanceService(input: {
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
class MemoryObjectStore implements ObjectStore {
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

interface WorkspaceFixture {
  readonly workspaceId: string;
  readonly owner: string;
  readonly admin: string;
  readonly editor: string;
  readonly viewer: string;
  readonly outsider: string;
  readonly liveNoteId: string;
}

/** Ids of every workspace whose `w/{id}/` object island must be swept up. */
const createdWorkspaceIds: string[] = [];
/** Export-bucket keys created under a `test/` prefix. */
const createdExportKeys: string[] = [];

async function insertUser(tx: DatabaseTransaction, label: string): Promise<string> {
  const id = randomUUID();
  await tx.insert(users).values({ id, email: `${label}.${id}@maintenance.invalid`, name: label });
  return id;
}

async function insertNote(
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

async function createWorkspaceFixture(
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

interface StoredAttachment {
  readonly id: string;
  /** Every object key the row claims. `[0]` is always the primary `storage_key`. */
  readonly keys: readonly string[];
}

/** The row's `storage_key` — the only key `markRowsWithMissingObjects` stats. */
function primaryKey(attachment: StoredAttachment): string {
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
async function createReadyAttachment(
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
async function createInFlightAttachment(
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
async function createOrphanedObject(store: ObjectStore, workspaceId: string): Promise<string> {
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
async function createExpiredExport(
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

function sweep(
  report: StorageMaintenanceReport,
  name: StorageMaintenanceSweepName,
): StorageMaintenanceSweepReport {
  const found = report.sweeps.find((entry) => entry.sweep === name);
  if (found === undefined) throw new Error(`report is missing the ${name} sweep`);
  return found;
}

function mutationCounts(report: StorageMaintenanceReport): {
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
function expectSafeReport(report: StorageMaintenanceReport, secrets: readonly string[]): void {
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

async function keysUnderWorkspace(
  storage: ObjectStorageService,
  workspaceId: string,
): Promise<string[]> {
  const listing = await storage.listObjects("attachments", {
    prefix: `w/${workspaceId}/`,
    limit: 1_000,
  });
  return listing.objects.map((object) => object.key).sort();
}

async function attachmentRowIds(
  tx: DatabaseTransaction,
  workspaceId: string,
): Promise<{ readonly id: string; readonly status: string }[]> {
  const rows = await tx
    .select({ id: attachments.id, status: attachments.processingStatus })
    .from(attachments)
    .where(eq(attachments.workspaceId, workspaceId));
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

async function expectObjectsPresent(
  storage: ObjectStorageService,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    // `statObject` resolves `null` ONLY for a positive 404, so this really does
    // distinguish "still there" from "storage had a bad day".
    expect(await storage.statObject("attachments", key), "object was removed").not.toBeNull();
  }
}

async function expectObjectsAbsent(
  storage: ObjectStorageService,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    expect(await storage.statObject("attachments", key), "object was stranded").toBeNull();
  }
}

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
