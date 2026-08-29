// Part 45: workspace storage accounting proven against live PostgreSQL.
//
// WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY IS NOT
// `storage-quota.ts` already holds the pure arithmetic, so nothing here re-tests
// `Math.min`. What cannot be proven without a database is the part that makes
// the arithmetic TRUE of a real workspace:
//
// - the aggregate is derived from rows, split by lifecycle state, with `failed`
//   excluded by the SQL predicate rather than by a later subtraction;
// - `whereWorkspace` actually confines that aggregate to one tenant, so a second
//   workspace's bytes are invisible in both directions;
// - the read path is authorized, and a non-member is refused with the SAME shape
//   as a workspace that does not exist — no existence leak;
// - the write path (`reserve`) charges in-flight rows and refuses the byte that
//   would cross the limit, inside the caller's transaction under the row lock.
//
// The CONCURRENCY property (two simultaneous uploads cannot both spend the last
// slot) needs genuinely independent, COMMITTED transactions, so it lives in
// `attachments.integration.test.ts` where the fixture rows are committed and
// purged. Everything here runs inside one transaction that is always rolled
// back, which is why it can create its own users, workspaces, and notes instead
// of mutating the shared `SEED_IDS` rows that `vitest.config.ts` serializes on.
//
// Gating matches the existing idiom: `describe.skipIf(!HAS_DATABASE)` for
// "not configured at all", plus a `beforeAll` reachability probe that calls
// `skip()` for "configured but down". No MinIO is needed — quota accounting
// never touches the object store.

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import { DatabaseService, type DatabaseTransaction } from "../src/database/database.service";
import {
  attachments,
  notes,
  schema,
  users,
  workspaceMembers,
  workspaces,
} from "../src/database/schema";
import { StorageQuotaService } from "../src/storage/storage-quota.service";
import { createTenantContext, TenantContextService } from "../src/tenant";

import { HAS_DATABASE, requireDatabase } from "./database-test-helpers";

import type { SecurityConfig } from "../src/config/security.config";
import type { StorageConfig } from "../src/config/storage.config";
import type { AuthenticatedPrincipal, WorkspacePlan } from "@notted/shared-types";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");

const GIB = 1_024 * 1_024 * 1_024;

/** Deployment ceiling for these tests. Only ever LOWERS an effective limit. */
const DEPLOYMENT_CEILING_BYTES = 10 * GIB;

const security = {
  maximumUploadBytes: 50 * 1_024 * 1_024,
  maximumWorkspaceStorageBytes: DEPLOYMENT_CEILING_BYTES,
  signedUrlTtlSeconds: 900,
} as unknown as SecurityConfig;

/**
 * A literal config value rather than a `process.env` mutation.
 *
 * `StorageConfigProvider` snapshots `process.env` at construction, so poking the
 * environment mid-run would be both invisible to an already-built provider and a
 * cross-suite side effect under Vitest's shared process. Constructing the frozen
 * shape directly is what the DI token accepts anyway.
 */
const storageConfig: StorageConfig = Object.freeze({
  planDefaultBytes: Object.freeze({ free: GIB, pro: 10 * GIB, enterprise: 100 * GIB }),
  abandonedUploadHours: 24,
  maintenanceEnabled: false,
  maintenanceDryRun: false,
  maintenanceIntervalMs: 3_600_000,
  maintenanceBatchLimit: 200,
  maintenanceObjectScanLimit: 5_000,
});

/** Thrown at the end of every fixture transaction so nothing is committed. */
class RollbackStorageQuotaTest extends Error {}

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

/** `DatabaseService` bound to the rolled-back fixture transaction. */
function scopedDatabase(tx: DatabaseTransaction): DatabaseService {
  return {
    db: tx,
    transaction: <T>(work: (scope: DatabaseTransaction) => Promise<T>): Promise<T> =>
      tx.transaction(work),
  } as unknown as DatabaseService;
}

function buildQuotaService(
  database: DatabaseService,
  tenant: TenantContextService,
): StorageQuotaService {
  const entry = new AuthorizationEntryService(
    new AuthorizationRepository(database, tenant),
    new AuthorizationPolicyService(),
    tenant,
  );
  return new StorageQuotaService(database, entry, tenant, security, storageConfig);
}

/* -------------------------------------------------------------------------- */
/* Fixture builders — every row is created by this suite and rolled back        */
/* -------------------------------------------------------------------------- */

async function insertUser(tx: DatabaseTransaction, label: string): Promise<string> {
  const id = randomUUID();
  await tx.insert(users).values({ id, email: `${label}.${id}@quota.invalid`, name: label });
  return id;
}

