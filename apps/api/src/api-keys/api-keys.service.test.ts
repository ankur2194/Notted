import { createApiKeySchema } from "@notted/shared-validators";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { ApiHttpException } from "../common/errors/api-http.exception";
import { hashApiPayload } from "../common/idempotency/api-idempotency";
import { apiIdempotencyRecords, apiKeys, auditLogs } from "../database/schema";
import { createTenantContext, TenantContextService } from "../tenant";

import { hashApiKey } from "./api-key-secret";
import { API_KEY_AUDIT_ACTIONS, API_KEY_AUDIT_ENTITY_TYPE } from "./api-keys.constants";
import { ApiKeysService } from "./api-keys.service";

import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { AuthConfig } from "../config/auth.config";
import type { DatabaseService } from "../database/database.service";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

const USER_ID = "70000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "70000000-0000-4000-8100-000000000001";
const API_KEY_ID = "70000000-0000-4000-8200-000000000001";
const IDEMPOTENCY_KEY = "api-key-create-000001";
const PEPPER = "auth-secret-000000000000000000000";

const principal: AuthenticatedPrincipal = Object.freeze({
  userId: USER_ID,
  sessionId: "session",
  method: "opaque-session",
  assurance: "single-factor",
  authenticatedAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-08-02T00:00:00.000Z",
  isFresh: true,
});

const createdAt = new Date("2026-08-01T00:00:00.000Z");

const storedRow = Object.freeze({
  id: API_KEY_ID,
  workspaceId: WORKSPACE_ID,
  name: "CI export runner",
  keyPrefix: "ntd_pk_a",
  scopes: "read,write",
  lastUsedAt: null,
  expiresAt: null,
  isRevoked: false,
  createdById: USER_ID,
  createdAt,
});

const createInput = Object.freeze({
  principal,
  workspaceId: WORKSPACE_ID,
  name: "CI export runner",
  scopes: ["read", "write"] as const,
  idempotencyKey: IDEMPOTENCY_KEY,
});

const listInput = Object.freeze({
  principal,
  workspaceId: WORKSPACE_ID,
  page: 1,
  limit: 25,
  sortBy: "createdAt" as const,
  sortDirection: "desc" as const,
});

async function apiRejection(promise: Promise<unknown>): Promise<ApiHttpException> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ApiHttpException) return error;
    throw error;
  }
  throw new Error("expected the call to reject");
}

/** A database whose every access fails, proving authorization ran before SQL. */
function forbiddenDatabase(): DatabaseService {
  return {
    db: new Proxy(
      {},
      {
        get: () => {
          throw new Error("SQL must not run");
        },
      },
    ),
    transaction: () => {
      throw new Error("SQL must not run");
    },
  } as unknown as DatabaseService;
}

function mockEntry(tenant: TenantContextService): {
  readonly entry: AuthorizationEntryService;
  readonly authorizeUser: ReturnType<typeof vi.fn>;
} {
  const authorizeUser = vi.fn().mockResolvedValue({ workspaceId: WORKSPACE_ID, userId: USER_ID });
  const entry = {
    authorizeUser,
    run: <T>(operation: { workspaceId: string; userId: string | null }, work: () => T): T =>
      tenant.run(
        createTenantContext({ workspaceId: operation.workspaceId, userId: operation.userId }),
        work,
      ),
  } as unknown as AuthorizationEntryService;
  return { entry, authorizeUser };
}

interface Awaitable<T> extends Promise<T> {
  limit: (count: number) => Awaitable<T>;
  orderBy: (...columns: readonly unknown[]) => Awaitable<T>;
  offset: (count: number) => Awaitable<T>;
}

function rows<T>(value: readonly T[]): Awaitable<T[]> {
  const promise = Promise.resolve([...value]) as Awaitable<T[]>;
  promise.limit = () => promise;
  promise.orderBy = () => promise;
  promise.offset = () => promise;
  return promise;
}

interface Statement {
  readonly table: unknown;
  readonly fields?: Record<string, unknown>;
  readonly predicate: unknown;
}

const dialect = new PgDialect();

/**
 * True when a captured predicate really constrains `table` to the active
 * workspace. The fake database enforces nothing, so without rendering the real
 * SQL this suite would stay green if `whereWorkspace(...)` were deleted and a
 * foreign tenant's key became readable and revocable.
 */
function scopesToWorkspace(predicate: unknown, table: { readonly workspaceId: unknown }): boolean {
  if (predicate === undefined || predicate === null) return false;
  const column = dialect.sqlToQuery(sql`${table.workspaceId}`).sql;
  const rendered = dialect.sqlToQuery(predicate as SQL);
  return rendered.sql.includes(`${column} =`) && rendered.params.includes(WORKSPACE_ID);
}

function renderedSql(predicate: unknown): string {
  return dialect.sqlToQuery(predicate as SQL).sql;
}

interface HarnessOptions {
  readonly replay?: readonly { readonly resourceId: string; readonly payloadHash: string }[];
  readonly apiKeyRows?: readonly (typeof storedRow)[];
  readonly revoked?: readonly {
    readonly id: string;
    readonly keyPrefix: string;
    readonly scopes: string;
  }[];
}

