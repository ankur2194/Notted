// Part 45 — the two storage-quota SQL paths and their locking contract.
//
// The write path (`reserve`) must take `SELECT ... FOR UPDATE` on the workspace
// row; the read path (`readUsage`) must take NO lock and open NO transaction, so
// a settings page refreshing its usage bar can never block an upload. Both must
// derive their numbers from the workspace's OWN attachment rows, inside the
// authorized tenant context.
//
// The Drizzle builder is replaced by a chain double that records every call, so
// the absence of a lock is asserted directly rather than inferred.

import { HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { ApiHttpException } from "../common/errors/api-http.exception";
import { parseStorageConfig } from "../config/storage.config";
import { attachments, workspaces } from "../database/schema";
import { createTenantContext, TenantContextService } from "../tenant";

import { StorageQuotaService } from "./storage-quota.service";

import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { SecurityConfig } from "../config/security.config";
import type { DatabaseService, DatabaseTransaction } from "../database/database.service";
import type { AuthenticatedPrincipal, WorkspacePlan } from "@notted/shared-types";

const GIB = 1_024 * 1_024 * 1_024;

const userId = "30000000-0000-4000-8000-000000000001";
const workspaceId = "30000000-0000-4000-8100-000000000001";
/** A workspace the caller is NOT authorized for; used for the isolation test. */
const otherWorkspaceId = "30000000-0000-4000-8100-000000000002";

const security = { maximumWorkspaceStorageBytes: 10 * GIB } as unknown as SecurityConfig;
const storageConfig = parseStorageConfig({});

function principal(): AuthenticatedPrincipal {
  return Object.freeze({
    userId,
    sessionId: "session",
    method: "opaque-session",
    assurance: "single-factor",
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isFresh: true,
  });
}

type QueryRow = Readonly<Record<string, unknown>>;

/** Every builder method the quota SQL uses, all of them awaitable. */
interface SelectChain {
  where(): SelectChain;
  limit(): SelectChain;
  for(mode: string): SelectChain;
  then(resolve: (value: readonly QueryRow[]) => unknown): unknown;
}

interface QuotaDatabaseOptions {
  readonly workspaceMissing?: boolean;
  readonly plan?: WorkspacePlan;
  readonly overrideBytes?: number | null;
  /** Aggregate per workspace id, so a cross-tenant read would be visible. */
  readonly aggregateByWorkspace?: Readonly<
    Record<string, { readyBytes: number; reservedBytes: number; readyCount: number }>
  >;
}

/**
 * Stubs the Drizzle fluent builder with just enough behaviour to observe the
 * two queries the quota service issues, and — crucially — WHICH builder methods
 * each one calls.
 */
function fakeQuotaDatabase(options: QuotaDatabaseOptions = {}, tenant?: TenantContextService) {
  const calls: string[] = [];

  function chain(rows: readonly QueryRow[]): SelectChain {
    const value: SelectChain = {
      where: () => value,
      limit: () => value,
      for: (mode: string) => {
        calls.push(`for:${mode}`);
        return value;
      },
      then: (resolve) => resolve(rows),
    };
    return value;
  }

  function aggregateRows(): readonly QueryRow[] {
    const activeWorkspace = tenant?.tryGet()?.workspaceId ?? workspaceId;
    const totals = options.aggregateByWorkspace?.[activeWorkspace] ?? {
      readyBytes: 0,
      reservedBytes: 0,
      readyCount: 0,
    };
    return [totals];
  }

  const builder = {
    select: () => ({
      from: (table: unknown): SelectChain => {
        if (table === workspaces) {
          calls.push("select:workspaces");
          return chain(
            options.workspaceMissing === true
              ? []
              : [{ plan: options.plan ?? "free", overrideBytes: options.overrideBytes ?? null }],
          );
        }
        if (table === attachments) {
          calls.push("select:attachments");
          return chain(aggregateRows());
        }
        calls.push("select:unknown");
        return chain([]);
      },
    }),
  };

  const transaction = vi.fn();
  const database = { db: builder, transaction } as unknown as DatabaseService;
  return { database, calls, transaction, tx: builder as unknown as DatabaseTransaction };
}

interface AuthorizationOptions {
  readonly denied?: boolean;
  /** The workspace the entry service actually authorized and scoped. */
  readonly authorizedWorkspaceId?: string;
  /** `false` models a mis-wired entry service that establishes no scope. */
  readonly establishContext?: boolean;
}

function authorization(tenant: TenantContextService, options: AuthorizationOptions = {}) {
  const scoped = options.authorizedWorkspaceId ?? workspaceId;
  const authorizeUser =
    options.denied === true
      ? vi.fn().mockRejectedValue(new Error("denied"))
      : vi.fn().mockResolvedValue({ workspaceId: scoped, userId });
  const entry = {
    authorizeUser,
    run: <T>(_operation: unknown, work: () => T): T =>
      options.establishContext === false
        ? work()
        : tenant.run(createTenantContext({ workspaceId: scoped, userId }), work),
  } as unknown as AuthorizationEntryService;
  return { entry, authorizeUser };
}

function build(
  databaseOptions: QuotaDatabaseOptions = {},
  authorizationOptions: AuthorizationOptions = {},
) {
  const tenant = new TenantContextService();
  const fake = fakeQuotaDatabase(databaseOptions, tenant);
  const auth = authorization(tenant, authorizationOptions);
  const service = new StorageQuotaService(
    fake.database,
    auth.entry,
    tenant,
    security,
    storageConfig,
  );
  return { service, tenant, ...fake, authorizeUser: auth.authorizeUser };
}

/** `reserve` is documented as "call me inside YOUR transaction and YOUR scope". */
function reserveInScope(context: ReturnType<typeof build>, additionalBytes: number): Promise<void> {
  return context.tenant.run(createTenantContext({ workspaceId, userId }), () =>
    context.service.reserve(context.tx, additionalBytes),
  );
}

describe("StorageQuotaService.reserve", () => {
  it("throws 413 PAYLOAD_TOO_LARGE when the addition would exceed the limit", async () => {
    const context = build({
      overrideBytes: 1_000,
      aggregateByWorkspace: { [workspaceId]: { readyBytes: 900, reservedBytes: 0, readyCount: 1 } },
    });
    const error: unknown = await reserveInScope(context, 101).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiHttpException);
    expect((error as ApiHttpException).getStatus()).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect((error as ApiHttpException).safeResponse.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("ALLOWS the boundary where charged + additional exactly equals the limit", async () => {
    const context = build({
      overrideBytes: 1_000,
      aggregateByWorkspace: {
        [workspaceId]: { readyBytes: 600, reservedBytes: 300, readyCount: 2 },
      },
    });
    await expect(reserveInScope(context, 100)).resolves.toBeUndefined();
  });

  it("counts in-flight pending/processing bytes against the limit", async () => {
    // Nothing is `ready`, yet the workspace is full: the in-flight rows ARE the
    // reservation, which is what makes a crash unable to lose it.
    const context = build({
      overrideBytes: 1_000,
      aggregateByWorkspace: {
        [workspaceId]: { readyBytes: 0, reservedBytes: 1_000, readyCount: 0 },
      },
    });
    await expect(reserveInScope(context, 1)).rejects.toMatchObject({
      safeResponse: { code: "PAYLOAD_TOO_LARGE" },
    });
  });

  it("takes SELECT ... FOR UPDATE on the workspace row before reading the aggregate", async () => {
    const context = build({ overrideBytes: 10_000 });
    await reserveInScope(context, 1);
    expect(context.calls).toEqual(["select:workspaces", "for:update", "select:attachments"]);
  });

  it("resolves the plan default when the workspace carries no override", async () => {
    const context = build({
      plan: "free",
      overrideBytes: null,
      aggregateByWorkspace: {
        [workspaceId]: {
          readyBytes: storageConfig.planDefaultBytes.free,
          reservedBytes: 0,
          readyCount: 1,
        },
      },
    });
    await expect(reserveInScope(context, 1)).rejects.toMatchObject({
      safeResponse: { code: "PAYLOAD_TOO_LARGE" },
    });
  });

  it("clamps a generous override to the deployment ceiling", async () => {
    const context = build({
      overrideBytes: Number.MAX_SAFE_INTEGER,
      aggregateByWorkspace: {
        [workspaceId]: {
          readyBytes: security.maximumWorkspaceStorageBytes,
          reservedBytes: 0,
          readyCount: 1,
        },
      },
    });
    await expect(reserveInScope(context, 1)).rejects.toMatchObject({
      safeResponse: { code: "PAYLOAD_TOO_LARGE" },
    });
  });

  it("returns the shared not-found shape for a missing workspace row", async () => {
    const context = build({ workspaceMissing: true });
    await expect(reserveInScope(context, 1)).rejects.toMatchObject({
      safeResponse: { code: "NOT_FOUND" },
    });
  });
});

describe("StorageQuotaService.readUsage", () => {
  function usageInput(target = workspaceId) {
    return { principal: principal(), workspaceId: target, requestId: null };
  }

  it("takes NO row lock and opens NO transaction", async () => {
    const context = build({
      aggregateByWorkspace: {
        [workspaceId]: { readyBytes: 10, reservedBytes: 5, readyCount: 1 },
      },
    });
    await context.service.readUsage(usageInput());

    // The whole point of the read path: a usage refresh must never be able to
    // block an upload.
    expect(context.calls).toEqual(["select:workspaces", "select:attachments"]);
    expect(context.calls.some((call) => call.startsWith("for:"))).toBe(false);
    expect(context.transaction).not.toHaveBeenCalled();
  });

  it("authorizes settings.read against the settings resource", async () => {
    const context = build();
    await context.service.readUsage({ ...usageInput(), requestId: "request-1" });
    expect(context.authorizeUser).toHaveBeenCalledWith({
      principal: expect.objectContaining({ userId }),
      workspaceId,
      action: "settings.read",
      resource: { kind: "settings" },
      requestId: "request-1",
    });
  });

  it("projects usage, the effective limit, and the source of that limit", async () => {
    const withOverride = build({
      plan: "pro",
      overrideBytes: 2_000,
      aggregateByWorkspace: {
        [workspaceId]: { readyBytes: 800, reservedBytes: 200, readyCount: 4 },
      },
    });
    await expect(withOverride.service.readUsage(usageInput())).resolves.toEqual({
      workspaceId,
      plan: "pro",
      usedBytes: 800,
      pendingBytes: 200,
      limitBytes: 2_000,
      availableBytes: 1_000,
      attachmentCount: 4,
      limitSource: "override",
    });

    const withPlanDefault = build({ plan: "free", overrideBytes: null });
    const usage = await withPlanDefault.service.readUsage(usageInput());
    expect(usage.limitSource).toBe("plan");
    expect(usage.limitBytes).toBe(storageConfig.planDefaultBytes.free);
  });

  it("reports the AUTHORIZED workspace, never the id the caller asked for", async () => {
    // The entry service authorized (and scoped) `workspaceId`. A caller naming
    // another workspace cannot make the service read that workspace's totals:
    // every query is built from the ACTIVE context, not from the argument.
    const context = build(
      {
        aggregateByWorkspace: {
          [workspaceId]: { readyBytes: 1, reservedBytes: 0, readyCount: 1 },
          [otherWorkspaceId]: { readyBytes: 999_999, reservedBytes: 111, readyCount: 42 },
        },
      },
      { authorizedWorkspaceId: workspaceId },
    );

    const usage = await context.service.readUsage(usageInput(otherWorkspaceId));
    expect(usage.workspaceId).toBe(workspaceId);
    expect(usage.usedBytes).toBe(1);
    expect(usage.pendingBytes).toBe(0);
    expect(usage.attachmentCount).toBe(1);
    // The claim the caller made is still handed to the policy, which is what
    // makes the denial in the next test possible.
    expect(context.authorizeUser).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: otherWorkspaceId }),
    );
  });

  it("rejects an unauthorized principal at the entry service, before any SQL", async () => {
    const context = build({}, { denied: true });
    await expect(context.service.readUsage(usageInput())).rejects.toThrow("denied");
    expect(context.calls).toEqual([]);
    expect(context.transaction).not.toHaveBeenCalled();
  });

  it("fails closed when no tenant scope was established", async () => {
    // A mis-wired entry service that authorizes but establishes no context must
    // not produce an unscoped aggregate. `whereWorkspace` throws instead.
    const context = build({}, { establishContext: false });
    await expect(context.service.readUsage(usageInput())).rejects.toThrow();
    expect(context.calls).not.toContain("select:attachments");
  });

  it("returns the shared not-found shape for a missing workspace row", async () => {
    const context = build({ workspaceMissing: true });
    await expect(context.service.readUsage(usageInput())).rejects.toMatchObject({
      safeResponse: { code: "NOT_FOUND" },
    });
  });

  it("returns a frozen projection with no object keys or filenames on it", async () => {
    const context = build();
    const usage = await context.service.readUsage(usageInput());
    expect(Object.isFrozen(usage)).toBe(true);
    expect(JSON.stringify(usage)).not.toContain("/original/");
    expect(JSON.stringify(usage)).not.toContain('"key"');
  });
});

describe("StorageQuotaService.effectiveLimit", () => {
  it("applies the plan default, the override, and the deployment ceiling in that order", () => {
    const { service } = build();
    expect(service.effectiveLimit({ plan: "free", overrideBytes: null })).toBe(
      storageConfig.planDefaultBytes.free,
    );
    // Enterprise's 100 GiB default clamps to the 10 GiB deployment ceiling.
    expect(service.effectiveLimit({ plan: "enterprise", overrideBytes: null })).toBe(
      security.maximumWorkspaceStorageBytes,
    );
    expect(service.effectiveLimit({ plan: "free", overrideBytes: 4 * GIB })).toBe(4 * GIB);
    expect(service.effectiveLimit({ plan: "free", overrideBytes: 100 * GIB })).toBe(
      security.maximumWorkspaceStorageBytes,
    );
  });
});
