import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Readable } from "node:stream";

import { and, eq, like, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client as MinioClient } from "minio";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ATTACHMENT_AUDIT_ACTIONS,
  ATTACHMENT_DOMAIN_EVENTS,
  ATTACHMENT_DOMAIN_EVENT_QUEUE,
} from "../src/attachments/attachments.constants";
import { AttachmentsService } from "../src/attachments/attachments.service";
import {
  PassthroughImageProcessor,
  type ImageProcessor,
} from "../src/attachments/image-processing";
import { allowAuditDelete } from "../src/audit/audit-record";
import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import { parseMinioConfig } from "../src/config/minio.config";
import { parseStorageConfig } from "../src/config/storage.config";
import { DatabaseService, type DatabaseTransaction } from "../src/database/database.service";
import {
  attachments,
  auditLogs,
  jobOutbox,
  projects,
  schema,
  workspaces,
} from "../src/database/schema";
import { SEED_IDS, seedDatabase } from "../src/database/seed";
import { ObjectStorageService } from "../src/infrastructure/minio/object-storage.service";
import { StorageQuotaService } from "../src/storage/storage-quota.service";
import { TenantContextService } from "../src/tenant";

import { HAS_DATABASE, requireDatabase } from "./database-test-helpers";
import {
  HAS_MINIO,
  isMinioReachable,
  removeTestObjects,
  testKeyPrefix,
} from "./minio-test-helpers";

import type { StructuredLogger } from "../src/common/logging/structured-logger.service";
import type { SecurityConfig } from "../src/config/security.config";
import type {
  ListObjectsResult,
  ObjectStore,
  StorageBucket,
  StoredObjectStat,
} from "../src/infrastructure/minio/object-storage.service";
import type { NoteSearchIndexProducer } from "../src/search/note-search-index-producer";
import type { AuthenticatedPrincipal } from "@notted/shared-types";
import type { PgTransactionConfig } from "drizzle-orm/pg-core/session";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");

/** Marks every row the concurrency test COMMITS so a rerun clears its own leftovers. */
const QUOTA_FIXTURE = "quota-concurrency-fixture";

/**
 * Removes EVERY row the concurrency test commits, not just the attachments.
 *
 * That test is the one place in this file whose writes are not rolled back, so
 * a successful upload also commits a `job_outbox` intent and two `audit_logs`
 * entries. Deleting only the `attachments` rows leaves those behind as dangling
 * references to an attachment id that no longer exists, and they accumulate on
 * every run — which is exactly what made the `attachment.created` outbox lookup
 * in the rollback test return a foreign row. Children go first so the delete
 * order never depends on how the foreign keys happen to cascade.
 */
async function purgeQuotaFixtureRows(live: NodePgDatabase<typeof schema>): Promise<void> {
  const rows = await live
    .select({ id: attachments.id })
    .from(attachments)
    .where(like(attachments.originalName, `${QUOTA_FIXTURE}%`));
  for (const { id } of rows) {
    await live.delete(jobOutbox).where(like(jobOutbox.idempotencyKey, `%:${id}:%`));
    // The append-only trigger (migration 0021) refuses this DELETE unless
    // `notted.audit_purge` is set for the transaction.
    await live.transaction(async (tx) => {
      await allowAuditDelete(tx);
      await tx.delete(auditLogs).where(eq(auditLogs.entityId, id));
    });
  }
  await live.delete(attachments).where(like(attachments.originalName, `${QUOTA_FIXTURE}%`));
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(120, 0x22),
]);

/* -------------------------------------------------------------------------- */
/* Part 44 fixtures — generated here, never committed as binaries               */
/* -------------------------------------------------------------------------- */

function padded(signature: Buffer, size = 96): Buffer {
  return Buffer.concat([signature, Buffer.alloc(size, 0x41)]);
}

function zipContainer(firstEntryName: string): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04_03_4b_50, 0);
  header.writeUInt16LE(firstEntryName.length, 26);
  return Buffer.concat([header, Buffer.from(firstEntryName, "latin1"), Buffer.alloc(64, 0x00)]);
}

function tarArchive(): Buffer {
  const block = Buffer.alloc(512, 0x00);
  block.write("payload.txt", 0, "latin1");
  Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72, 0x00]).copy(block, 257);
  return block;
}

/**
 * One case per `Notted.md` §6 file category, so the lifecycle is proven for each
 * rather than for "a file". Every payload is built from its magic bytes at test
 * time — a committed fixture cannot be reviewed in a diff.
 */
