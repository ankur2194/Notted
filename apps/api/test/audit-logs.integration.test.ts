// Part 71 — the live audit trail: append-only enforcement, request capture,
// authorization, filtering and retention, against a real PostgreSQL.
//
// DATABASE-GATED like `authorization.integration.test.ts`: without a reachable
// `DATABASE_URL` the suite skips rather than failing, and `pnpm test:ci` is the
// run that actually proves it (see CLAUDE.md → Quality gates).
//
// EVERY case runs inside one outer transaction that is rolled back, so the
// suite leaves no rows behind. Cases that expect the append-only trigger to
// RAISE use a nested `tx.transaction(...)` — Drizzle issues a SAVEPOINT, so the
// refusal rolls back only the savepoint and the outer transaction survives to
// run the next assertion. Without the savepoint the first expected exception
// would poison every case after it.

import { resolve } from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiKeysService } from "../src/api-keys/api-keys.service";
import { AuditLogsService } from "../src/audit/audit-logs.service";
import { allowAuditDelete } from "../src/audit/audit-record";
import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import { runWithRequestContext } from "../src/common/request/request-context";
import { auditLogs, schema, users, workspaces } from "../src/database/schema";
import { SEED_IDS, seedDatabase } from "../src/database/seed";
import { AuditLogRetentionService } from "../src/maintenance/audit-log-retention.service";
import { TenantContextService } from "../src/tenant";

import type { StructuredLogger } from "../src/common/logging/structured-logger.service";
import type { AuthConfig } from "../src/config/auth.config";
import type { RetentionConfig } from "../src/config/retention.config";
import type { DatabaseService, DatabaseTransaction } from "../src/database/database.service";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

const DATABASE_URL = process.env.DATABASE_URL;
const HAS_DATABASE_URL = typeof DATABASE_URL === "string" && DATABASE_URL.trim() !== "";
const MIGRATIONS_FOLDER = resolve(process.cwd(), "src/database/migrations");
const CONNECTION_TIMEOUT_MS = 2_000;
const PEPPER = "audit-integration-pepper";
const API_KEY_ACTOR_ID = "20000000-0000-4000-8d00-000000000001";

type Database = NodePgDatabase<typeof schema>;

class RollbackAuditTest extends Error {}

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

function build(tx: DatabaseTransaction) {
  const tenant = new TenantContextService();
  const database = databaseOn(tx);
  const entry = new AuthorizationEntryService(
    new AuthorizationRepository(database, tenant),
    new AuthorizationPolicyService(),
    tenant,
  );
  return {
    tenant,
    database,
    entry,
    auditLogs: new AuditLogsService(database, entry, tenant),
    apiKeys: new ApiKeysService(database, entry, tenant, { secret: PEPPER } as AuthConfig),
  };
}

/** One audit row belonging to the seeded Alpha workspace. */
async function seededAlphaRow(tx: DatabaseTransaction) {
  const [row] = await tx
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.id, SEED_IDS.auditLogs.alphaWorkspaceCreate))
    .limit(1);
  return row;
}