async function insertWorkspace(
  tx: DatabaseTransaction,
  input: {
    readonly createdById: string;
    readonly plan: WorkspacePlan;
    readonly storageLimitBytes: number | null;
  },
): Promise<string> {
  const id = randomUUID();
  await tx.insert(workspaces).values({
    id,
    name: `quota fixture ${id}`,
    slug: `quota-fixture-${id}`,
    plan: input.plan,
    storageLimitBytes: input.storageLimitBytes,
    createdById: input.createdById,
  });
  return id;
}

async function insertNote(
  tx: DatabaseTransaction,
  input: { readonly workspaceId: string; readonly createdById: string },
): Promise<string> {
  const id = randomUUID();
  await tx.insert(notes).values({
    id,
    workspaceId: input.workspaceId,
    title: "Quota fixture note",
    createdById: input.createdById,
  });
  return id;
}

async function insertAttachment(
  tx: DatabaseTransaction,
  input: {
    readonly workspaceId: string;
    readonly noteId: string;
    readonly createdById: string;
    readonly status: "pending" | "processing" | "ready" | "failed";
    readonly sizeBytes: number;
  },
): Promise<string> {
  const id = randomUUID();
  await tx.insert(attachments).values({
    id,
    noteId: input.noteId,
    workspaceId: input.workspaceId,
    originalName: `quota-${input.status}.bin`,
    filename: `quota-${input.status}.bin`,
    mimeType: "application/octet-stream",
    sizeBytes: input.sizeBytes,
    // Shaped like a real key so nothing about the fixture depends on an
    // impossible value; no object is ever written for it.
    storageKey: `w/${input.workspaceId}/a/${id}/original/${randomUUID().replaceAll("-", "")}.bin`,
    mediaType: "file",
    processingStatus: input.status,
    createdById: input.createdById,
  });
  return id;
}

interface QuotaFixture {
  readonly ownerA: string;
  readonly viewerA: string;
  readonly ownerB: string;
  readonly workspaceA: string;
  readonly workspaceB: string;
  readonly workspaceCeiling: string;
  readonly noteA: string;
}

/**
 * Workspace A carries one attachment per lifecycle state so a single read proves
 * every branch of the aggregate at once:
 *
 *   ready      1_000 + 2_000  -> usedBytes 3_000, attachmentCount 2
 *   pending      500          -> \
 *   processing   700          ->  pendingBytes 1_200 (the live reservation)
 *   failed   9_000_000        -> excluded entirely; owns no committed bytes
 *
 * The failed row is deliberately enormous: if it were ever charged, no assertion
 * below could accidentally still pass.
 */
const A_READY_BYTES = 3_000;
const A_PENDING_BYTES = 1_200;
const A_FAILED_BYTES = 9_000_000;
const A_LIMIT_BYTES = 1_000_000;
const B_READY_BYTES = 4_242;

async function seedQuotaFixture(tx: DatabaseTransaction): Promise<QuotaFixture> {
  const ownerA = await insertUser(tx, "owner-a");
  const viewerA = await insertUser(tx, "viewer-a");
  const ownerB = await insertUser(tx, "owner-b");

  const workspaceA = await insertWorkspace(tx, {
    createdById: ownerA,
    plan: "pro",
    storageLimitBytes: A_LIMIT_BYTES,
  });
  const workspaceB = await insertWorkspace(tx, {
    createdById: ownerB,
    plan: "free",
    storageLimitBytes: null,
  });
  // Enterprise default (100 GiB) deliberately exceeds the deployment ceiling.
  const workspaceCeiling = await insertWorkspace(tx, {
    createdById: ownerA,
    plan: "enterprise",
    storageLimitBytes: 50 * GIB,
  });

  await tx.insert(workspaceMembers).values([
    { workspaceId: workspaceA, userId: ownerA, role: "owner" },
    { workspaceId: workspaceA, userId: viewerA, role: "viewer" },
    { workspaceId: workspaceB, userId: ownerB, role: "owner" },
    { workspaceId: workspaceCeiling, userId: ownerA, role: "owner" },
  ]);

  const noteA = await insertNote(tx, { workspaceId: workspaceA, createdById: ownerA });
  const noteB = await insertNote(tx, { workspaceId: workspaceB, createdById: ownerB });

  for (const [status, sizeBytes] of [
    ["ready", 1_000],
    ["ready", 2_000],
    ["pending", 500],
    ["processing", 700],
    ["failed", A_FAILED_BYTES],
  ] as const) {
    await insertAttachment(tx, {
      workspaceId: workspaceA,
      noteId: noteA,
      createdById: ownerA,
      status,
      sizeBytes,
    });
  }
  await insertAttachment(tx, {
    workspaceId: workspaceB,
    noteId: noteB,
    createdById: ownerB,
    status: "ready",
    sizeBytes: B_READY_BYTES,
  });

  return Object.freeze({
    ownerA,
    viewerA,
    ownerB,
    workspaceA,
    workspaceB,
    workspaceCeiling,
    noteA,
  });
}

