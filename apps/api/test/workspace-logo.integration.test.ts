// Part 72 — the workspace branding logo, against a real PostgreSQL.
//
// DATABASE-GATED like `audit-logs.integration.test.ts`: without a reachable
// `DATABASE_URL` the suite skips rather than failing, and `pnpm test:ci` is the
// run that actually proves it (see CLAUDE.md → Quality gates).
//
// EVERY case runs inside one outer transaction that is rolled back, so the
// suite leaves no rows behind — including the append-only `audit_logs` rows the
// logo writes, which is why no case needs `allowAuditDelete`. Nested
// `tx.transaction(...)` calls become SAVEPOINTs, so a refusal inside the service
// rolls back only its own savepoint and the outer transaction survives.
//
// MinIO and Sharp are BOTH substituted. MinIO cannot join the PostgreSQL
// rollback, and pulling a native image decoder into a suite about authorization,
// tenancy and object-key lifecycle would buy nothing — Part 41's own suites own
// the decoding. The bytes handed to `upload` still carry a real PNG signature,
// because the service sniffs magic bytes (ADR 0005) BEFORE it reaches the
// processor and would otherwise refuse them with a 415.

import { resolve } from "node:path";
import { Readable } from "node:stream";

import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import { ApiHttpException } from "../src/common/errors/api-http.exception";
import { auditLogs, schema, workspaces } from "../src/database/schema";
import { SEED_IDS, seedDatabase } from "../src/database/seed";
import { TenantContextService } from "../src/tenant";
import {
  parseWorkspaceLogoUrl,
  WorkspaceLogoService,
  workspaceLogoObjectKey,
} from "../src/workspaces/workspace-logo.service";
import { WORKSPACE_AUDIT_ACTIONS } from "../src/workspaces/workspaces.constants";

import { HAS_DATABASE, requireDatabase } from "./database-test-helpers";

import type { ImageProcessor } from "../src/attachments/image-processing";
import type { ImageProcessingService } from "../src/attachments/image-processing.service";
import type { DatabaseService, DatabaseTransaction } from "../src/database/database.service";
import type {
  ListObjectsResult,
  ObjectStorageService,
  ObjectStore,
  PutObjectResult,
  StorageBucket,
  StoredObjectStat,
} from "../src/infrastructure/minio/object-storage.service";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");

/** A workspace id that is a well-formed UUID and belongs to nobody. */
const ABSENT_WORKSPACE_ID = "30000000-0000-4000-8e00-0000000000ff";
/** Well-formed but never minted — the "someone guessed the shape" probe. */
const FOREIGN_TOKEN = "0123456789abcdef0123456789abcdef";
const LOGO_URL_PATTERN = /^\/api\/v1\/workspaces\/[0-9a-f-]{36}\/logo\/[0-9a-f]{32}$/u;

type Database = NodePgDatabase<typeof schema>;

class RollbackLogoTest extends Error {}

/**
 * A minimal but genuine PNG: the 8-byte signature plus an IHDR-shaped tail.
 * `sniffImageMediaType` reads the signature only, and the fake processor never
 * decodes — this exists so the service's sniff gate sees a real image type.
 */
const PNG_SOURCE = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("IHDR-placeholder-body", "utf8"),
]);

/** What the fake processor returns as the `thumbnail` rendition, WebP-shaped. */
const WEBP_RENDITION = Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 logo", "latin1");

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

/** A `DatabaseService` whose transaction opens a SAVEPOINT on the test's tx. */
function databaseOn(tx: DatabaseTransaction): DatabaseService {
  return {
    db: tx,
    transaction: <T>(work: (inner: DatabaseTransaction) => Promise<T>): Promise<T> =>
      tx.transaction(work),
  } as unknown as DatabaseService;
}

/** Asserts a rejection and hands back the `ApiHttpException` for inspection. */
async function refusal(promise: Promise<unknown>): Promise<ApiHttpException> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ApiHttpException) return error;
    throw error;
  }
  throw new Error("expected the call to be refused");
}

/**
 * In-memory byte plane. Only the four methods the logo service calls do real
 * work; the rest satisfy the interface and are never reached from this surface.
 */
class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  private puts = 0;

  isEnabled(): boolean {
    return true;
  }

  putObject(_bucket: StorageBucket, key: string, body: Buffer): Promise<PutObjectResult> {
    this.puts += 1;
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
            etag: `etag-${key.slice(-12)}`,
            lastModified: new Date("2026-08-01T00:00:00Z"),
            contentType: "image/webp",
          },
    );
  }

  removeObject(_bucket: StorageBucket, key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  removeObjects(_bucket: StorageBucket, keys: readonly string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
    return Promise.resolve();
  }

  listObjects(): Promise<ListObjectsResult> {
    return Promise.resolve({ objects: [], truncated: false });
  }

  presignedGetUrl(): Promise<string> {
    return Promise.resolve("https://storage.invalid/signed");
  }
}