describe.skipIf(!HAS_DATABASE_URL)("Part 71 audit trail (live)", () => {
  let pool: Pool | undefined;
  let db: Database | undefined;
  let reachable = false;

  beforeAll(async () => {
    reachable = await isDatabaseReachable(DATABASE_URL as string);
    if (!reachable) return;
    pool = new Pool({ connectionString: DATABASE_URL as string, max: 1 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  it("refuses UPDATE and DELETE, but allows the purge flag and referential actions", async ({
    skip,
  }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        expect(await seededAlphaRow(tx)).toBeDefined();

        // 1. A plain UPDATE is refused with `insufficient_privilege` (42501).
        await expect(
          tx.transaction(async (inner) =>
            inner
              .update(auditLogs)
              .set({ action: "tampered" })
              .where(eq(auditLogs.id, SEED_IDS.auditLogs.alphaWorkspaceCreate)),
          ),
        ).rejects.toMatchObject({ cause: { code: "42501" } });

        // 2. A plain DELETE is refused the same way.
        await expect(
          tx.transaction(async (inner) =>
            inner.delete(auditLogs).where(eq(auditLogs.id, SEED_IDS.auditLogs.alphaMemberInvite)),
          ),
        ).rejects.toMatchObject({ cause: { code: "42501" } });

        // The refusals changed nothing.
        expect((await seededAlphaRow(tx))?.action).toBe("workspace.create");

        // 3. A DELETE under the transaction-local purge flag succeeds — the one
        //    sanctioned exception, and the one the retention sweep relies on.
        await tx.transaction(async (inner) => {
          await allowAuditDelete(inner);
          await inner
            .delete(auditLogs)
            .where(eq(auditLogs.id, SEED_IDS.auditLogs.alphaMemberInvite));
        });
        const [gone] = await tx
          .select({ id: auditLogs.id })
          .from(auditLogs)
          .where(eq(auditLogs.id, SEED_IDS.auditLogs.alphaMemberInvite));
        expect(gone).toBeUndefined();

        // 4. The trigger re-reads the flag on every statement rather than
        //    latching it: clearing it refuses the very next delete.
        //
        //    This step deliberately does NOT try to prove transaction scoping.
        //    `set_config(..., true)` is transaction-local, and step 3's
        //    `tx.transaction()` is a SAVEPOINT inside this test's rollback
        //    transaction — a released savepoint keeps the setting for the rest
        //    of the enclosing transaction, so an assertion here would be
        //    testing PostgreSQL's savepoint semantics, not the trigger. The
        //    pooled-connection property is asserted after the rollback below,
        //    where a genuinely fresh top-level transaction exists.
        await tx.execute(sql`select set_config('notted.audit_purge', 'off', true)`);
        await expect(
          tx.transaction(async (inner) =>
            inner.delete(auditLogs).where(eq(auditLogs.id, SEED_IDS.auditLogs.alphaNoteCreated)),
          ),
        ).rejects.toMatchObject({ cause: { code: "42501" } });

        // 5. The `user_id` SET NULL referential action is allowed: deleting the
        //    actor must not destroy the evidence, and the trigger recognises the
        //    RI path by trigger depth rather than by an escape hatch.
        //
        //    A throwaway actor, not a seeded one: every seeded user authors
        //    notes, and `notes.created_by_id` is RESTRICT, so deleting one is
        //    refused by a different constraint before this trigger is reached.
        const [departing] = await tx
          .insert(users)
          .values({ email: "departing-actor@notted.test", name: "Departing Actor" })
          .returning({ id: users.id });
        expect(departing).toBeDefined();
        const [evidence] = await tx
          .insert(auditLogs)
          .values({
            workspaceId: SEED_IDS.workspaces.alpha,
            userId: departing?.id,
            action: "note.create",
            entityType: "note",
            entityId: SEED_IDS.workspaces.alpha,
          })
          .returning({ id: auditLogs.id });
        expect(evidence).toBeDefined();

        await tx.delete(users).where(eq(users.id, departing?.id as string));
        const [orphaned] = await tx
          .select({ userId: auditLogs.userId })
          .from(auditLogs)
          .where(eq(auditLogs.id, evidence?.id as string));
        expect(orphaned).toBeDefined();
        expect(orphaned?.userId).toBeNull();

        // 6. The `workspace_id` CASCADE is allowed: an audit trail is tenant
        //    scoped and does not outlive its tenant.
        await tx.delete(workspaces).where(eq(workspaces.id, SEED_IDS.workspaces.beta));
        const [betaRows] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(auditLogs)
          .where(eq(auditLogs.workspaceId, SEED_IDS.workspaces.beta));
        expect(betaRows?.count).toBe(0);

        throw new RollbackAuditTest();
      }),
    ).rejects.toBeInstanceOf(RollbackAuditTest);

    // The purge flag must not leak onto a pooled connection. The pool is
    // `max: 1`, so this fresh top-level transaction runs on literally the same
    // backend that ran the sanctioned delete above.
    const leaked = await db.execute<{ readonly value: string | null }>(
      sql`select current_setting('notted.audit_purge', true) as value`,
    );
    // After the rollback the custom GUC reads back as "" rather than NULL (its
    // reset value), which is what matters: the trigger only exempts `'on'`.
    expect(leaked.rows[0]?.value ?? null).not.toBe("on");
  });

  it("records exactly one row per sensitive mutation, with the request facts and no secret", async ({
    skip,
  }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const { apiKeys: apiKeysService } = build(tx);

        const created = await runWithRequestContext(
          {
            requestId: "11111111-2222-4333-8444-555555555555",
            ipAddress: "203.0.113.42",
            userAgent: "IntegrationAgent/1.0",
          },
          () =>
            apiKeysService.create({
              principal: principal(SEED_IDS.users.alphaAdmin),
              workspaceId: SEED_IDS.workspaces.alpha,
              name: "Audit integration key",
              scopes: ["read"],
              idempotencyKey: "audit-integration-key-0001",
            }),
        );

        const rows = await tx
          .select()
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.workspaceId, SEED_IDS.workspaces.alpha),
              eq(auditLogs.entityId, created.apiKey.id),
            ),
          );

        // EXACTLY ONE — the Plan Part 71 verification criterion.
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          userId: SEED_IDS.users.alphaAdmin,
          entityType: "api_key",
          ipAddress: "203.0.113.42",
          userAgent: "IntegrationAgent/1.0",
          requestId: "11111111-2222-4333-8444-555555555555",
        });

        // The row can identify the credential and can never authenticate as it.
        const serialized = JSON.stringify(rows[0]);
        expect(serialized).not.toContain(created.secret);
        expect(serialized).not.toContain(PEPPER);
        expect(serialized).toContain(created.secret.slice(0, 8));

        throw new RollbackAuditTest();
      }),
    ).rejects.toBeInstanceOf(RollbackAuditTest);
  });

  it("lets owners and admins read the trail and refuses everyone else", async ({ skip }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const { auditLogs: service, entry } = build(tx);
        const alpha = SEED_IDS.workspaces.alpha;
        const page = { page: 1, limit: 25 };

        const admin = await service.list({
          principal: principal(SEED_IDS.users.alphaAdmin),
          workspaceId: alpha,
          ...page,
        });
        expect(admin.items.length).toBeGreaterThan(0);
        // Tenant scope: not one Beta row reaches an Alpha reader.
        expect(admin.items.every((item) => item.workspaceId === alpha)).toBe(true);

        await expect(
          service.list({
            principal: principal(SEED_IDS.users.alphaOwner),
            workspaceId: alpha,
            ...page,
          }),
        ).resolves.toBeDefined();

        // An editor and a viewer are FORBIDDEN — the case the generic `.read`
        // suffix rule in the policy would have allowed without the explicit
        // `audit.` deny.
        for (const userId of [SEED_IDS.users.alphaEditor, SEED_IDS.users.alphaViewer]) {
          await expect(
            service.list({ principal: principal(userId), workspaceId: alpha, ...page }),
          ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 403 } });
        }

        // A member of another tenant gets 404, never 403: the workspace's
        // existence must not leak.
        await expect(
          service.list({
            principal: principal(SEED_IDS.users.betaOwner),
            workspaceId: alpha,
            ...page,
          }),
        ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 404 } });

        // Export is the same gate.
        await expect(
          service.exportRows({
            principal: principal(SEED_IDS.users.alphaViewer),
            workspaceId: alpha,
          }),
        ).rejects.toMatchObject({ decision: { allowed: false, httpStatus: 403 } });
        await expect(
          service.exportRows({
            principal: principal(SEED_IDS.users.alphaAdmin),
            workspaceId: alpha,
          }),
        ).resolves.toBeDefined();

        // A read-scoped API key cannot reach the trail; `audit.read` is an
        // admin-scope action despite its `.read` suffix.
        await expect(
          entry.authorizeApiKey({
            actor: {
              kind: "api-key",
              apiKeyId: API_KEY_ACTOR_ID,
              workspaceId: alpha,
              scopes: ["read"],
            },
            action: "audit.read",
            resource: { kind: "workspace" },
          }),
        ).rejects.toMatchObject({ decision: { allowed: false } });
        await expect(
          entry.authorizeApiKey({
            actor: {
              kind: "api-key",
              apiKeyId: API_KEY_ACTOR_ID,
              workspaceId: alpha,
              scopes: ["admin"],
            },
            action: "audit.read",
            resource: { kind: "workspace" },
          }),
        ).resolves.toMatchObject({ decision: { allowed: true } });

        throw new RollbackAuditTest();
      }),
    ).rejects.toBeInstanceOf(RollbackAuditTest);
  });

  it("filters and pages the trail deterministically", async ({ skip }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const { auditLogs: service } = build(tx);
        const alpha = SEED_IDS.workspaces.alpha;
        const admin = principal(SEED_IDS.users.alphaAdmin);

        const byAction = await service.list({
          principal: admin,
          workspaceId: alpha,
          page: 1,
          limit: 25,
          action: "workspace.create",
        });
        expect(byAction.items.every((item) => item.action === "workspace.create")).toBe(true);
        // The Beta `workspace.create` row shares the action and must NOT appear.
        expect(byAction.items.every((item) => item.workspaceId === alpha)).toBe(true);

        const byActor = await service.list({
          principal: admin,
          workspaceId: alpha,
          page: 1,
          limit: 25,
          userId: SEED_IDS.users.alphaEditor,
        });
        expect(byActor.items.every((item) => item.userId === SEED_IDS.users.alphaEditor)).toBe(
          true,
        );

        const byEntityType = await service.list({
          principal: admin,
          workspaceId: alpha,
          page: 1,
          limit: 25,
          entityType: "note",
        });
        expect(byEntityType.items.every((item) => item.entityType === "note")).toBe(true);

        // A window that ends before the seeded rows were written selects none.
        const empty = await service.list({
          principal: admin,
          workspaceId: alpha,
          page: 1,
          limit: 25,
          to: "2000-01-01T00:00:00.000Z",
        });
        expect(empty.items).toHaveLength(0);
        expect(empty.hasMore).toBe(false);

        // Paging: one row per page, no repeats and no gaps across the boundary.
        const first = await service.list({
          principal: admin,
          workspaceId: alpha,
          page: 1,
          limit: 1,
        });
        expect(first.items).toHaveLength(1);
        expect(first.hasMore).toBe(true);
        const second = await service.list({
          principal: admin,
          workspaceId: alpha,
          page: 2,
          limit: 1,
        });
        expect(second.items[0]?.id).not.toBe(first.items[0]?.id);

        throw new RollbackAuditTest();
      }),
    ).rejects.toBeInstanceOf(RollbackAuditTest);
  });

  it("purges only rows past the retention window, and dry runs delete nothing", async ({
    skip,
  }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }

    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const logger = { info: () => undefined } as unknown as StructuredLogger;
        const retention = new AuditLogRetentionService(databaseOn(tx), logger, {
          auditLogRetentionDays: 365,
        } as RetentionConfig);

        // One row well past the window; the four seeded rows are inside it.
        const expiredId = "20000000-0000-4000-8c00-0000000000ff";
        await tx.insert(auditLogs).values({
          id: expiredId,
          workspaceId: SEED_IDS.workspaces.alpha,
          userId: SEED_IDS.users.alphaOwner,
          action: "workspace.create",
          entityType: "workspace",
          entityId: SEED_IDS.workspaces.alpha,
          metadata: {},
          createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1_000),
        });

        // A dry run reports the candidate and deletes nothing.
        expect(await retention.purgeExpired({ dryRun: true })).toBe(1);
        const [afterDryRun] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(auditLogs)
          .where(eq(auditLogs.id, expiredId));
        expect(afterDryRun?.count).toBe(1);

        // The real sweep removes exactly that row and leaves the rest alone.
        expect(await retention.purgeExpired()).toBe(1);
        const [afterPurge] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(auditLogs)
          .where(eq(auditLogs.id, expiredId));
        expect(afterPurge?.count).toBe(0);
        expect(await seededAlphaRow(tx)).toBeDefined();

        // Idempotent: a second sweep finds nothing left to do.
        expect(await retention.purgeExpired()).toBe(0);

        throw new RollbackAuditTest();
      }),
    ).rejects.toBeInstanceOf(RollbackAuditTest);
  });
});