const FILE_CATEGORIES: readonly {
  readonly label: string;
  readonly bytes: Buffer;
  readonly filename: string;
  readonly mimeType: string;
  readonly displayName: string;
}[] = Object.freeze([
  {
    label: "document (PDF)",
    bytes: padded(Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")),
    filename: "Quarterly Report.pdf",
    mimeType: "application/pdf",
    displayName: "Quarterly Report.pdf",
  },
  {
    label: "document (RTF)",
    bytes: padded(Buffer.from("{\\rtf1\\ansi hello}", "latin1")),
    filename: "letter.rtf",
    mimeType: "application/rtf",
    displayName: "letter.rtf",
  },
  {
    label: "document (DOCX, an OOXML ZIP)",
    bytes: zipContainer("[Content_Types].xml"),
    filename: "spec.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    displayName: "spec.docx",
  },
  {
    label: "spreadsheet (XLSX, an OOXML ZIP)",
    bytes: zipContainer("[Content_Types].xml"),
    filename: "budget.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    displayName: "budget.xlsx",
  },
  {
    label: "spreadsheet (CSV, text)",
    bytes: Buffer.from("name,size\nreport,12\n", "utf8"),
    filename: "budget.csv",
    mimeType: "text/plain",
    displayName: "budget.csv",
  },
  {
    label: "archive (ZIP)",
    bytes: zipContainer("photos/holiday.jpg"),
    filename: "release.zip",
    mimeType: "application/zip",
    displayName: "release.zip",
  },
  {
    label: "archive (RAR)",
    bytes: padded(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])),
    filename: "backup.rar",
    mimeType: "application/vnd.rar",
    displayName: "backup.rar",
  },
  {
    label: "archive (7Z)",
    bytes: padded(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])),
    filename: "backup.7z",
    mimeType: "application/x-7z-compressed",
    displayName: "backup.7z",
  },
  {
    label: "archive (TAR)",
    bytes: tarArchive(),
    filename: "bundle.tar",
    mimeType: "application/x-tar",
    displayName: "bundle.tar",
  },
  {
    label: "archive (GZIP)",
    bytes: padded(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03])),
    filename: "logs.gz",
    mimeType: "application/gzip",
    displayName: "logs.gz",
  },
  {
    label: "code (Python, text)",
    bytes: Buffer.from("def main() -> None:\n    print('hi')\n", "utf8"),
    filename: "script.py",
    mimeType: "text/plain",
    displayName: "script.py",
  },
  {
    label: "code (HTML, stored inert as text)",
    bytes: Buffer.from("<script>alert(1)</script>\n", "utf8"),
    filename: "payload.html",
    mimeType: "text/plain",
    displayName: "payload.html",
  },
]);

const security = {
  maximumUploadBytes: 50 * 1_024 * 1_024,
  maximumWorkspaceStorageBytes: 10 * 1_024 * 1_024 * 1_024,
  signedUrlTtlSeconds: 900,
} as unknown as SecurityConfig;

/**
 * The shipped defaults, parsed from an EMPTY environment rather than
 * `process.env`: hermetic, and it stays correct if a default moves. These tests
 * set `workspaces.storage_limit_bytes` explicitly anyway, so the plan table only
 * has to be present and sane.
 */
const storageConfig = parseStorageConfig({});

class RollbackAttachmentsTest extends Error {}

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

/**
 * In-memory object store. MinIO cannot join the PostgreSQL rollback
 * transaction, so the tenant-isolation suite substitutes it and asserts that
 * possession of a real, current object key still grants nothing.
 */
