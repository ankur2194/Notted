import { describe, expect, it, vi } from "vitest";

import { parseAppConfig } from "../config/app.config";
import { auditLogs, workspaceDomains, workspaces } from "../database/schema";
import { createTenantContext, TenantContextService } from "../tenant";

import { DOMAIN_AUDIT_ACTIONS } from "./domains.constants";
import { DomainsService } from "./domains.service";

import type { DomainDnsResolver } from "./domain-verifier";
import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { ApiHttpException } from "../common/errors/api-http.exception";
import type { VerifiedHostsService } from "../common/verified-hosts.service";
import type { DatabaseService } from "../database/database.service";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

const userId = "30000000-0000-4000-8000-000000000001";
const workspaceId = "30000000-0000-4000-8100-000000000001";
const domainId = "30000000-0000-4000-8200-000000000001";
const TOKEN = "0123456789abcdef0123456789abcdef";
const HOST = "notes.acme.com";
const TARGET = "edge.notted.test";

type DomainRow = typeof workspaceDomains.$inferSelect;

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

function claim(overrides: Partial<DomainRow> = {}): DomainRow {
  const now = new Date("2026-08-25T10:00:00Z");
  return {
    id: domainId,
    workspaceId,
    hostname: HOST,
    status: "pending",
    verificationToken: TOKEN,
    lastError: null,
    lastCheckedAt: null,
    verifiedAt: null,
    createdById: userId,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as DomainRow;
}

async function rejection(work: Promise<unknown>): Promise<ApiHttpException> {
  try {
    await work;
  } catch (error: unknown) {
    return error as ApiHttpException;
  }
  throw new Error("expected the call to reject");
}

interface Recorded {
  readonly kind: "insert" | "update" | "delete";
  readonly table: unknown;
  readonly value?: Record<string, unknown>;
}

/**
 * Stubs the four Drizzle shapes this service uses. `state.row` is the committed
 * claim; the insert/delete mutate it so a later read inside the same test sees
 * what the table would.
 */
function fakeDatabase(state: { row: DomainRow | null }, log: Recorded[], onInsert?: () => void) {
  const builder = {
    select: () => ({
      from: (table: unknown) => {
        const chain = {
          innerJoin: () => chain,
          where: () => chain,
          limit: () =>
            Promise.resolve(
              table === workspaceDomains && state.row !== null ? [{ ...state.row }] : [],
            ),
        };
        return chain;
      },
    }),
    insert: (table: unknown) => ({
      values: (value: Record<string, unknown>) => {
        log.push({ kind: "insert", table, value });
        if (table === workspaceDomains) {
          onInsert?.();
          state.row = claim({ ...(value as Partial<DomainRow>) });
        }
        return {
          returning: () => Promise.resolve(state.row === null ? [] : [{ ...state.row }]),
          then: (resolve: (value: unknown) => unknown) => resolve(undefined),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (value: Record<string, unknown>) => ({
        where: () => {
          log.push({ kind: "update", table, value });
          if (table === workspaceDomains && state.row !== null) {
            state.row = { ...state.row, ...(value as Partial<DomainRow>) };
          }
          return {
            returning: () => Promise.resolve(state.row === null ? [] : [{ ...state.row }]),
            then: (resolve: (result: unknown) => unknown) => resolve(undefined),
          };
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: () => {
        log.push({ kind: "delete", table });
        if (table === workspaceDomains) state.row = null;
        return Promise.resolve();
      },
    }),
  };
  const database = {
    db: builder,
    transaction: <T>(work: (tx: typeof builder) => Promise<T>): Promise<T> => work(builder),
  } as unknown as DatabaseService;
  return database;
}

function resolver(overrides: Partial<DomainDnsResolver> = {}): DomainDnsResolver {
  return {
    resolveTxt: vi.fn(async () => [[`notted-verify=${TOKEN}`]]),
    resolveCname: vi.fn(async () => [TARGET]),
    lookup: vi.fn(async () => [{ address: "203.0.113.10" }]),
    ...overrides,
  };
}

function build(
  options: {
    readonly row?: DomainRow | null;
    readonly enabled?: boolean;
    readonly staticHosts?: readonly string[];
    readonly dns?: DomainDnsResolver;
    readonly onInsert?: () => void;
  } = {},
) {
  const tenant = new TenantContextService();
  const log: Recorded[] = [];
  const state = { row: options.row ?? null };
  const database = fakeDatabase(state, log, options.onInsert);
  const invalidate = vi.fn();
  const verifiedHosts = {
    staticHosts: new Set(options.staticHosts ?? ["app.notted.test", TARGET]),
    invalidate,
  } as unknown as VerifiedHostsService;
  const authorizeUser = vi.fn().mockResolvedValue({ workspaceId, userId });
  const entry = {
    authorizeUser,
    run: <T>(_operation: unknown, work: () => T): T =>
      tenant.run(createTenantContext({ workspaceId, userId }), work),
  } as unknown as AuthorizationEntryService;

  const service = new DomainsService(
    database,
    entry,
    tenant,
    verifiedHosts,
    parseAppConfig({
      APP_URL: "http://app.notted.test",
      CUSTOM_DOMAIN_CNAME_TARGET: TARGET,
      ...(options.enabled === false ? {} : { CUSTOM_DOMAINS_ENABLED: "true" }),
    }),
    options.dns ?? resolver(),
  );
  return { service, log, state, invalidate, authorizeUser };
}

function audits(log: Recorded[]) {
  return log.filter((entry) => entry.table === auditLogs).map((entry) => entry.value ?? {});
}

const scope = () => ({ principal: principal(), workspaceId, requestId: "req-1" });

describe("DomainsService feature flag", () => {
  // A 403 would say "you are not allowed", which invites finding someone who is.
  // The capability simply does not exist on a deployment with the flag off.
  it("answers 404 on every operation when custom domains are disabled", async () => {
    const { service, authorizeUser } = build({ enabled: false });
    for (const work of [
      service.read(scope()),
      service.set({ ...scope(), hostname: HOST }),
      service.verify(scope()),
      service.remove(scope()),
      service.resolve(HOST),
    ]) {
      expect((await rejection(work)).getStatus()).toBe(404);
    }
    // The refusal happens BEFORE authorization, so a disabled deployment never
    // even reveals whether the caller could have done it.
    expect(authorizeUser).not.toHaveBeenCalled();
  });
});

describe("DomainsService.read", () => {
  it("returns null when no hostname is claimed", async () => {
    const { service } = build();
    await expect(service.read(scope())).resolves.toEqual({ domain: null });
  });

  it("renders both DNS records the administrator must publish", async () => {
    const { service } = build({ row: claim() });
    const result = await service.read(scope());
    expect(result.domain).toMatchObject({
      hostname: HOST,
      status: "pending",
      verificationRecord: {
        name: `_notted-verify.${HOST}`,
        type: "TXT",
        value: `notted-verify=${TOKEN}`,
      },
      cnameRecord: { name: HOST, type: "CNAME", value: TARGET },
    });
  });
});

describe("DomainsService.set", () => {
  it("claims a hostname as pending and audits identifiers only", async () => {
    const { service, log } = build();
    const result = await service.set({ ...scope(), hostname: HOST });
    expect(result.domain).toMatchObject({ hostname: HOST, status: "pending" });

    const [audit] = audits(log);
    expect(audit).toMatchObject({
      action: DOMAIN_AUDIT_ACTIONS.set,
      workspaceId,
      userId,
      metadata: { hostname: HOST, status: "pending" },
    });
    // The token is a DNS value, not an audit fact, and `audit_logs` is
    // CSV-exportable to every workspace admin.
    expect(JSON.stringify(audit)).not.toContain(TOKEN);
  });

  // A claim is not a proof: the mirror column routing consults must never carry
  // a hostname nobody has proved they own.
  it("clears the workspaces.domain mirror when the claim changes", async () => {
    const { service, log } = build({
      row: claim({ hostname: "old.acme.com", status: "verified" }),
    });
    await service.set({ ...scope(), hostname: HOST });
    const mirror = log.filter((entry) => entry.table === workspaces);
    expect(mirror).toHaveLength(1);
    expect(mirror[0]?.value).toMatchObject({ domain: null });
  });

  it("is idempotent for the same hostname and does not mint a new token", async () => {
    const onInsert = vi.fn();
    const { service, log } = build({ row: claim(), onInsert });
    const result = await service.set({ ...scope(), hostname: HOST });
    expect(result.domain?.verificationRecord.value).toBe(`notted-verify=${TOKEN}`);
    expect(onInsert).not.toHaveBeenCalled();
    // No row change means no audit event either: nothing happened.
    expect(audits(log)).toHaveLength(0);
  });

  it("refuses a hostname this deployment already answers on", async () => {
    const { service } = build();
    const error = await rejection(service.set({ ...scope(), hostname: "app.notted.test" }));
    expect(error.getStatus()).toBe(422);
    expect(error.safeResponse.code).toBe("DOMAIN_RESERVED");
  });

  it("maps a unique violation on either constraint to one indistinguishable 409", async () => {
    for (const constraint of [
      "workspace_domains_hostname_unique",
      "workspace_domains_workspace_id_unique",
    ]) {
      const { service } = build({
        onInsert: () => {
          throw Object.assign(new Error("duplicate key"), { code: "23505", constraint });
        },
      });
      const error = await rejection(service.set({ ...scope(), hostname: HOST }));
      expect(error.getStatus()).toBe(409);
      expect(error.safeResponse.code).toBe("DOMAIN_TAKEN");
      // Naming the holder would leak that a foreign tenant claimed the name.
      expect(error.safeResponse.message).toBe("That domain is already claimed.");
    }
  });
});

describe("DomainsService.verify", () => {
  it("records a success, mirrors the hostname, and invalidates the host cache", async () => {
    const { service, log, invalidate } = build({ row: claim() });
    const result = await service.verify(scope());
    expect(result.domain).toMatchObject({ status: "verified", lastError: null });
    expect(result.domain?.verifiedAt).not.toBeNull();

    const mirror = log.filter((entry) => entry.table === workspaces);
    expect(mirror[0]?.value).toMatchObject({ domain: HOST });
    expect(audits(log)[0]).toMatchObject({
      action: DOMAIN_AUDIT_ACTIONS.verify,
      metadata: { hostname: HOST, status: "verified", lastError: null },
    });
    expect(invalidate).toHaveBeenCalledWith(HOST);
  });

  // The mirror follows the verdict in BOTH directions: a re-verification that
  // now fails must stop the host routing.
  it("clears the mirror and records the reason when verification fails", async () => {
    const { service, log, invalidate } = build({
      row: claim({ status: "verified", verifiedAt: new Date() }),
      dns: resolver({ resolveTxt: vi.fn(async () => [["notted-verify=someone-else"]]) }),
    });
    const result = await service.verify(scope());
    expect(result.domain).toMatchObject({
      status: "error",
      lastError: "txt_mismatch",
      verifiedAt: null,
    });
    expect(log.filter((entry) => entry.table === workspaces)[0]?.value).toMatchObject({
      domain: null,
    });
    expect(invalidate).toHaveBeenCalledWith(HOST);
  });

  it("404s when there is no claim to verify", async () => {
    const { service } = build();
    expect((await rejection(service.verify(scope()))).getStatus()).toBe(404);
  });
});

describe("DomainsService.remove", () => {
  it("deletes the claim, clears the mirror, audits, and invalidates", async () => {
    const { service, log, state, invalidate } = build({
      row: claim({ status: "verified" }),
    });
    await expect(service.remove(scope())).resolves.toEqual({ domain: null });
    expect(state.row).toBeNull();
    expect(log.some((entry) => entry.kind === "delete" && entry.table === workspaceDomains)).toBe(
      true,
    );
    expect(log.filter((entry) => entry.table === workspaces)[0]?.value).toMatchObject({
      domain: null,
    });
    expect(audits(log)[0]).toMatchObject({
      action: DOMAIN_AUDIT_ACTIONS.remove,
      metadata: { hostname: HOST },
    });
    expect(invalidate).toHaveBeenCalledWith(HOST);
  });

  it("is idempotent when nothing is claimed", async () => {
    const { service, log } = build();
    await expect(service.remove(scope())).resolves.toEqual({ domain: null });
    expect(audits(log)).toHaveLength(0);
  });
});