/**
 * Part 41-shaped processor without Sharp: always yields the `thumbnail` variant
 * the logo surface asks for, so the assertions are about the object key, the
 * row and the audit trail rather than about pixel work.
 */
const thumbnailProcessor: ImageProcessor = {
  maximumInputBytes: 15 * 1_024 * 1_024,
  supports: () => true,
  process: () =>
    Promise.resolve({
      width: 200,
      height: 200,
      objects: [
        {
          variant: "thumbnail" as const,
          body: WEBP_RENDITION,
          mimeType: "image/webp",
          width: 200,
          height: 200,
        },
      ],
      blur: null,
    }),
};

function build(tx: DatabaseTransaction) {
  const tenant = new TenantContextService();
  const database = databaseOn(tx);
  const entry = new AuthorizationEntryService(
    new AuthorizationRepository(database, tenant),
    new AuthorizationPolicyService(),
    tenant,
  );
  const store = new MemoryObjectStore();
  const service = new WorkspaceLogoService(
    database,
    entry,
    tenant,
    thumbnailProcessor as unknown as ImageProcessingService,
    store as unknown as ObjectStorageService,
  );
  return { database, entry, service, store, tenant };
}

async function storedLogoUrl(tx: DatabaseTransaction, workspaceId: string): Promise<string | null> {
  const [row] = await tx
    .select({ logoUrl: workspaces.logoUrl })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row?.logoUrl ?? null;
}

async function logoAuditRows(tx: DatabaseTransaction, workspaceId: string, action: string) {
  return tx
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.workspaceId, workspaceId), eq(auditLogs.action, action)));
}

/** Every logo token this suite mints comes out of a `logo_url` it just read. */
function tokenOf(logoUrl: string | null, workspaceId: string): string {
  const parsed = parseWorkspaceLogoUrl(logoUrl, workspaceId);
  if (parsed === null) throw new Error(`not a logo url: ${String(logoUrl)}`);
  return parsed.token;
}

