// Part 41: the BYTE-PLANE integration suite for image ingestion.
//
// `image-processing.service.test.ts` proves the pixel behaviour (variant matrix,
// dimensions, metadata stripping, animation, hostile input) against Sharp with no
// infrastructure. This file proves the part nothing in-process can prove: that the
// objects the pipeline produced really landed in the real bucket, at exactly the
// keys and byte lengths the database recorded, and that both terminal paths —
// delete and mid-upload failure — leave no stranded bytes behind.
//
// It lives beside `attachments.integration.test.ts` rather than inside it because
// that file's two suites are Part 40's and are parameterised over an in-memory
// store; this one needs BOTH a live PostgreSQL and a live MinIO at once, which is
// a strictly narrower gate. `test/image-fixtures.ts` already names this file.
//
// GATE SHAPE, identical to the existing suites:
//   describe.skipIf(...)          -> "not configured at all"
//   beforeAll probe + skip("...") -> "configured but unreachable right now"
//
// CLEANUP. MinIO cannot join the PostgreSQL rollback, so every object written
// here goes through `PrefixedObjectStore`, which pushes the service's real key
// under a per-run `test/{uuid}/` namespace that `afterEach` removes. The database
// side still rolls back through the usual thrown-sentinel transaction, so the two
// systems are cleaned by the mechanism each one actually supports.

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client as MinioClient } from "minio";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ATTACHMENT_AUDIT_ACTIONS } from "../src/attachments/attachments.constants";
import { AttachmentsService } from "../src/attachments/attachments.service";
import { ImageProcessingService } from "../src/attachments/image-processing.service";
import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import { parseImageProcessingConfig } from "../src/config/image-processing.config";
import { parseMinioConfig } from "../src/config/minio.config";
import { parseStorageConfig } from "../src/config/storage.config";
import { DatabaseService, type DatabaseTransaction } from "../src/database/database.service";
import { attachments, auditLogs, schema } from "../src/database/schema";
import { SEED_IDS, seedDatabase } from "../src/database/seed";
import { ObjectStorageService } from "../src/infrastructure/minio/object-storage.service";
import { StorageQuotaService } from "../src/storage/storage-quota.service";
import { TenantContextService } from "../src/tenant";

import { HEIC_FIXTURE_ENV, heicFixtureFromEnvironment, jpegFixture } from "./image-fixtures";
import {
  HAS_MINIO,
  isMinioReachable,
  removeTestObjects,
  testKeyPrefix,
} from "./minio-test-helpers";

import type { StructuredLogger } from "../src/common/logging/structured-logger.service";
import type { SecurityConfig } from "../src/config/security.config";
import type { AttachmentVariantObject, AttachmentVariantRecord } from "../src/database/schema";
import type {
  ListObjectsOptions,
  ListObjectsResult,
  ObjectStore,
  PutObjectOptions,
  PutObjectResult,
  StorageBucket,
  StoredObjectStat,
} from "../src/infrastructure/minio/object-storage.service";
import type { AuthenticatedPrincipal } from "@notted/shared-types";
import type { Readable } from "node:stream";

const DATABASE_URL = process.env.DATABASE_URL;
const HAS_DATABASE_URL = typeof DATABASE_URL === "string" && DATABASE_URL.trim() !== "";
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");
const CONNECTION_TIMEOUT_MS = 2_000;

/** Every variant the image pipeline is contracted to materialize, in write order. */
const MATERIALIZED = ["original", "full", "medium", "thumbnail"] as const;

/**
 * Vitest's 5 s default is not enough here and the shortfall is real work, not
 * flakiness: each test seeds the database, runs four Sharp encodes, and makes a
 * dozen round trips to a real MinIO. Stated per test rather than raised globally
 * so the fast in-process suites keep their tight default.
 */
const INTEGRATION_TIMEOUT_MS = 60_000;

const security = {
  maximumUploadBytes: 50 * 1_024 * 1_024,
  maximumWorkspaceStorageBytes: 10 * 1_024 * 1_024 * 1_024,
  signedUrlTtlSeconds: 900,
} as unknown as SecurityConfig;

class RollbackImageProcessingTest extends Error {}

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

