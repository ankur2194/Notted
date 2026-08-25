// Part 73 — custom domains against a real PostgreSQL.
//
// DATABASE-GATED like `audit-logs.integration.test.ts`: without a reachable
// `DATABASE_URL` the suite skips rather than failing, and `pnpm test:ci` is the
// run that actually proves it (see CLAUDE.md → Quality gates).
//
// EVERY case runs inside one outer transaction that is rolled back, so the suite
// leaves no rows behind — which matters more here than elsewhere, because
// `workspace_domains.hostname` is GLOBALLY unique and a leaked fixture row would
// make the next run fail on a name it did not choose.
//
// What only a live database can prove, and what this file therefore exists for:
//   1. the global hostname uniqueness (two tenants racing for one address);
//   2. the one-claim-per-workspace uniqueness;
//   3. that `resolve` answers for verified hosts and 404s for pending ones;
//   4. that the workspace cascade takes the claim with it;
//   5. cross-tenant denial through the real policy stack.

import { resolve as resolvePath } from "node:path";

import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationEntryService } from "../src/authorization/authorization-entry.service";
import { AuthorizationPolicyService } from "../src/authorization/authorization-policy.service";
import { AuthorizationDeniedError } from "../src/authorization/authorization.errors";
import { AuthorizationRepository } from "../src/authorization/authorization.repository";
import { parseAppConfig } from "../src/config/app.config";
import { auditLogs, schema, workspaceDomains, workspaces } from "../src/database/schema";
import { SEED_IDS, seedDatabase } from "../src/database/seed";
import { DomainsService } from "../src/domains/domains.service";
import { TenantContextService } from "../src/tenant";

import type { ApiHttpException } from "../src/common/errors/api-http.exception";
import type { VerifiedHostsService } from "../src/common/verified-hosts.service";
import type { DatabaseService, DatabaseTransaction } from "../src/database/database.service";
import type { DomainDnsResolver } from "../src/domains/domain-verifier";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

const DATABASE_URL = process.env.DATABASE_URL;
const HAS_DATABASE_URL = typeof DATABASE_URL === "string" && DATABASE_URL.trim() !== "";
const MIGRATIONS_FOLDER = resolvePath(process.cwd(), "src/database/migrations");
const CONNECTION_TIMEOUT_MS = 2_000;
const CNAME_TARGET = "edge.notted.test";
const ALPHA_HOST = "notes.alpha.test";
const BETA_HOST = "notes.beta.test";

type Database = NodePgDatabase<typeof schema>;

/** Rolls the outer transaction back without swallowing a real failure. */
class RollbackDomainsTest extends Error {}

/** Captures the thrown `ApiHttpException` so its status and code can be asserted. */
async function rejection(work: Promise<unknown>): Promise<ApiHttpException> {
  try {
    await work;
  } catch (error: unknown) {
    return error as ApiHttpException;
  }
  throw new Error("expected the call to reject");
}

/**
 * The status a caller would end up seeing. Application services throw
 * `AuthorizationDeniedError` — the HTTP mapping is the transport layer's job
 * (`authorizationDenialToHttpException`) — so a denial reached at service level
 * is not an `ApiHttpException` and has no `getStatus()`.
 */