class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  readonly calls: string[] = [];
  failOnPutNumber: number | null = null;
  private puts = 0;

  isEnabled(): boolean {
    return true;
  }

  putObject(_bucket: StorageBucket, key: string, body: Buffer): Promise<{ etag: string }> {
    this.puts += 1;
    this.calls.push(`put:${key}`);
    if (this.failOnPutNumber === this.puts) {
      return Promise.reject(new Error("injected storage failure"));
    }
    this.objects.set(key, body);
    return Promise.resolve({ etag: `etag-${this.puts}` });
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
        : {
            size: body.byteLength,
            etag: `etag-${key.slice(-8)}`,
            lastModified: new Date("2026-08-01T00:00:00Z"),
            contentType: "image/png",
          },
    );
  }

  removeObject(_bucket: StorageBucket, key: string): Promise<void> {
    this.calls.push(`remove:${key}`);
    this.objects.delete(key);
    return Promise.resolve();
  }

  removeObjects(_bucket: StorageBucket, keys: readonly string[]): Promise<void> {
    this.calls.push(`removeMany:${keys.length}`);
    for (const key of keys) this.objects.delete(key);
    return Promise.resolve();
  }

  /**
   * Part 45's reconciliation sweep is the only `listObjects` caller and never
   * runs in this suite, so an empty, non-truncated page is the honest answer.
   */
  listObjects(): Promise<ListObjectsResult> {
    return Promise.resolve({ objects: [], truncated: false });
  }

  presignedGetUrl(): Promise<string> {
    return Promise.resolve("https://storage.invalid/signed");
  }
}

/** Part 41-shaped processor: two objects, so a partial failure is reachable. */
const twoObjectProcessor: ImageProcessor = {
  maximumInputBytes: 15 * 1_024 * 1_024,
  supports: () => true,
  process: (request) =>
    Promise.resolve({
      width: 16,
      height: 16,
      blur: null,
      objects: [
        {
          variant: "original" as const,
          body: request.buffer,
          mimeType: "image/png",
          width: 16,
          height: 16,
        },
        {
          variant: "thumbnail" as const,
          body: request.buffer,
          mimeType: "image/webp",
          width: 4,
          height: 4,
        },
      ],
    }),
};

/**
 * The REAL `StorageQuotaService` is wired in, not a double.
 *
 * Part 45's "concurrent uploads cannot bypass the quota" criterion is a property
 * of `SELECT ... FOR UPDATE` on the workspace row against real PostgreSQL. A
 * stub here would make the concurrency test below assert nothing.
 */
function buildService(
  database: DatabaseService,
  store: ObjectStore,
  processor: ImageProcessor = new PassthroughImageProcessor(),
): AttachmentsService {
  const tenant = new TenantContextService();
  const entry = new AuthorizationEntryService(
    new AuthorizationRepository(database, tenant),
    new AuthorizationPolicyService(),
    tenant,
  );
  const quota = new StorageQuotaService(database, entry, tenant, security, storageConfig);
  return new AttachmentsService(
    database,
    entry,
    tenant,
    store,
    processor,
    security,
    { warn: vi.fn() } as unknown as StructuredLogger,
    quota,
    { scheduleSearchSync: async () => undefined } as unknown as NoteSearchIndexProducer,
  );
}