/* -------------------------------------------------------------------------- */

describe.skipIf(!HAS_DATABASE)("Part 45 storage quotas (live PostgreSQL)", () => {
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;

  beforeAll(async () => {
    await requireDatabase();

    pool = new Pool({ connectionString: DATABASE_URL as string, max: 4 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  it("derives usage from attachment rows: ready is used, in-flight is pending, failed is neither", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await expect(
      db.transaction(async (tx) => {
        const fixture = await seedQuotaFixture(tx);
        const tenant = new TenantContextService();
        const service = buildQuotaService(scopedDatabase(tx), tenant);

        const usage = await service.readUsage({
          principal: principal(fixture.ownerA),
          workspaceId: fixture.workspaceA,
        });

        expect(usage).toEqual({
          workspaceId: fixture.workspaceA,
          plan: "pro",
          usedBytes: A_READY_BYTES,
          pendingBytes: A_PENDING_BYTES,
          limitBytes: A_LIMIT_BYTES,
          availableBytes: A_LIMIT_BYTES - A_READY_BYTES - A_PENDING_BYTES,
          // `ready` rows only. An upload still in flight is not yet a file the
          // workspace holds, even though its bytes are already charged.
          attachmentCount: 2,
          limitSource: "override",
        });

        // The failed row is excluded by the SQL predicate, not subtracted later:
        // its bytes appear in NO field of the projection.
        const total = usage.usedBytes + usage.pendingBytes;
        expect(total).toBe(A_READY_BYTES + A_PENDING_BYTES);
        expect(total).toBeLessThan(A_FAILED_BYTES);

        // A viewer may READ usage (`settings.read` is allowed for every role);
        // it is workspace configuration, not a privileged secret.
        const viewerUsage = await service.readUsage({
          principal: principal(fixture.viewerA),
          workspaceId: fixture.workspaceA,
        });
        expect(viewerUsage).toEqual(usage);

        // No override -> the plan default applies and says so.
        const planUsage = await service.readUsage({
          principal: principal(fixture.ownerB),
          workspaceId: fixture.workspaceB,
        });
        expect(planUsage).toMatchObject({
          plan: "free",
          usedBytes: B_READY_BYTES,
          pendingBytes: 0,
          attachmentCount: 1,
          limitBytes: GIB,
          limitSource: "plan",
        });

        // The deployment ceiling can only ever LOWER a limit: a 50 GiB override
        // on an enterprise workspace still resolves to the 10 GiB ceiling, and
        // the source is still reported as the override the operator set.
        const clamped = await service.readUsage({
          principal: principal(fixture.ownerA),
          workspaceId: fixture.workspaceCeiling,
        });
        expect(clamped).toMatchObject({
          plan: "enterprise",
          limitBytes: DEPLOYMENT_CEILING_BYTES,
          limitSource: "override",
          usedBytes: 0,
          attachmentCount: 0,
        });

        throw new RollbackStorageQuotaTest("rollback quota usage fixture");
      }),
    ).rejects.toBeInstanceOf(RollbackStorageQuotaTest);
  });

  it("confines usage to one workspace and refuses a non-member without leaking existence", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await expect(
      db.transaction(async (tx) => {
        const fixture = await seedQuotaFixture(tx);
        const tenant = new TenantContextService();
        const service = buildQuotaService(scopedDatabase(tx), tenant);

        // --- Neither workspace can see the other's bytes. ---
        const a = await service.readUsage({
          principal: principal(fixture.ownerA),
          workspaceId: fixture.workspaceA,
        });
        const b = await service.readUsage({
          principal: principal(fixture.ownerB),
          workspaceId: fixture.workspaceB,
        });
        expect(a.usedBytes).toBe(A_READY_BYTES);
        expect(b.usedBytes).toBe(B_READY_BYTES);
        // The database holds both sets of rows at once, so equal totals would
        // mean the scope predicate had been dropped.
        const [everything] = await tx
          .select({
            bytes: sql`coalesce(sum(${attachments.sizeBytes}), 0)::bigint`.mapWith(Number),
          })
          .from(attachments);
        expect(everything?.bytes ?? 0).toBeGreaterThan(a.usedBytes + b.usedBytes);

        // --- B's owner is not a member of A. ---
        const denied = await service
          .readUsage({
            principal: principal(fixture.ownerB),
            workspaceId: fixture.workspaceA,
          })
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(denied).toMatchObject({
          name: "AuthorizationDeniedError",
          decision: {
            allowed: false,
            code: "authorization.concealed",
            httpStatus: 404,
            safeMessage: "The requested resource was not found.",
          },
        });

        // --- ...and a workspace that does not exist answers IDENTICALLY. ---
        // Distinguishable answers would let an outsider probe for real
        // workspaces; this is the actual no-existence-leak assertion.
        const absent = await service
          .readUsage({ principal: principal(fixture.ownerB), workspaceId: randomUUID() })
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect((absent as { decision?: { code?: string } }).decision?.code).toBe(
          (denied as { decision?: { code?: string } }).decision?.code,
        );
        expect((absent as Error).message).toBe((denied as Error).message);

        // The refusal carries no usage figure, workspace name, or slug — only
        // the fixed safe message and the audit verdict.
        const serialized = JSON.stringify((denied as { decision?: unknown }).decision ?? {});
        for (const leak of [
          "usedBytes",
          "pendingBytes",
          "limitBytes",
          "attachmentCount",
          "quota fixture",
          "quota-fixture-",
        ]) {
          expect(serialized, `refusal leaked ${leak}`).not.toContain(leak);
        }

        throw new RollbackStorageQuotaTest("rollback cross-workspace fixture");
      }),
    ).rejects.toBeInstanceOf(RollbackStorageQuotaTest);
  });

  it("reserves under the workspace row lock, charging in-flight rows and refusing the byte over the limit", async ({
    skip,
  }) => {
    if (db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await expect(
      db.transaction(async (tx) => {
        const fixture = await seedQuotaFixture(tx);
        const tenant = new TenantContextService();
        const database = scopedDatabase(tx);
        const service = buildQuotaService(database, tenant);

        const charged = A_READY_BYTES + A_PENDING_BYTES;
        const inWorkspaceA = <T>(work: () => Promise<T>): Promise<T> =>
          tenant.run(
            createTenantContext({ workspaceId: fixture.workspaceA, userId: fixture.ownerA }),
            work,
          );

        // Exactly the remaining headroom fits...
        const headroom = A_LIMIT_BYTES - charged;
        await expect(inWorkspaceA(() => service.reserve(tx, headroom))).resolves.toBeUndefined();
        // ...and one byte more does not. The boundary is `<=`, not `<`.
        await expect(inWorkspaceA(() => service.reserve(tx, headroom + 1))).rejects.toMatchObject({
          safeResponse: { code: "PAYLOAD_TOO_LARGE" },
        });

        // --- In-flight rows ARE the reservation. ---
        // Squeeze the limit to exactly what is charged now: nothing more fits.
        await tx
          .update(workspaces)
          .set({ storageLimitBytes: charged })
          .where(eq(workspaces.id, fixture.workspaceA));
        await expect(inWorkspaceA(() => service.reserve(tx, 1))).rejects.toMatchObject({
          safeResponse: { code: "PAYLOAD_TOO_LARGE" },
        });
        // Retire workspace A's in-flight rows the way a failed upload does.
        // Their bytes stop being charged immediately, WITHOUT a compensating
        // "release" step that a crash could skip.
        await tx
          .update(attachments)
          .set({ processingStatus: "failed" })
          .where(
            and(
              eq(attachments.workspaceId, fixture.workspaceA),
              inArray(attachments.processingStatus, ["pending", "processing"]),
            ),
          );
        // Exactly the freed reservation now fits again — no more, no less.
        await expect(
          inWorkspaceA(() => service.reserve(tx, A_PENDING_BYTES)),
        ).resolves.toBeUndefined();
        await expect(
          inWorkspaceA(() => service.reserve(tx, A_PENDING_BYTES + 1)),
        ).rejects.toMatchObject({ safeResponse: { code: "PAYLOAD_TOO_LARGE" } });

        // --- Another workspace's bytes never consume this one's quota. ---
        // Workspace B holds `B_READY_BYTES`; A's limit is now exactly its own
        // charged total, so if B leaked in, the reserve above would have failed.
        const [scoped] = await tx
          .select({
            bytes:
              sql`coalesce(sum(${attachments.sizeBytes}) filter (where ${attachments.processingStatus} = 'ready'), 0)::bigint`.mapWith(
                Number,
              ),
          })
          .from(attachments)
          .where(eq(attachments.workspaceId, fixture.workspaceA));
        expect(scoped?.bytes).toBe(A_READY_BYTES);

        // --- A workspace that is not there answers "not found", not "empty". ---
        await expect(
          tenant.run(
            createTenantContext({ workspaceId: randomUUID(), userId: fixture.ownerA }),
            () => service.reserve(tx, 1),
          ),
        ).rejects.toMatchObject({ safeResponse: { code: "NOT_FOUND" } });

        throw new RollbackStorageQuotaTest("rollback reserve fixture");
      }),
    ).rejects.toBeInstanceOf(RollbackStorageQuotaTest);
  });
});