describe.skipIf(!HAS_DATABASE)("Part 72 workspace logo (live)", () => {
  let pool: Pool | undefined;
  let db: Database | undefined;

  beforeAll(async () => {
    await requireDatabase();

    pool = new Pool({ connectionString: DATABASE_URL as string, max: 1 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  it("stores one rendition, one app-relative URL and exactly one audit row", async ({ skip }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const { service, store } = build(tx);
        const alpha = SEED_IDS.workspaces.alpha;

        const result = await service.upload({
          principal: principal(SEED_IDS.users.alphaOwner),
          workspaceId: alpha,
          buffer: PNG_SOURCE,
          requestId: "44444444-5555-4666-8777-888888888888",
        });

        // The column now holds an app-relative path this API serves, not an
        // external URL — the whole point of the part.
        expect(result.logoUrl).toMatch(LOGO_URL_PATTERN);
        expect(await storedLogoUrl(tx, alpha)).toBe(result.logoUrl);

        // The object landed under the workspace-scoped key, as a WebP.
        const token = tokenOf(result.logoUrl, alpha);
        const key = workspaceLogoObjectKey(alpha, token);
        expect(key).toBe(`workspaces/${alpha}/logo/${token}.webp`);
        expect(store.objects.get(key)).toEqual(WEBP_RENDITION);
        // Nothing else was written: one upload is one object.
        expect([...store.objects.keys()]).toEqual([key]);

        // EXACTLY ONE row — the same "one row per sensitive mutation" criterion
        // Part 71 holds every other writer to.
        const rows = await logoAuditRows(tx, alpha, WORKSPACE_AUDIT_ACTIONS.logoUpdate);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          workspaceId: alpha,
          userId: SEED_IDS.users.alphaOwner,
          entityType: "workspace",
          entityId: alpha,
          requestId: "44444444-5555-4666-8777-888888888888",
        });

        // Identifiers and sizes only. `bytes` is the size KEPT (the rendition),
        // not the size uploaded, and the source type is the sniffed one. The
        // service does not put the token in metadata at all — the row's
        // workspace, actor and timestamp are the audit fact.
        expect(rows[0]?.metadata).toEqual({
          bytes: WEBP_RENDITION.byteLength,
          sourceType: "image/png",
        });
        // No image bytes and no servable URL ever reach the trail.
        const serialized = JSON.stringify(rows[0]);
        expect(serialized).not.toContain(result.logoUrl);
        expect(serialized).not.toContain(WEBP_RENDITION.toString("latin1"));

        // The public GET resolves with the stored rendition's facts.
        const content = await service.read(alpha, token);
        expect(content.mimeType).toBe("image/webp");
        expect(content.contentLength).toBe(WEBP_RENDITION.byteLength);

        throw new RollbackLogoTest();
      }),
    ).rejects.toBeInstanceOf(RollbackLogoTest);
  });

  it("conceals Alpha from a Beta member on both upload and removal", async ({ skip }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const { service, store } = build(tx);
        const alpha = SEED_IDS.workspaces.alpha;
        const intruder = principal(SEED_IDS.users.betaOwner);

        // Give Alpha a real logo first, so the refusals below have something
        // they could plausibly overwrite or delete.
        const owned = await service.upload({
          principal: principal(SEED_IDS.users.alphaOwner),
          workspaceId: alpha,
          buffer: PNG_SOURCE,
          requestId: null,
        });
        const key = workspaceLogoObjectKey(alpha, tokenOf(owned.logoUrl, alpha));

        // 404, NOT 403. A non-member never reaches a resource decision: the
        // entry service substitutes a concealed resource, so the policy answers
        // `authorization.concealed` and Alpha's existence does not leak.
        await expect(
          service.upload({
            principal: intruder,
            workspaceId: alpha,
            buffer: PNG_SOURCE,
            requestId: null,
          }),
        ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 404 } });

        await expect(
          service.remove({ principal: intruder, workspaceId: alpha, requestId: null }),
        ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 404 } });

        // Neither refusal touched the row or the bytes.
        expect(await storedLogoUrl(tx, alpha)).toBe(owned.logoUrl);
        expect(store.objects.has(key)).toBe(true);
        // And neither wrote an audit row: a refused call is not a mutation.
        expect(await logoAuditRows(tx, alpha, WORKSPACE_AUDIT_ACTIONS.logoDelete)).toHaveLength(0);
        expect(await logoAuditRows(tx, alpha, WORKSPACE_AUDIT_ACTIONS.logoUpdate)).toHaveLength(1);

        throw new RollbackLogoTest();
      }),
    ).rejects.toBeInstanceOf(RollbackLogoTest);
  });

  it("refuses a viewer and an editor with 403 on both upload and removal", async ({ skip }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const { service } = build(tx);
        const alpha = SEED_IDS.workspaces.alpha;

        // 403, not 404: both ARE members, so the workspace's existence is
        // already known to them and only the role is insufficient.
        // `settings.update` is owner/admin — branding is a settings change.
        for (const userId of [SEED_IDS.users.alphaViewer, SEED_IDS.users.alphaEditor]) {
          await expect(
            service.upload({
              principal: principal(userId),
              workspaceId: alpha,
              buffer: PNG_SOURCE,
              requestId: null,
            }),
          ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 403 } });

          await expect(
            service.remove({ principal: principal(userId), workspaceId: alpha, requestId: null }),
          ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 403 } });
        }

        // Nothing they attempted took effect.
        expect(await storedLogoUrl(tx, alpha)).toBeNull();
        expect(await logoAuditRows(tx, alpha, WORKSPACE_AUDIT_ACTIONS.logoUpdate)).toHaveLength(0);

        // An admin IS allowed — the denials above are about role, not about the
        // route being unreachable for everyone but the owner.
        const admin = await service.upload({
          principal: principal(SEED_IDS.users.alphaAdmin),
          workspaceId: alpha,
          buffer: PNG_SOURCE,
          requestId: null,
        });
        expect(admin.logoUrl).toMatch(LOGO_URL_PATTERN);

        throw new RollbackLogoTest();
      }),
    ).rejects.toBeInstanceOf(RollbackLogoTest);
  });

  it("answers every public read miss with the same 404", async ({ skip }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const { service } = build(tx);
        const alpha = SEED_IDS.workspaces.alpha;

        const uploaded = await service.upload({
          principal: principal(SEED_IDS.users.alphaOwner),
          workspaceId: alpha,
          buffer: PNG_SOURCE,
          requestId: null,
        });
        const token = tokenOf(uploaded.logoUrl, alpha);

        // Four different reasons to miss. They must be INDISTINGUISHABLE, or the
        // route becomes a probe for which workspaces exist and which are branded.
        const misses: ReadonlyArray<readonly [string, string, string]> = [
          ["a well-formed token that was never minted", alpha, FOREIGN_TOKEN],
          ["a malformed token", alpha, "not-a-token"],
          ["a workspace that does not exist", ABSENT_WORKSPACE_ID, token],
          ["a real workspace with no logo", SEED_IDS.workspaces.beta, token],
        ];
        for (const [why, workspaceId, candidate] of misses) {
          const error = await refusal(service.read(workspaceId, candidate));
          expect(error.getStatus(), why).toBe(404);
          expect(error.safeResponse, why).toEqual({
            code: "NOT_FOUND",
            message: "The requested resource was not found.",
          });
        }

        // The genuine token still resolves — the misses above are not a blanket
        // failure of the read path.
        await expect(service.read(alpha, token)).resolves.toMatchObject({
          contentLength: WEBP_RENDITION.byteLength,
        });

        throw new RollbackLogoTest();
      }),
    ).rejects.toBeInstanceOf(RollbackLogoTest);
  });

  it("supersedes the old token and its object when the logo is replaced", async ({ skip }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const { service, store } = build(tx);
        const alpha = SEED_IDS.workspaces.alpha;
        const owner = principal(SEED_IDS.users.alphaOwner);

        const first = await service.upload({
          principal: owner,
          workspaceId: alpha,
          buffer: PNG_SOURCE,
          requestId: null,
        });
        const firstToken = tokenOf(first.logoUrl, alpha);
        const firstKey = workspaceLogoObjectKey(alpha, firstToken);

        const second = await service.upload({
          principal: owner,
          workspaceId: alpha,
          buffer: PNG_SOURCE,
          requestId: null,
        });
        const secondToken = tokenOf(second.logoUrl, alpha);

        // A fresh 128-bit token per upload is what makes the public URL safe to
        // cache immutably and forever.
        expect(secondToken).not.toBe(firstToken);
        expect(await storedLogoUrl(tx, alpha)).toBe(second.logoUrl);

        // The old URL is dead even though its bytes were identical: the token,
        // not the content, is the authorization.
        expect((await refusal(service.read(alpha, firstToken))).getStatus()).toBe(404);
        await expect(service.read(alpha, secondToken)).resolves.toBeDefined();

        // And the superseded object is gone, so a replacement does not leak
        // storage on the happy path.
        expect(store.objects.has(firstKey)).toBe(false);
        expect([...store.objects.keys()]).toEqual([workspaceLogoObjectKey(alpha, secondToken)]);

        // Two uploads, two audit rows.
        expect(await logoAuditRows(tx, alpha, WORKSPACE_AUDIT_ACTIONS.logoUpdate)).toHaveLength(2);

        throw new RollbackLogoTest();
      }),
    ).rejects.toBeInstanceOf(RollbackLogoTest);
  });

  it("removes the logo idempotently and audits only the removal that removed something", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const { service, store } = build(tx);
        const alpha = SEED_IDS.workspaces.alpha;
        const owner = principal(SEED_IDS.users.alphaOwner);

        const uploaded = await service.upload({
          principal: owner,
          workspaceId: alpha,
          buffer: PNG_SOURCE,
          requestId: null,
        });
        const token = tokenOf(uploaded.logoUrl, alpha);
        const key = workspaceLogoObjectKey(alpha, token);

        const removed = await service.remove({
          principal: owner,
          workspaceId: alpha,
          requestId: null,
        });
        expect(removed.logoUrl).toBeNull();
        expect(await storedLogoUrl(tx, alpha)).toBeNull();
        expect(store.objects.has(key)).toBe(false);
        // The URL stops resolving the moment the row is cleared.
        expect((await refusal(service.read(alpha, token))).getStatus()).toBe(404);

        const afterFirst = await logoAuditRows(tx, alpha, WORKSPACE_AUDIT_ACTIONS.logoDelete);
        expect(afterFirst).toHaveLength(1);
        expect(afterFirst[0]).toMatchObject({
          workspaceId: alpha,
          userId: SEED_IDS.users.alphaOwner,
          entityType: "workspace",
          entityId: alpha,
        });
        expect(afterFirst[0]?.metadata).toEqual({});

        // IDEMPOTENT: removing an absent logo succeeds rather than 404-ing, so a
        // retried DELETE is safe. It is a no-op, so it must not append a second
        // row to an append-only trail that an auditor reads as "who did what".
        await expect(
          service.remove({ principal: owner, workspaceId: alpha, requestId: null }),
        ).resolves.toEqual({ logoUrl: null });
        expect(await logoAuditRows(tx, alpha, WORKSPACE_AUDIT_ACTIONS.logoDelete)).toHaveLength(1);

        throw new RollbackLogoTest();
      }),
    ).rejects.toBeInstanceOf(RollbackLogoTest);
  });
});