describe.skipIf(!HAS_DATABASE)("Part 40 secure object storage (live PostgreSQL)", () => {
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;

  beforeAll(async () => {
    await requireDatabase();

    pool = new Pool({ connectionString: DATABASE_URL as string, max: 8 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  it("enforces tenant isolation, key non-authority, permission loss, cleanup, and durable intents", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const database = {
          db: tx,
          transaction: <T>(work: (scope: DatabaseTransaction) => Promise<T>): Promise<T> =>
            tx.transaction(work),
        } as unknown as DatabaseService;
        const store = new MemoryObjectStore();
        const service = buildService(database, store);

        const owner = principal(SEED_IDS.users.alphaOwner);
        const editor = principal(SEED_IDS.users.alphaEditor);
        const betaOwner = principal(SEED_IDS.users.betaOwner);
        const alpha = SEED_IDS.workspaces.alpha;
        const noteId = SEED_IDS.notes.alphaProjectOverview;
        const suffix = randomUUID();

        const uploaded = await service.uploadImage({
          principal: owner,
          workspaceId: alpha,
          noteId,
          buffer: PNG,
          declaredMimeType: "text/html",
          declaredFilename: "../../etc/passwd",
          idempotencyKey: `attachment-live-${suffix}`,
        });
        expect(uploaded.attachment.status).toBe("ready");
        expect(uploaded.attachment.mimeType).toBe("image/png");
        expect(uploaded.attachment.displayName).toBe("passwd.png");
        const attachmentId = uploaded.attachment.id;

        // Replaying the same idempotency key returns the same resource.
        const replay = await service.uploadImage({
          principal: owner,
          workspaceId: alpha,
          noteId,
          buffer: PNG,
          declaredMimeType: "text/html",
          declaredFilename: "../../etc/passwd",
          idempotencyKey: `attachment-live-${suffix}`,
        });
        expect(replay.attachment.id).toBe(attachmentId);
        expect(store.objects.size).toBe(1);

        // --- The database is the authority, never the object key. ---
        const [row] = await tx
          .select({ storageKey: attachments.storageKey })
          .from(attachments)
          .where(eq(attachments.id, attachmentId))
          .limit(1);
        expect(row?.storageKey).toMatch(new RegExp(`^w/${alpha}/a/${attachmentId}/original/`, "u"));
        // The key is real and its object is present...
        expect(store.objects.has(row?.storageKey ?? "")).toBe(true);
        // ...and it still grants nothing to another tenant.
        await expect(
          service.readContent({
            principal: betaOwner,
            workspaceId: alpha,
            attachmentId,
            variant: "full",
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });
        await expect(
          service.readContent({
            principal: betaOwner,
            workspaceId: SEED_IDS.workspaces.beta,
            attachmentId,
            variant: "full",
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });
        await expect(
          service.listForNote({
            principal: betaOwner,
            workspaceId: SEED_IDS.workspaces.beta,
            noteId,
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });

        // --- A workspace member can read it while the project is open. ---
        const readable = await service.readContent({
          principal: editor,
          workspaceId: alpha,
          attachmentId,
          variant: "full",
        });
        expect(readable.contentLength).toBe(PNG.byteLength);
        expect(readable.filename).toBe("passwd.png");
        readable.stream.destroy();

        // --- Permission loss after upload closes the door immediately. ---
        await tx
          .update(projects)
          .set({ isRestricted: true })
          .where(eq(projects.id, SEED_IDS.projects.alphaLaunch));
        await expect(
          service.readContent({
            principal: editor,
            workspaceId: alpha,
            attachmentId,
            variant: "full",
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });
        await tx
          .update(projects)
          .set({ isRestricted: false })
          .where(eq(projects.id, SEED_IDS.projects.alphaLaunch));

        // --- The ready transaction carries the audit row and the outbox intent. ---
        const audits = await tx
          .select({ action: auditLogs.action })
          .from(auditLogs)
          .where(eq(auditLogs.entityId, attachmentId));
        expect(audits).toHaveLength(2);
        expect(new Set(audits.map((entry) => entry.action))).toEqual(
          new Set([
            ATTACHMENT_AUDIT_ACTIONS.uploadStarted,
            ATTACHMENT_AUDIT_ACTIONS.uploadCompleted,
          ]),
        );
        // Scoped to THIS attachment and workspace. `job_outbox` is a shared
        // table that other suites and prior committed runs also write, so a
        // filter on queue + type alone is a sequential scan that can return a
        // foreign row. The idempotency key is
        // `attachment-domain:{event}:{attachmentId}:{intentId}`, so matching
        // `:{attachmentId}:` pins it to exactly one row.
        const intents = await tx
          .select({
            queueName: jobOutbox.queueName,
            jobType: jobOutbox.jobType,
            payload: jobOutbox.payload,
            payloadHash: jobOutbox.payloadHash,
            idempotencyKey: jobOutbox.idempotencyKey,
          })
          .from(jobOutbox)
          .where(
            and(
              eq(jobOutbox.workspaceId, alpha),
              eq(jobOutbox.queueName, ATTACHMENT_DOMAIN_EVENT_QUEUE),
              eq(jobOutbox.jobType, ATTACHMENT_DOMAIN_EVENTS.created),
              like(jobOutbox.idempotencyKey, `%:${attachmentId}:%`),
            ),
          );
        expect(intents).toHaveLength(1);
        const [intent] = intents;
        expect(intent?.payload).toMatchObject({
          action: ATTACHMENT_DOMAIN_EVENTS.created,
          workspaceId: alpha,
          resourceIds: [attachmentId],
        });
        expect(intent?.payloadHash).toMatch(/^[\da-f]{64}$/u);
        expect(intent?.idempotencyKey).toContain(attachmentId);
        // The outbox payload is identifier-only: no key, no filename, no bytes.
        expect(JSON.stringify(intent?.payload)).not.toContain("passwd");
        expect(JSON.stringify(intent?.payload)).not.toContain("/original/");

        // --- Note listing hydrates the editor and never leaks a key. ---
        const listed = await service.listForNote({ principal: owner, workspaceId: alpha, noteId });
        expect(listed.items.map((item) => item.id)).toContain(attachmentId);
        expect(JSON.stringify(listed)).not.toContain('"key"');
        /*
         * This endpoint had no `.limit()` at all, so a note used as a dumping
         * ground returned every row on every read. The bound is reported the
         * same way `NoteShareList` reports its own — a truncated list that looks
         * complete is worse than an obviously partial one.
         */
        expect(listed.truncated).toBe(false);
        expect(listed.returned).toBe(listed.items.length);
        expect(listed.limit).toBeGreaterThan(0);
        expect(listed.items.length).toBeLessThanOrEqual(listed.limit);

        // --- Partial failure: row failed, written objects removed afterwards. ---
        const failingStore = new MemoryObjectStore();
        failingStore.failOnPutNumber = 2;
        const failingService = buildService(database, failingStore, twoObjectProcessor);
        await expect(
          failingService.uploadImage({
            principal: owner,
            workspaceId: alpha,
            noteId,
            buffer: PNG,
            declaredMimeType: "image/png",
            declaredFilename: "partial.png",
            idempotencyKey: `attachment-partial-${suffix}`,
          }),
        ).rejects.toMatchObject({ safeResponse: { code: "UNPROCESSABLE_ENTITY" } });
        const [failed] = await tx
          .select({
            id: attachments.id,
            status: attachments.processingStatus,
            error: attachments.processingError,
          })
          .from(attachments)
          .where(eq(attachments.originalName, "partial.png"))
          .limit(1);
        expect(failed?.status).toBe("failed");
        expect(failed?.error).toBe("storage_unavailable");
        expect(failingStore.objects.size).toBe(0);
        expect(failingStore.calls.at(-1)).toMatch(/^removeMany:/u);
        const failureAudit = await tx
          .select({ action: auditLogs.action })
          .from(auditLogs)
          .where(eq(auditLogs.entityId, failed?.id ?? ""));
        expect(failureAudit.map((entry) => entry.action)).toContain(
          ATTACHMENT_AUDIT_ACTIONS.uploadFailed,
        );

        // --- Deletion records intent transactionally, then cleans up idempotently. ---
        const removed = await service.delete({
          principal: owner,
          workspaceId: alpha,
          attachmentId,
        });
        expect(removed).toEqual({ id: attachmentId, deleted: true });
        expect(store.objects.size).toBe(0);
        expect(
          await tx
            .select({ id: attachments.id })
            .from(attachments)
            .where(eq(attachments.id, attachmentId)),
        ).toEqual([]);
        expect(
          await tx
            .select({ id: jobOutbox.id })
            .from(jobOutbox)
            .where(
              and(
                eq(jobOutbox.workspaceId, alpha),
                eq(jobOutbox.jobType, ATTACHMENT_DOMAIN_EVENTS.deleted),
                like(jobOutbox.idempotencyKey, `%:${attachmentId}:%`),
              ),
            ),
        ).toHaveLength(1);
        // Duplicate cleanup is a no-op, which is what makes the after-commit
        // ordering safe to retry from the Part 45 sweeper.
        await expect(
          store.removeObjects("attachments", [row?.storageKey ?? ""]),
        ).resolves.toBeUndefined();
        await expect(
          service.readContent({
            principal: owner,
            workspaceId: alpha,
            attachmentId,
            variant: "full",
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });

        throw new RollbackAttachmentsTest("rollback Part 40 fixture");
      }),
    ).rejects.toBeInstanceOf(RollbackAttachmentsTest);
  });

  it("serializes concurrent uploads on the workspace row so quota cannot be double-spent", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }
    const live = db;

    // This race needs genuinely independent transactions, so its rows COMMIT.
    // Clear any leftovers from a crashed rerun before starting.
    await purgeQuotaFixtureRows(live);
    await live.transaction(async (tx) => seedDatabase(tx));

    const alpha = SEED_IDS.workspaces.alpha;
    const [before] = await live
      .select({ limit: workspaces.storageLimitBytes })
      .from(workspaces)
      .where(eq(workspaces.id, alpha))
      .limit(1);
    const [usage] = await live
      .select({ used: sql<string>`coalesce(sum(${attachments.sizeBytes}), 0)::bigint` })
      .from(attachments)
      .where(eq(attachments.workspaceId, alpha));
    const headroom = Number(usage?.used ?? 0) + PNG.byteLength;

    const database = {
      db: live,
      transaction: <T>(
        work: (scope: DatabaseTransaction) => Promise<T>,
        config?: PgTransactionConfig,
      ): Promise<T> => live.transaction(work, config),
    } as unknown as DatabaseService;
    const store = new MemoryObjectStore();
    const suffix = randomUUID();

    try {
      // Exactly one more PNG fits.
      await live
        .update(workspaces)
        .set({ storageLimitBytes: headroom })
        .where(eq(workspaces.id, alpha));

      const upload = (label: string) =>
        buildService(database, store).uploadImage({
          principal: principal(SEED_IDS.users.alphaOwner),
          workspaceId: alpha,
          noteId: SEED_IDS.notes.alphaProjectOverview,
          buffer: PNG,
          declaredMimeType: "image/png",
          declaredFilename: `${QUOTA_FIXTURE}-${label}.png`,
          idempotencyKey: `quota-${label}-${suffix}`,
        });

      const settled = await Promise.allSettled([upload("first"), upload("second")]);
      const fulfilled = settled.filter((entry) => entry.status === "fulfilled");
      const rejected = settled.filter((entry) => entry.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        reason: { safeResponse: { code: "PAYLOAD_TOO_LARGE" } },
      });

      const rows = await live
        .select({ id: attachments.id })
        .from(attachments)
        .where(like(attachments.originalName, `${QUOTA_FIXTURE}%`));
      expect(rows).toHaveLength(1);

      // Part 45: the quota is a HARD ceiling, not an advisory one. Whichever
      // upload won the race, the workspace's DERIVED usage must still fit inside
      // the limit that admitted exactly one of them. This is the assertion the
      // `FOR UPDATE` serialization exists to make true: without the row lock both
      // transactions read the same pre-race aggregate and both commit, leaving a
      // charged total of `headroom + PNG.byteLength`.
      //
      // The filter mirrors `StorageQuotaService.readAggregate` exactly —
      // `pending`/`processing` rows ARE the reservation and are charged, `failed`
      // rows own no committed bytes and are not — so this reads the same number
      // the next `reserve()` would.
      const [charged] = await live
        .select({
          bytes:
            sql`coalesce(sum(${attachments.sizeBytes}) filter (where ${attachments.processingStatus} in ('pending', 'processing', 'ready')), 0)::bigint`.mapWith(
              Number,
            ),
        })
        .from(attachments)
        .where(eq(attachments.workspaceId, alpha));
      expect(charged?.bytes ?? 0).toBeLessThanOrEqual(headroom);

      // The single winner is a committed `ready` row of exactly one PNG — the
      // loser left no half-charged `pending` reservation behind.
      const [winner] = await live
        .select({ status: attachments.processingStatus, sizeBytes: attachments.sizeBytes })
        .from(attachments)
        .where(like(attachments.originalName, `${QUOTA_FIXTURE}%`));
      expect(winner?.status).toBe("ready");
      expect(winner?.sizeBytes).toBe(PNG.byteLength);
    } finally {
      await purgeQuotaFixtureRows(live);
      await live
        .update(workspaces)
        .set({ storageLimitBytes: before?.limit ?? null })
        .where(eq(workspaces.id, alpha));
    }
  });

  /**
   * Part 44's acceptance criteria, proven against real PostgreSQL inside one
   * rolled-back transaction: upload, download, and delete for **every** file
   * category `Notted.md` §6 names; the quota error; cross-workspace denial; a
   * guessed identifier; and — the criterion stated verbatim in `Plan.md` —
   * "access is denied after note/workspace permission loss".
   */
  it("uploads, downloads, and deletes every documented file category with isolation intact", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const database = {
          db: tx,
          transaction: <T>(work: (scope: DatabaseTransaction) => Promise<T>): Promise<T> =>
            tx.transaction(work),
        } as unknown as DatabaseService;
        const store = new MemoryObjectStore();
        const service = buildService(database, store);

        const owner = principal(SEED_IDS.users.alphaOwner);
        const editor = principal(SEED_IDS.users.alphaEditor);
        const betaOwner = principal(SEED_IDS.users.betaOwner);
        const alpha = SEED_IDS.workspaces.alpha;
        const noteId = SEED_IDS.notes.alphaProjectOverview;
        const suffix = randomUUID();
        const uploadedIds: string[] = [];

        for (const category of FILE_CATEGORIES) {
          const uploaded = await service.uploadFile({
            principal: owner,
            workspaceId: alpha,
            noteId,
            buffer: category.bytes,
            // Deliberately a lie on every single case: the declared type is
            // never persisted and never routes anything.
            declaredMimeType: "application/octet-stream",
            declaredFilename: category.filename,
            idempotencyKey: `attachment-file-${category.filename}-${suffix}`,
          });
          expect(uploaded.attachment.status, category.label).toBe("ready");
          expect(uploaded.attachment.mediaType, category.label).toBe("file");
          expect(uploaded.attachment.mimeType, category.label).toBe(category.mimeType);
          expect(uploaded.attachment.displayName, category.label).toBe(category.displayName);
          expect(uploaded.attachment.sizeBytes, category.label).toBe(category.bytes.byteLength);
          expect(JSON.stringify(uploaded), category.label).not.toContain('"key"');
          uploadedIds.push(uploaded.attachment.id);

          // Download: the single stored object answers `full`, and the original
          // filename comes back for the content disposition.
          const read = await service.readContent({
            principal: owner,
            workspaceId: alpha,
            attachmentId: uploaded.attachment.id,
            variant: "full",
          });
          expect(read.mediaType, category.label).toBe("file");
          expect(read.mimeType, category.label).toBe(category.mimeType);
          expect(read.filename, category.label).toBe(category.displayName);
          expect(read.contentLength, category.label).toBe(category.bytes.byteLength);
          read.stream.destroy();

          // An image rendition of a generic file does not exist and must not be
          // synthesised from the original.
          await expect(
            service.readContent({
              principal: owner,
              workspaceId: alpha,
              attachmentId: uploaded.attachment.id,
              variant: "thumbnail",
            }),
          ).rejects.toMatchObject({ safeResponse: { code: "NOT_FOUND" } });
        }

        const probe = uploadedIds[0] ?? "";

        // --- Cross-workspace denial, from both directions. ---
        await expect(
          service.readContent({
            principal: betaOwner,
            workspaceId: alpha,
            attachmentId: probe,
            variant: "full",
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });
        await expect(
          service.readContent({
            principal: betaOwner,
            workspaceId: SEED_IDS.workspaces.beta,
            attachmentId: probe,
            variant: "full",
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });
        await expect(
          service.uploadFile({
            principal: betaOwner,
            workspaceId: alpha,
            noteId,
            buffer: FILE_CATEGORIES[0]?.bytes ?? PNG,
            declaredMimeType: "application/pdf",
            declaredFilename: "intruder.pdf",
            idempotencyKey: `attachment-intruder-${suffix}`,
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });

        // --- A guessed identifier discloses nothing, even to a member. ---
        await expect(
          service.readContent({
            principal: owner,
            workspaceId: alpha,
            attachmentId: randomUUID(),
            variant: "full",
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });

        // --- Access is denied after permission loss (Plan.md, verbatim). ---
        const readable = await service.readContent({
          principal: editor,
          workspaceId: alpha,
          attachmentId: probe,
          variant: "full",
        });
        readable.stream.destroy();
        await tx
          .update(projects)
          .set({ isRestricted: true })
          .where(eq(projects.id, SEED_IDS.projects.alphaLaunch));
        await expect(
          service.readContent({
            principal: editor,
            workspaceId: alpha,
            attachmentId: probe,
            variant: "full",
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });
        // Losing note permission also closes the *upload* door immediately.
        await expect(
          service.uploadFile({
            principal: editor,
            workspaceId: alpha,
            noteId,
            buffer: FILE_CATEGORIES[0]?.bytes ?? PNG,
            declaredMimeType: "application/pdf",
            declaredFilename: "after-loss.pdf",
            idempotencyKey: `attachment-after-loss-${suffix}`,
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });
        await tx
          .update(projects)
          .set({ isRestricted: false })
          .where(eq(projects.id, SEED_IDS.projects.alphaLaunch));

        // --- Quota exhaustion surfaces as a stable 413 and writes nothing. ---
        const [usage] = await tx
          .select({ used: sql<string>`coalesce(sum(${attachments.sizeBytes}), 0)::bigint` })
          .from(attachments)
          .where(eq(attachments.workspaceId, alpha));
        await tx
          .update(workspaces)
          .set({ storageLimitBytes: Number(usage?.used ?? 0) })
          .where(eq(workspaces.id, alpha));
        const rowsBefore = await tx
          .select({ id: attachments.id })
          .from(attachments)
          .where(eq(attachments.workspaceId, alpha));
        await expect(
          service.uploadFile({
            principal: owner,
            workspaceId: alpha,
            noteId,
            buffer: FILE_CATEGORIES[0]?.bytes ?? PNG,
            declaredMimeType: "application/pdf",
            declaredFilename: "over-quota.pdf",
            idempotencyKey: `attachment-over-quota-${suffix}`,
          }),
        ).rejects.toMatchObject({ safeResponse: { code: "PAYLOAD_TOO_LARGE" } });
        const rowsAfter = await tx
          .select({ id: attachments.id })
          .from(attachments)
          .where(eq(attachments.workspaceId, alpha));
        expect(rowsAfter).toHaveLength(rowsBefore.length);

        // --- Deletion removes the row and, only afterwards, the objects. ---
        for (const id of uploadedIds) {
          const removed = await service.delete({
            principal: owner,
            workspaceId: alpha,
            attachmentId: id,
          });
          expect(removed).toEqual({ id, deleted: true });
        }
        expect(store.objects.size).toBe(0);
        expect(
          await tx
            .select({ id: attachments.id })
            .from(attachments)
            .where(eq(attachments.id, probe)),
        ).toEqual([]);

        throw new RollbackAttachmentsTest("rollback Part 44 fixture");
      }),
    ).rejects.toBeInstanceOf(RollbackAttachmentsTest);
  });
});

/**
 * Same byte-plane contract, re-parameterised over the real MinIO adapter. Two
 * gate layers: `skipIf` for "not configured", the `beforeAll` probe for
 * "configured but down". MinIO cannot roll back, so every object is written
 * under a per-run random prefix that `afterEach` removes.
 */
describe.skipIf(!HAS_MINIO)("Part 40 object storage (live MinIO)", () => {
  let minioReachable = false;
  let prefix = "";

  beforeAll(async () => {
    minioReachable = await isMinioReachable();
  });

  afterEach(async () => {
    await removeTestObjects(prefix);
    prefix = "";
  });

  it("round-trips, stats, and idempotently removes an object", async ({ skip }) => {
    if (!minioReachable) {
      skip("skipped: no reachable MinIO — run dev compose");
      return;
    }
    const config = parseMinioConfig(process.env);
    const client = new MinioClient({
      endPoint: config.endPoint,
      port: config.port,
      useSSL: config.useSsl,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      region: config.region,
    });
    const storage = new ObjectStorageService(client, config, security, {
      warn: vi.fn(),
    } as unknown as StructuredLogger);

    prefix = testKeyPrefix();
    const key = `${prefix}original.png`;
    await storage.ensureBuckets();
    const put = await storage.putObject("attachments", key, PNG, {
      contentType: "image/png",
      contentLength: PNG.byteLength,
      cacheControl: "private, max-age=31536000, immutable",
    });
    expect(put.etag).toMatch(/^[\da-f]+$/u);

    const stat = await storage.statObject("attachments", key);
    expect(stat?.size).toBe(PNG.byteLength);
    expect(stat?.contentType).toBe("image/png");

    const stream = await storage.getObjectStream("attachments", key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks).equals(PNG)).toBe(true);

    await storage.removeObject("attachments", key);
    expect(await storage.statObject("attachments", key)).toBeNull();
    // Removing it again must not throw: cleanup runs after the failure commit
    // and may be retried by the reconciliation sweeper.
    await expect(storage.removeObject("attachments", key)).resolves.toBeUndefined();
    await expect(storage.removeObjects("attachments", [key, key])).resolves.toBeUndefined();
  });

  it("clamps a presigned export URL and never exposes an unbounded lifetime", async ({ skip }) => {
    if (!minioReachable) {
      skip("skipped: no reachable MinIO — run dev compose");
      return;
    }
    const config = parseMinioConfig(process.env);
    const storage = new ObjectStorageService(
      new MinioClient({
        endPoint: config.endPoint,
        port: config.port,
        useSSL: config.useSsl,
        accessKey: config.accessKey,
        secretKey: config.secretKey,
        region: config.region,
      }),
      config,
      security,
      { warn: vi.fn() } as unknown as StructuredLogger,
    );
    const url = await storage.presignedGetUrl("exports", "e/never-created", 86_400);
    const expires = new URL(url).searchParams.get("X-Amz-Expires");
    expect(Number(expires)).toBeLessThanOrEqual(security.signedUrlTtlSeconds);
  });
});