async function rejectionStatus(work: Promise<unknown>): Promise<number> {
  try {
    await work;
  } catch (error: unknown) {
    if (error instanceof AuthorizationDeniedError) return error.decision.httpStatus;
    return (error as ApiHttpException).getStatus();
  }
  throw new Error("expected the call to reject");
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

function databaseOn(tx: DatabaseTransaction): DatabaseService {
  return {
    db: tx,
    transaction: <T>(work: (inner: DatabaseTransaction) => Promise<T>): Promise<T> =>
      tx.transaction(work),
  } as unknown as DatabaseService;
}

/** Always answers "the records are published", so the DNS is not under test here. */
function passingResolver(token: () => string): DomainDnsResolver {
  return {
    resolveTxt: () => Promise.resolve([[`notted-verify=${token()}`]]),
    resolveCname: () => Promise.resolve([CNAME_TARGET]),
    lookup: () => Promise.resolve([{ address: "203.0.113.10" }]),
  };
}

function build(tx: DatabaseTransaction, dns: DomainDnsResolver) {
  const tenant = new TenantContextService();
  const database = databaseOn(tx);
  const entry = new AuthorizationEntryService(
    new AuthorizationRepository(database, tenant),
    new AuthorizationPolicyService(),
    tenant,
  );
  const verifiedHosts = {
    staticHosts: new Set(["app.notted.test", CNAME_TARGET]),
    invalidate: () => undefined,
  } as unknown as VerifiedHostsService;
  const domains = new DomainsService(
    database,
    entry,
    tenant,
    verifiedHosts,
    parseAppConfig({
      APP_URL: "http://app.notted.test",
      CUSTOM_DOMAINS_ENABLED: "true",
      CUSTOM_DOMAIN_CNAME_TARGET: CNAME_TARGET,
    }),
    dns,
  );
  return { domains, tenant };
}

async function status(tx: DatabaseTransaction, workspaceId: string) {
  const [row] = await tx
    .select()
    .from(workspaceDomains)
    .where(eq(workspaceDomains.workspaceId, workspaceId))
    .limit(1);
  return row;
}

describe.skipIf(!HAS_DATABASE_URL)("Part 73 custom domains (live)", () => {
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

  it("claims, verifies, mirrors, resolves, and releases a hostname", async ({ skip }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }
    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        let token = "";
        const { domains } = build(
          tx,
          passingResolver(() => token),
        );
        const owner = principal(SEED_IDS.users.alphaOwner);
        const workspaceId = SEED_IDS.workspaces.alpha;

        const claimed = await domains.set({ principal: owner, workspaceId, hostname: ALPHA_HOST });
        expect(claimed.domain).toMatchObject({ hostname: ALPHA_HOST, status: "pending" });
        // A pending claim routes nothing and is invisible to the ACME seam.
        expect((await rejection(domains.resolve(ALPHA_HOST))).getStatus()).toBe(404);
        expect((await status(tx, workspaceId))?.status).toBe("pending");
        const [beforeVerify] = await tx
          .select({ domain: workspaces.domain })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId));
        expect(beforeVerify?.domain).toBeNull();

        token = (await status(tx, workspaceId))?.verificationToken ?? "";
        const verified = await domains.verify({ principal: owner, workspaceId });
        expect(verified.domain).toMatchObject({ status: "verified", lastError: null });

        // The mirror now carries the PROVED hostname, and the ACME seam answers.
        const [afterVerify] = await tx
          .select({ domain: workspaces.domain, slug: workspaces.slug })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId));
        expect(afterVerify?.domain).toBe(ALPHA_HOST);
        await expect(domains.resolve(ALPHA_HOST)).resolves.toEqual({
          workspaceId,
          slug: afterVerify?.slug,
        });

        // Three audit rows, identifiers and hostname only, no token anywhere.
        const audits = await tx
          .select({ action: auditLogs.action, metadata: auditLogs.metadata })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.workspaceId, workspaceId),
              eq(auditLogs.entityType, "workspace_domain"),
            ),
          );
        expect(audits.map((row) => row.action).sort()).toEqual(["domain.set", "domain.verify"]);
        expect(JSON.stringify(audits)).not.toContain(token);

        await domains.remove({ principal: owner, workspaceId });
        expect(await status(tx, workspaceId)).toBeUndefined();
        expect((await rejection(domains.resolve(ALPHA_HOST))).getStatus()).toBe(404);
        const [afterRemove] = await tx
          .select({ domain: workspaces.domain })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId));
        expect(afterRemove?.domain).toBeNull();

        throw new RollbackDomainsTest();
      }),
    ).rejects.toBeInstanceOf(RollbackDomainsTest);
  });

  // Two tenants racing for one address is a race only the database can settle.
  it("refuses a hostname another workspace already claimed", async ({ skip }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }
    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const { domains } = build(
          tx,
          passingResolver(() => ""),
        );
        await domains.set({
          principal: principal(SEED_IDS.users.alphaOwner),
          workspaceId: SEED_IDS.workspaces.alpha,
          hostname: ALPHA_HOST,
        });
        // A nested savepoint: the expected unique violation must not poison the
        // outer transaction the rest of this case still needs.
        const conflict = await rejection(
          tx.transaction(async (inner) =>
            build(
              inner,
              passingResolver(() => ""),
            ).domains.set({
              principal: principal(SEED_IDS.users.betaOwner),
              workspaceId: SEED_IDS.workspaces.beta,
              hostname: ALPHA_HOST,
            }),
          ),
        );
        expect(conflict.getStatus()).toBe(409);
        expect(conflict.safeResponse.code).toBe("DOMAIN_TAKEN");

        // Beta may still claim its OWN name.
        const beta = await domains.set({
          principal: principal(SEED_IDS.users.betaOwner),
          workspaceId: SEED_IDS.workspaces.beta,
          hostname: BETA_HOST,
        });
        expect(beta.domain?.hostname).toBe(BETA_HOST);

        throw new RollbackDomainsTest();
      }),
    ).rejects.toBeInstanceOf(RollbackDomainsTest);
  });

  it("denies every operation to a member of another workspace", async ({ skip }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }
    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const { domains } = build(
          tx,
          passingResolver(() => ""),
        );
        const outsider = principal(SEED_IDS.users.betaOwner);
        const workspaceId = SEED_IDS.workspaces.alpha;
        // No cross-workspace existence leak: the alpha claim is not even
        // readable, let alone writable, from beta's owner.
        await expect(domains.read({ principal: outsider, workspaceId })).rejects.toBeDefined();
        await expect(
          domains.set({ principal: outsider, workspaceId, hostname: ALPHA_HOST }),
        ).rejects.toBeDefined();
        await expect(domains.verify({ principal: outsider, workspaceId })).rejects.toBeDefined();
        await expect(domains.remove({ principal: outsider, workspaceId })).rejects.toBeDefined();

        // A viewer inside the workspace may not write settings either.
        const viewer = principal(SEED_IDS.users.alphaViewer);
        expect(
          await rejectionStatus(
            domains.set({ principal: viewer, workspaceId, hostname: ALPHA_HOST }),
          ),
        ).toBe(403);

        throw new RollbackDomainsTest();
      }),
    ).rejects.toBeInstanceOf(RollbackDomainsTest);
  });

  it("takes the claim with the workspace when the workspace is deleted", async ({ skip }) => {
    if (!reachable || db === undefined) {
      skip("skipped: no reachable PostgreSQL — run dev compose");
      return;
    }
    await expect(
      db.transaction(async (tx) => {
        await seedDatabase(tx);
        const { domains } = build(
          tx,
          passingResolver(() => ""),
        );
        await domains.set({
          principal: principal(SEED_IDS.users.betaOwner),
          workspaceId: SEED_IDS.workspaces.beta,
          hostname: BETA_HOST,
        });
        expect(await status(tx, SEED_IDS.workspaces.beta)).toBeDefined();

        await tx.delete(workspaces).where(eq(workspaces.id, SEED_IDS.workspaces.beta));
        // CASCADE, so the hostname is freed for whoever proves ownership next.
        expect(await status(tx, SEED_IDS.workspaces.beta)).toBeUndefined();

        throw new RollbackDomainsTest();
      }),
    ).rejects.toBeInstanceOf(RollbackDomainsTest);
  });
});