async function isDatabaseReachable(connectionString: string): Promise<boolean> {
  const client = new Client({ connectionString, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS });
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * The real MinIO adapter, namespaced.
 *
 * Every key the service computes is written under a disposable `test/{uuid}/`
 * prefix, so a crashed run leaves an identifiable island instead of polluting the
 * shared bucket. Assertions therefore read "the object the database recorded as
 * `k` exists at `prefix + k`" — the mapping is total and injective, so it proves
 * exactly what an unprefixed run would.
 *
 * It also carries the failure injector: `failOnPutNumber` refuses the Nth
 * `putObject`, which is the only way to reach the compensating-cleanup branch
 * against real storage.
 */
class PrefixedObjectStore implements ObjectStore {
  /** Keys the service successfully wrote, in order. */
  readonly written: string[] = [];
  failOnPutNumber: number | null = null;
  private puts = 0;

  constructor(
    private readonly inner: ObjectStorageService,
    private readonly prefix: string,
  ) {}

  /** The physical MinIO key for a key the database recorded. */
  physical(key: string): string {
    return `${this.prefix}${key}`;
  }

  isEnabled(): boolean {
    return this.inner.isEnabled();
  }

  async putObject(
    bucket: StorageBucket,
    key: string,
    body: Buffer,
    options: PutObjectOptions,
  ): Promise<PutObjectResult> {
    this.puts += 1;
    if (this.failOnPutNumber === this.puts) {
      throw new Error("injected storage failure");
    }
    const result = await this.inner.putObject(bucket, this.physical(key), body, options);
    this.written.push(key);
    return result;
  }

  getObjectStream(bucket: StorageBucket, key: string): Promise<Readable> {
    return this.inner.getObjectStream(bucket, this.physical(key));
  }

  statObject(bucket: StorageBucket, key: string): Promise<StoredObjectStat | null> {
    return this.inner.statObject(bucket, this.physical(key));
  }

  removeObject(bucket: StorageBucket, key: string): Promise<void> {
    return this.inner.removeObject(bucket, this.physical(key));
  }

  removeObjects(bucket: StorageBucket, keys: readonly string[]): Promise<void> {
    return this.inner.removeObjects(
      bucket,
      keys.map((key) => this.physical(key)),
    );
  }

  /** Prefixed on the way in, stripped on the way out — the mapping stays total. */
  async listObjects(
    bucket: StorageBucket,
    options: ListObjectsOptions,
  ): Promise<ListObjectsResult> {
    const page = await this.inner.listObjects(bucket, {
      ...options,
      prefix: this.physical(options.prefix),
    });
    return {
      objects: page.objects.map((object) => ({
        ...object,
        key: object.key.slice(this.prefix.length),
      })),
      truncated: page.truncated,
    };
  }

  presignedGetUrl(bucket: StorageBucket, key: string, ttlSeconds: number): Promise<string> {
    return this.inner.presignedGetUrl(bucket, this.physical(key), ttlSeconds);
  }
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
  return new ObjectStorageService(client, config, security, {
    warn: vi.fn(),
  } as unknown as StructuredLogger);
}

/** The REAL Sharp-backed processor — the whole point of this suite. */
function buildService(database: DatabaseService, store: ObjectStore): AttachmentsService {
  const tenant = new TenantContextService();
  const entry = new AuthorizationEntryService(
    new AuthorizationRepository(database, tenant),
    new AuthorizationPolicyService(),
    tenant,
  );
  const processor = new ImageProcessingService(parseImageProcessingConfig(process.env));
  // Real quota service against the real (rolled-back) workspace row. The
  // fixtures here are far below any plan default, so it admits every upload —
  // but it is the production code path, not a stub that could hide a regression.
  const quota = new StorageQuotaService(database, entry, tenant, security, parseStorageConfig({}));
  return new AttachmentsService(
    database,
    entry,
    tenant,
    store,
    processor,
    security,
    { warn: vi.fn() } as unknown as StructuredLogger,
    quota,
  );
}

/**
 * The service's `DatabaseService` seam, bound to the rollback transaction. Nested
 * `transaction()` calls become PostgreSQL savepoints, which is what lets the
 * compensating-cleanup path commit its `failed` row inside a suite that rolls the
 * whole fixture back. Identical to `attachments.integration.test.ts`.
 */
function scopedDatabase(tx: DatabaseTransaction): DatabaseService {
  return {
    db: tx,
    transaction: <T>(work: (scope: DatabaseTransaction) => Promise<T>): Promise<T> =>
      tx.transaction(work),
  } as unknown as DatabaseService;
}

/** Read one persisted variant record, failing loudly rather than with `undefined`. */
function requireVariant(
  record: AttachmentVariantRecord,
  name: (typeof MATERIALIZED)[number],
): AttachmentVariantObject {
  const object = record[name];
  if (object === undefined) throw new Error(`missing persisted variant: ${name}`);
  return object;
}

describe.skipIf(!HAS_DATABASE_URL || !HAS_MINIO)(
  "Part 41 image ingestion (live PostgreSQL + live MinIO)",
  () => {
    let pool: Pool | undefined;
    let db: NodePgDatabase<typeof schema> | undefined;
    let databaseReachable = false;
    let minioReachable = false;
    let prefix = "";

    beforeAll(async () => {
      const [database, minio] = await Promise.all([
        isDatabaseReachable(DATABASE_URL as string),
        isMinioReachable(),
      ]);
      databaseReachable = database;
      minioReachable = minio;
      if (!databaseReachable) return;
      pool = new Pool({ connectionString: DATABASE_URL as string, max: 4 });
      db = drizzle(pool, { schema });
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      if (minioReachable) await realStorage().ensureBuckets();
    });

    afterAll(async () => {
      await pool?.end().catch(() => undefined);
    });

    afterEach(async () => {
      await removeTestObjects(prefix);
      prefix = "";
    });

    it(
      "writes every variant to the real bucket at its recorded key and byte length, and deletion removes them all",
      async ({ skip }) => {
        if (!databaseReachable || !minioReachable || db === undefined) {
          skip("skipped: needs a reachable PostgreSQL AND MinIO — run dev compose");
          return;
        }

        // 900x600 is below the 2000 px `full` ceiling and above `medium`'s 800 and
        // `thumbnail`'s 200, so all four objects are genuinely distinct byte
        // sequences rather than four copies of one encode.
        const fixture = await jpegFixture(900, 600);
        prefix = testKeyPrefix();
        const store = new PrefixedObjectStore(realStorage(), prefix);

        await expect(
          db.transaction(async (tx) => {
            await seedDatabase(tx);
            const service = buildService(scopedDatabase(tx), store);
            const owner = principal(SEED_IDS.users.alphaOwner);
            const workspaceId = SEED_IDS.workspaces.alpha;
            const noteId = SEED_IDS.notes.alphaProjectOverview;

            const uploaded = await service.uploadImage({
              principal: owner,
              workspaceId,
              noteId,
              buffer: fixture.bytes,
              declaredMimeType: "application/octet-stream",
              declaredFilename: "holiday.jpg",
              idempotencyKey: `image-processing-${randomUUID()}`,
            });
            expect(uploaded.attachment.status).toBe("ready");
            expect(uploaded.attachment.mimeType).toBe("image/jpeg");
            expect(uploaded.attachment.width).toBe(900);
            expect(uploaded.attachment.height).toBe(600);
            const attachmentId = uploaded.attachment.id;

            // --- What Part 42 consumes off the wire: geometry and a placeholder,
            //     and NOTHING that could be turned into a storage address. ---
            const wire = uploaded.attachment.variants;
            for (const name of MATERIALIZED) {
              const projection = wire[name];
              expect(projection).toBeDefined();
              expect(projection?.width).toBeGreaterThan(0);
              expect(projection?.height).toBeGreaterThan(0);
              expect(projection?.bytes).toBeGreaterThan(0);
            }
            expect(wire.blur?.dataUri.startsWith("data:image/webp;base64,")).toBe(true);
            expect(Buffer.byteLength(wire.blur?.dataUri ?? "", "utf8")).toBeLessThanOrEqual(2_048);
            expect(JSON.stringify(uploaded.attachment)).not.toContain('"key"');
            expect(JSON.stringify(uploaded.attachment)).not.toContain(prefix);

            // --- The database record is the authority for what exists. ---
            const [row] = await tx
              .select({ variants: attachments.variants })
              .from(attachments)
              .where(eq(attachments.id, attachmentId))
              .limit(1);
            const record = (row?.variants ?? {}) as AttachmentVariantRecord;

            const keys: string[] = [];
            for (const name of MATERIALIZED) {
              const object = requireVariant(record, name);
              keys.push(object.key);
              expect(object.key).toContain(`/a/${attachmentId}/${name}/`);

              // THE ASSERTION THIS SUITE EXISTS FOR: the object is really there,
              // and its stored length is exactly the length the row claims.
              const stat = await store.statObject("attachments", object.key);
              expect(stat, `variant ${name} is absent from the bucket`).not.toBeNull();
              expect(stat?.size, `variant ${name} byte length disagrees with the row`).toBe(
                object.bytes,
              );
              expect(stat?.contentType).toBe(object.mimeType);
            }
            // Four distinct objects, not one object recorded four times.
            expect(new Set(keys).size).toBe(MATERIALIZED.length);

            // `full` is a metadata-stripped RE-ENCODE, not the uploaded bytes.
            expect(requireVariant(record, "full").bytes).not.toBe(
              requireVariant(record, "original").bytes,
            );
            expect(requireVariant(record, "medium").mimeType).toBe("image/webp");
            expect(requireVariant(record, "thumbnail").mimeType).toBe("image/webp");
            expect(requireVariant(record, "thumbnail").width).toBe(200);
            expect(requireVariant(record, "medium").width).toBe(800);
            // The inline placeholder is metadata, never an object: it carries these
            // three fields and no `key`. (Checked on the property names, not on the
            // serialized string — a base64 payload can contain the letters "key".)
            expect(Object.keys(record.blur ?? {}).sort()).toEqual(["dataUri", "height", "width"]);

            // --- The proxied download really streams the stored bytes. ---
            const content = await service.readContent({
              principal: owner,
              workspaceId,
              attachmentId,
              variant: "thumbnail",
            });
            expect(content.mimeType).toBe("image/webp");
            expect(content.contentLength).toBe(requireVariant(record, "thumbnail").bytes);
            content.stream.destroy();

            // --- Deletion removes EVERY object this row owned. ---
            expect(await service.delete({ principal: owner, workspaceId, attachmentId })).toEqual({
              id: attachmentId,
              deleted: true,
            });
            for (const key of keys) {
              expect(
                await store.statObject("attachments", key),
                "a variant object survived deletion",
              ).toBeNull();
            }

            throw new RollbackImageProcessingTest("rollback Part 41 fixture");
          }),
        ).rejects.toBeInstanceOf(RollbackImageProcessingTest);
      },
      INTEGRATION_TIMEOUT_MS,
    );

    it(
      "commits the failed row first, then removes only the objects already written",
      async ({ skip }) => {
        if (!databaseReachable || !minioReachable || db === undefined) {
          skip("skipped: needs a reachable PostgreSQL AND MinIO — run dev compose");
          return;
        }

        const fixture = await jpegFixture(640, 480);
        prefix = testKeyPrefix();
        const store = new PrefixedObjectStore(realStorage(), prefix);
        // Write order is original, full, medium, thumbnail. Refusing the THIRD put
        // leaves two real objects in the bucket that compensation must reclaim,
        // and one variant (`thumbnail`) that was never attempted.
        store.failOnPutNumber = 3;

        await expect(
          db.transaction(async (tx) => {
            await seedDatabase(tx);
            const service = buildService(scopedDatabase(tx), store);
            const owner = principal(SEED_IDS.users.alphaOwner);
            const workspaceId = SEED_IDS.workspaces.alpha;

            await expect(
              service.uploadImage({
                principal: owner,
                workspaceId,
                noteId: SEED_IDS.notes.alphaProjectOverview,
                buffer: fixture.bytes,
                declaredMimeType: "image/jpeg",
                declaredFilename: "partial-variants.jpg",
                idempotencyKey: `image-processing-partial-${randomUUID()}`,
              }),
            ).rejects.toMatchObject({ safeResponse: { code: "UNPROCESSABLE_ENTITY" } });

            // Exactly the two objects before the injected failure were written.
            expect(store.written).toHaveLength(2);

            const [failed] = await tx
              .select({
                id: attachments.id,
                status: attachments.processingStatus,
                error: attachments.processingError,
                variants: attachments.variants,
              })
              .from(attachments)
              .where(eq(attachments.originalName, "partial-variants.jpg"))
              .limit(1);

            // The row is terminal and the code is short, stable, and content-free.
            expect(failed?.status).toBe("failed");
            expect(failed?.error).toBe("storage_unavailable");
            expect(failed?.error).toMatch(/^[a-z_]{1,40}$/u);
            // `variants` was never advanced past its `{}` default, so no wire
            // projection can ever offer a rendition that does not exist.
            expect(failed?.variants).toEqual({});

            // The failure audit committed in the same transaction as the status.
            const audits = await tx
              .select({ action: auditLogs.action })
              .from(auditLogs)
              .where(eq(auditLogs.entityId, failed?.id ?? ""));
            expect(audits.map((entry) => entry.action)).toContain(
              ATTACHMENT_AUDIT_ACTIONS.uploadFailed,
            );

            // ...and only AFTER that commit were the written bytes reclaimed.
            for (const key of store.written) {
              expect(
                await store.statObject("attachments", key),
                "a partially written object was left stranded",
              ).toBeNull();
            }

            throw new RollbackImageProcessingTest("rollback Part 41 failure fixture");
          }),
        ).rejects.toBeInstanceOf(RollbackImageProcessingTest);
      },
      INTEGRATION_TIMEOUT_MS,
    );

    it(
      "round-trips a real HEIC file end to end when an operator supplies one",
      async ({ skip }) => {
        if (!databaseReachable || !minioReachable || db === undefined) {
          skip("skipped: needs a reachable PostgreSQL AND MinIO — run dev compose");
          return;
        }
        const heic = heicFixtureFromEnvironment();
        if (heic === null) {
          // Sharp's prebuilt libvips has no HEVC encoder, so this fixture cannot be
          // generated, and a real sample is patent-encumbered so none is committed.
          // The routing, byte cap, timeout, and decoder-unavailable paths are all
          // covered by `heic-decoder.test.ts` against a stubbed converter; only the
          // real libheif decode is manual-verification-only.
          skip(
            `skipped: set ${HEIC_FIXTURE_ENV} to the path of a real .heic file to run the HEIC round trip`,
          );
          return;
        }

        prefix = testKeyPrefix();
        const store = new PrefixedObjectStore(realStorage(), prefix);

        await expect(
          db.transaction(async (tx) => {
            await seedDatabase(tx);
            const service = buildService(scopedDatabase(tx), store);
            const owner = principal(SEED_IDS.users.alphaOwner);
            const workspaceId = SEED_IDS.workspaces.alpha;

            const uploaded = await service.uploadImage({
              principal: owner,
              workspaceId,
              noteId: SEED_IDS.notes.alphaProjectOverview,
              buffer: heic,
              declaredMimeType: "image/heic",
              declaredFilename: "IMG_0001.HEIC",
              idempotencyKey: `image-processing-heic-${randomUUID()}`,
            });

            expect(uploaded.attachment.status).toBe("ready");
            // The persisted type stays what was uploaded and sniffed...
            expect(uploaded.attachment.mimeType).toBe("image/heic");
            // ...while every SERVABLE rendition is a raster a browser can decode.
            expect(uploaded.attachment.variants.full?.mimeType).toBe("image/jpeg");
            expect(uploaded.attachment.variants.medium?.mimeType).toBe("image/webp");
            expect(uploaded.attachment.variants.thumbnail?.mimeType).toBe("image/webp");

            const [row] = await tx
              .select({ variants: attachments.variants })
              .from(attachments)
              .where(eq(attachments.id, uploaded.attachment.id))
              .limit(1);
            const record = (row?.variants ?? {}) as AttachmentVariantRecord;
            for (const name of MATERIALIZED) {
              const object = requireVariant(record, name);
              const stat = await store.statObject("attachments", object.key);
              expect(stat?.size).toBe(object.bytes);
            }

            throw new RollbackImageProcessingTest("rollback Part 41 HEIC fixture");
          }),
        ).rejects.toBeInstanceOf(RollbackImageProcessingTest);
      },
      INTEGRATION_TIMEOUT_MS,
    );
  },
);