function serviceWith(options: HarnessOptions = {}) {
  const tenant = new TenantContextService();
  const { entry, authorizeUser } = mockEntry(tenant);
  const inserted: { readonly table: unknown; readonly values: unknown }[] = [];
  const reads: Statement[] = [];
  const updates: Statement[] = [];
  const scope = {
    execute: () => Promise.resolve(),
    select: (fields: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (predicate: unknown) => {
          reads.push({ table, fields, predicate });
          if (table === apiIdempotencyRecords) return rows(options.replay ?? []);
          return rows(options.apiKeyRows ?? [storedRow]);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        inserted.push({ table, values });
        return Promise.resolve();
      },
    }),
    update: (table: unknown) => ({
      set: () => ({
        where: (predicate: unknown) => {
          updates.push({ table, predicate });
          return {
            returning: () =>
              Promise.resolve([
                ...(options.revoked ?? [
                  { id: API_KEY_ID, keyPrefix: storedRow.keyPrefix, scopes: storedRow.scopes },
                ]),
              ]),
          };
        },
      }),
    }),
  };
  const database = {
    db: scope,
    transaction: (work: (value: typeof scope) => Promise<unknown>) => work(scope),
  } as unknown as DatabaseService;
  return {
    database,
    inserted,
    reads,
    updates,
    tenant,
    authorizeUser,
    service: new ApiKeysService(database, entry, tenant, { secret: PEPPER } as AuthConfig),
  };
}

describe("ApiKeysService authorization", () => {
  const cases: readonly [
    string,
    (service: ApiKeysService) => Promise<unknown>,
    string,
    Record<string, string>,
  ][] = [
    ["list", (service) => service.list(listInput), "apiKey.list", { kind: "workspace" }],
    ["create", (service) => service.create(createInput), "apiKey.create", { kind: "workspace" }],
    [
      "revoke",
      (service) => service.revoke({ principal, workspaceId: WORKSPACE_ID, apiKeyId: API_KEY_ID }),
      "apiKey.revoke",
      { kind: "apiKey", id: API_KEY_ID },
    ],
  ];

  it.each(cases)("authorizes %s before any SQL", async (_name, invoke, action, resource) => {
    const denial = new Error("concealed");
    const authorizeUser = vi.fn().mockRejectedValue(denial);
    const service = new ApiKeysService(
      forbiddenDatabase(),
      { authorizeUser } as unknown as AuthorizationEntryService,
      {} as TenantContextService,
      { secret: PEPPER } as AuthConfig,
    );
    await expect(invoke(service)).rejects.toBe(denial);
    expect(authorizeUser).toHaveBeenCalledWith(
      expect.objectContaining({ action, workspaceId: WORKSPACE_ID, resource }),
    );
  });
});

describe("ApiKeysService.list", () => {
  it("never selects the key hash", async () => {
    const { service, reads } = serviceWith();
    await service.list(listInput);
    const [read] = reads;
    expect(read?.table).toBe(apiKeys);
    const selected = Object.values(read?.fields ?? {});
    expect(selected).not.toContain(apiKeys.keyHash);
    expect(Object.keys(read?.fields ?? {})).not.toContain("keyHash");
  });

  it("scopes the listing to the active workspace and hides revoked keys by default", async () => {
    const { service, reads } = serviceWith();
    await service.list(listInput);
    const [read] = reads;
    expect(scopesToWorkspace(read?.predicate, apiKeys)).toBe(true);
    expect(renderedSql(read?.predicate)).toContain("is_revoked");
  });

  it("includes revoked keys only when explicitly asked", async () => {
    const { service, reads } = serviceWith();
    await service.list({ ...listInput, includeRevoked: true });
    expect(renderedSql(reads[0]?.predicate)).not.toContain("is_revoked");
  });

  it("reports hasMore from the limit + 1 probe row", async () => {
    // `storedRow` infers a literal `id`, so a generated one has to be widened
    // back to it. The literal is an inference artefact of the fixture, not a
    // constraint the service places on the column.
    const many = Array.from({ length: 3 }, (_value, index) => ({
      ...storedRow,
      id: `${API_KEY_ID.slice(0, -1)}${index}` as (typeof storedRow)["id"],
    }));
    const { service } = serviceWith({ apiKeyRows: many });
    const page = await service.list({ ...listInput, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });
});

describe("ApiKeysService.create", () => {
  it("round-trips the scope set through the stored CSV and back into the summary", async () => {
    const { service, inserted } = serviceWith();
    const result = await service.create({ ...createInput, scopes: ["read", "write"] });
    const row = inserted.find((entry) => entry.table === apiKeys)?.values as Record<
      string,
      unknown
    >;
    expect(row.scopes).toBe("read,write");
    expect(result.apiKey.scopes).toEqual(["read", "write"]);
  });

  it("returns the raw secret once and stores only its peppered hash and prefix", async () => {
    const { service, inserted } = serviceWith();
    const result = await service.create(createInput);
    const row = inserted.find((entry) => entry.table === apiKeys)?.values as Record<
      string,
      unknown
    >;
    expect(result.secret).toMatch(/^ntd_pk_[A-Za-z0-9_-]{32}$/u);
    expect(row.keyHash).toBe(hashApiKey(result.secret, PEPPER));
    expect(row.keyHash).not.toBe(result.secret);
    expect(row.keyPrefix).toBe(result.secret.slice(0, 8));
    expect(row.createdById).toBe(USER_ID);
    expect(row.workspaceId).toBe(WORKSPACE_ID);
  });

  it("persists an explicit expiry as a timestamp", async () => {
    const expiresAt = "2027-01-01T00:00:00.000Z";
    const { service, inserted } = serviceWith();
    await service.create({ ...createInput, expiresAt });
    const row = inserted.find((entry) => entry.table === apiKeys)?.values as Record<
      string,
      unknown
    >;
    expect(row.expiresAt).toEqual(new Date(expiresAt));
  });

  it("audits the creation with the prefix and scopes, never the secret or its hash", async () => {
    const { service, inserted } = serviceWith();
    const result = await service.create(createInput);
    const row = inserted.find((entry) => entry.table === apiKeys)?.values as Record<
      string,
      unknown
    >;
    const audit = inserted.find((entry) => entry.table === auditLogs)?.values as Record<
      string,
      unknown
    >;
    expect(audit.action).toBe(API_KEY_AUDIT_ACTIONS.created);
    expect(audit.entityType).toBe(API_KEY_AUDIT_ENTITY_TYPE);
    expect(audit.entityId).toBe(row.id);
    expect(audit.metadata).toEqual({
      keyPrefix: result.secret.slice(0, 8),
      scopes: ["read", "write"],
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(result.secret);
    expect(serialized).not.toContain(hashApiKey(result.secret, PEPPER));
  });

  it("fails an idempotent replay instead of returning a key the caller cannot use", async () => {
    const { service, inserted } = serviceWith({
      replay: [
        {
          resourceId: API_KEY_ID,
          payloadHash: hashApiPayload({
            name: createInput.name,
            scopes: "read,write",
            expiresAt: null,
          }),
        },
      ],
    });
    const error = await apiRejection(service.create(createInput));
    expect(error.getStatus()).toBe(409);
    expect(error.safeResponse.code).toBe("IDEMPOTENT_RESULT_UNAVAILABLE");
    // Nothing was written: the replay is refused, not partially re-applied.
    expect(inserted).toHaveLength(0);
  });

  it("still reports key reuse when the replayed payload differs", async () => {
    const { service } = serviceWith({
      replay: [{ resourceId: API_KEY_ID, payloadHash: "a-different-payload" }],
    });
    const error = await apiRejection(service.create(createInput));
    expect(error.safeResponse.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("leaves a non-future expiry to the request schema, which rejects it", () => {
    const past = createApiKeySchema.safeParse({
      name: "CI export runner",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(past.success).toBe(false);
    const future = createApiKeySchema.safeParse({
      name: "CI export runner",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(future.success).toBe(true);
  });
});

describe("ApiKeysService.revoke", () => {
  const input = Object.freeze({ principal, workspaceId: WORKSPACE_ID, apiKeyId: API_KEY_ID });

  it("revokes with one workspace-scoped conditional update and audits the transition", async () => {
    const { service, updates, inserted } = serviceWith();
    await expect(service.revoke(input)).resolves.toEqual({ apiKeyId: API_KEY_ID, revoked: true });
    const [update] = updates;
    expect(update?.table).toBe(apiKeys);
    expect(scopesToWorkspace(update?.predicate, apiKeys)).toBe(true);
    // The prior state travels in the WHERE, so a concurrent revoke cannot also
    // believe it made the transition.
    expect(renderedSql(update?.predicate)).toContain("is_revoked");
    const audit = inserted.find((entry) => entry.table === auditLogs)?.values as Record<
      string,
      unknown
    >;
    expect(audit.action).toBe(API_KEY_AUDIT_ACTIONS.revoked);
    expect(audit.metadata).toEqual({ keyPrefix: storedRow.keyPrefix, scopes: ["read", "write"] });
  });

  it("is idempotent for a key that is already revoked, and audits nothing", async () => {
    const { service, inserted } = serviceWith({ revoked: [] });
    await expect(service.revoke(input)).resolves.toEqual({ apiKeyId: API_KEY_ID, revoked: true });
    expect(inserted).toHaveLength(0);
  });

  it("answers 404, never 403, for a key that belongs to another workspace", async () => {
    const { service, reads } = serviceWith({ revoked: [], apiKeyRows: [] });
    const error = await apiRejection(service.revoke(input));
    expect(error.getStatus()).toBe(404);
    expect(error.safeResponse.code).toBe("NOT_FOUND");
    expect(error.safeResponse.message).toBe("The requested resource was not found.");
    // The existence probe itself was workspace-scoped, so it cannot confirm a
    // foreign row exists.
    expect(scopesToWorkspace(reads.at(-1)?.predicate, apiKeys)).toBe(true);
  });
});
