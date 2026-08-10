import { eq, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { ApiHttpException } from "../common/errors/api-http.exception";
import { hashApiPayload } from "../common/idempotency/api-idempotency";
import { apiIdempotencyRecords, auditLogs, jobOutbox, tags } from "../database/schema";
import { assertWorkspaceInsertValues, createTenantContext, TenantContextService } from "../tenant";

import { TAG_MAX_PER_WORKSPACE } from "./tags.constants";
import { TagsService } from "./tags.service";

import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { DatabaseService } from "../database/database.service";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

const USER_ID = "30000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "30000000-0000-4000-8100-000000000001";
const OTHER_WORKSPACE_ID = "30000000-0000-4000-8100-000000000002";
const TAG_ID = "30000000-0000-4000-8200-000000000001";
const IDEMPOTENCY_KEY = "tag-create-00000000001";

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

/** `color` is null on purpose: the column is nullable and must be coalesced. */
const storedRow = Object.freeze({
  id: TAG_ID,
  workspaceId: WORKSPACE_ID,
  name: "Roadmap",
  color: null,
  createdAt,
  noteCount: 3,
  taskCount: 4,
});

const createInput = Object.freeze({
  principal,
  workspaceId: WORKSPACE_ID,
  name: "Roadmap",
  color: "#6b7280",
  idempotencyKey: IDEMPOTENCY_KEY,
});

const duplicateName = Object.assign(new Error("Drizzle query failed"), {
  cause: Object.assign(new Error("duplicate key"), {
    code: "23505",
    constraint: "tags_workspace_name_unique",
  }),
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

/** Entry service whose run() establishes the real ALS tenant context. */
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

/**
 * `where()` is awaited directly on some paths, `.limit()`-ed on others, and the
 * listing adds `.orderBy().limit().offset()`. Every builder step returns the
 * same thenable so any suffix of the chain resolves to the same rows.
 */
function rows<T>(value: readonly T[]): Awaitable<T[]> {
  const promise = Promise.resolve([...value]) as Awaitable<T[]>;
  promise.limit = () => promise;
  promise.orderBy = () => promise;
  promise.offset = () => promise;
  return promise;
}

interface TransactionOptions {
  readonly replay?: readonly { readonly resourceId: string; readonly payloadHash: string }[];
  readonly tagCount?: number;
  readonly insertError?: unknown;
  readonly updateError?: unknown;
  readonly updated?: readonly { readonly id: string }[];
}

/** One captured statement: the table it addressed and the predicate it carried. */
interface Statement {
  readonly table: unknown;
  readonly predicate: unknown;
}

const dialect = new PgDialect();

/**
 * True when a captured predicate really constrains `table` to the active
 * workspace.
 *
 * The fake database cannot enforce anything, so without this the suite would
 * stay green if `whereWorkspace(...)` were deleted from `readRow`, the capacity
 * count, the update, or the delete — and a foreign tenant's `tagId` would become
 * readable, renamable, and deletable with no failing test. Rendering the real
 * SQL is the only way to assert the predicate rather than its presence.
 */
function scopesToWorkspace(predicate: unknown, table: { readonly workspaceId: unknown }): boolean {
  if (predicate === undefined || predicate === null) return false;
  const column = dialect.sqlToQuery(sql`${table.workspaceId}`).sql;
  const rendered = dialect.sqlToQuery(predicate as SQL);
  return rendered.sql.includes(`${column} =`) && rendered.params.includes(WORKSPACE_ID);
}

function serviceWith(options: TransactionOptions = {}) {
  const tenant = new TenantContextService();
  const { entry, authorizeUser } = mockEntry(tenant);
  const inserted: { readonly table: unknown; readonly values: unknown }[] = [];
  const reads: Statement[] = [];
  const updated: Statement[] = [];
  const deleted: Statement[] = [];
  const isolationLevels: (string | undefined)[] = [];
  const scope = {
    execute: () => Promise.resolve(),
    select: (fields: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (predicate: unknown) => {
          reads.push({ table, predicate });
          if (table === apiIdempotencyRecords) return rows(options.replay ?? []);
          if ("count" in fields) return rows([{ count: options.tagCount ?? 0 }]);
          return rows([storedRow]);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        if (table === tags && options.insertError !== undefined) {
          return Promise.reject(options.insertError);
        }
        inserted.push({ table, values });
        return Promise.resolve();
      },
    }),
    update: (table: unknown) => ({
      set: () => ({
        where: (predicate: unknown) => {
          updated.push({ table, predicate });
          return {
            returning: () =>
              options.updateError === undefined
                ? Promise.resolve([...(options.updated ?? [{ id: TAG_ID }])])
                : Promise.reject(options.updateError),
          };
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (predicate: unknown) => {
        deleted.push({ table, predicate });
        return Promise.resolve();
      },
    }),
  };
  const database = {
    // `list` reads outside a transaction, so it needs the same fake builder.
    db: scope,
    transaction: (
      work: (value: typeof scope) => Promise<unknown>,
      config?: { readonly isolationLevel?: string },
    ) => {
      isolationLevels.push(config?.isolationLevel);
      return work(scope);
    },
  } as unknown as DatabaseService;
  return {
    database,
    inserted,
    reads,
    updated,
    deleted,
    isolationLevels,
    tenant,
    authorizeUser,
    service: new TagsService(database, entry, tenant),
  };
}

describe("TagsService authorization", () => {
  const cases: readonly [
    string,
    (service: TagsService) => Promise<unknown>,
    string,
    Record<string, string>,
  ][] = [
    [
      "list",
      (service) =>
        service.list({
          principal,
          workspaceId: WORKSPACE_ID,
          page: 1,
          limit: 25,
          sortBy: "name",
          sortDirection: "asc",
        }),
      "tag.read",
      { kind: "workspace" },
    ],
    ["create", (service) => service.create(createInput), "tag.create", { kind: "workspace" }],
    [
      "update",
      (service) =>
        service.update({ principal, workspaceId: WORKSPACE_ID, tagId: TAG_ID, name: "Roadmap" }),
      "tag.update",
      { kind: "tag", id: TAG_ID },
    ],
    [
      "remove",
      (service) => service.remove({ principal, workspaceId: WORKSPACE_ID, tagId: TAG_ID }),
      "tag.delete",
      { kind: "tag", id: TAG_ID },
    ],
  ];

  it.each(cases)("authorizes %s before any SQL", async (_name, invoke, action, resource) => {
    const denial = new Error("concealed");
    const authorizeUser = vi.fn().mockRejectedValue(denial);
    const service = new TagsService(
      forbiddenDatabase(),
      { authorizeUser } as unknown as AuthorizationEntryService,
      {} as TenantContextService,
    );
    await expect(invoke(service)).rejects.toBe(denial);
    expect(authorizeUser).toHaveBeenCalledWith(
      expect.objectContaining({ action, workspaceId: WORKSPACE_ID, resource }),
    );
  });
});

describe("TagsService duplicate names", () => {
  it("maps a create unique violation to 409 TAG_NAME_TAKEN, never a 500", async () => {
    const { service } = serviceWith({ insertError: duplicateName });
    const error = await apiRejection(service.create(createInput));
    expect(error.getStatus()).toBe(409);
    expect(error.safeResponse.code).toBe("TAG_NAME_TAKEN");
  });

  it("maps an update unique violation to 409 TAG_NAME_TAKEN, never a 500", async () => {
    const { service } = serviceWith({ updateError: duplicateName });
    const error = await apiRejection(
      service.update({ principal, workspaceId: WORKSPACE_ID, tagId: TAG_ID, name: "Roadmap" }),
    );
    expect(error.getStatus()).toBe(409);
    expect(error.safeResponse.code).toBe("TAG_NAME_TAKEN");
  });

  it("rethrows an unrelated database failure untouched", async () => {
    const failure = new Error("connection reset");
    const { service } = serviceWith({ insertError: failure });
    await expect(service.create(createInput)).rejects.toBe(failure);
  });

  it("conceals a missing or foreign tag as 404 on update", async () => {
    const { service } = serviceWith({ updated: [] });
    const error = await apiRejection(
      service.update({ principal, workspaceId: WORKSPACE_ID, tagId: TAG_ID, name: "Roadmap" }),
    );
    expect(error.getStatus()).toBe(404);
    expect(error.safeResponse.code).toBe("NOT_FOUND");
  });
});

describe("TagsService workspace limit and isolation", () => {
  it("refuses a create at the per-workspace cap with 409 TAG_LIMIT_REACHED", async () => {
    const { service, inserted } = serviceWith({ tagCount: TAG_MAX_PER_WORKSPACE });
    const error = await apiRejection(service.create(createInput));
    expect(error.getStatus()).toBe(409);
    expect(error.safeResponse.code).toBe("TAG_LIMIT_REACHED");
    expect(inserted).toHaveLength(0);
  });

  it("persists the active tenant workspace and rejects a cross-workspace insert", async () => {
    const { service, inserted, tenant } = serviceWith({ tagCount: TAG_MAX_PER_WORKSPACE - 1 });
    await service.create(createInput);
    const tagInsert = inserted.find((entry) => entry.table === tags)?.values as {
      readonly workspaceId: string;
    };
    expect(tagInsert.workspaceId).toBe(WORKSPACE_ID);
    expect(inserted.map((entry) => entry.table)).toEqual([
      tags,
      auditLogs,
      jobOutbox,
      apiIdempotencyRecords,
    ]);
    tenant.run(createTenantContext({ workspaceId: WORKSPACE_ID, userId: USER_ID }), () => {
      expect(() =>
        assertWorkspaceInsertValues({ workspaceId: OTHER_WORKSPACE_ID }, tenant, "tag.create"),
      ).toThrow();
    });
  });

  /**
   * The regression this exists for: deleting `whereWorkspace(tags, …)` from
   * `readRow`, `assertCapacity`, `update`, or `remove` leaves every other tag
   * test passing while a foreign tenant's tag id becomes readable, renamable,
   * and deletable. Rendering each captured predicate is what makes that fail.
   */
  it("scopes every tag read and mutation to the active workspace", async () => {
    const { service, reads, updated, deleted } = serviceWith();
    await service.list({
      principal,
      workspaceId: WORKSPACE_ID,
      page: 1,
      limit: 25,
      sortBy: "name",
      sortDirection: "asc",
    });
    await service.update({
      principal,
      workspaceId: WORKSPACE_ID,
      tagId: TAG_ID,
      name: "Roadmap",
    });
    await service.remove({ principal, workspaceId: WORKSPACE_ID, tagId: TAG_ID });
    await service.create(createInput);

    // list, update's readRow, remove's readRow, create's capacity count, and
    // create's readRow: every one of them addresses `tags` directly.
    const tagReads = reads.filter((entry) => entry.table === tags);
    expect(tagReads).toHaveLength(5);
    for (const entry of tagReads) expect(scopesToWorkspace(entry.predicate, tags)).toBe(true);

    expect(updated.map((entry) => entry.table)).toEqual([tags]);
    for (const entry of updated) expect(scopesToWorkspace(entry.predicate, tags)).toBe(true);

    expect(deleted.map((entry) => entry.table)).toEqual([tags]);
    for (const entry of deleted) expect(scopesToWorkspace(entry.predicate, tags)).toBe(true);
  });

  it("fails the scope assertion for an id-only predicate, so the check is not vacuous", () => {
    expect(scopesToWorkspace(eq(tags.id, TAG_ID), tags)).toBe(false);
    expect(scopesToWorkspace(undefined, tags)).toBe(false);
  });

  it("returns the stored tag on an idempotent replay without inserting again", async () => {
    const { service, inserted } = serviceWith({
      replay: [
        {
          resourceId: TAG_ID,
          payloadHash: hashApiPayload({ name: createInput.name, color: createInput.color }),
        },
      ],
    });
    const result = await service.create(createInput);
    expect(result.tag.id).toBe(TAG_ID);
    expect(inserted).toHaveLength(0);
  });
});

describe("TagsService projection and usage counts", () => {
  it("coalesces a null color and reports both detachment counts on delete", async () => {
    const { service, deleted } = serviceWith();
    const result = await service.remove({ principal, workspaceId: WORKSPACE_ID, tagId: TAG_ID });
    expect(result).toEqual({
      tagId: TAG_ID,
      deleted: true,
      removedNoteAssignments: 3,
      removedTaskAssignments: 4,
    });
    expect(deleted.map((entry) => entry.table)).toEqual([tags]);

    const updated = await service.update({
      principal,
      workspaceId: WORKSPACE_ID,
      tagId: TAG_ID,
      name: "Roadmap",
    });
    expect(updated.tag.color).toBe("#6b7280");
    expect(updated.tag.createdAt).toBe(createdAt.toISOString());
  });

  it("scopes both usage counts through their parent and excludes trashed notes", () => {
    const tenant = new TenantContextService();
    const service = new TagsService({} as DatabaseService, {} as AuthorizationEntryService, tenant);
    tenant.run(createTenantContext({ workspaceId: WORKSPACE_ID, userId: USER_ID }), () => {
      const noteCount = dialect.sqlToQuery(service["noteCount"]());
      expect(noteCount.sql).toContain('inner join "notes"');
      expect(noteCount.sql).toContain('"notes"."is_deleted" = false');
      expect(noteCount.sql).toContain('"notes"."workspace_id" =');
      expect(noteCount.params).toContain(WORKSPACE_ID);

      const taskCount = dialect.sqlToQuery(service["taskCount"]());
      expect(taskCount.sql).toContain('inner join "tasks"');
      expect(taskCount.sql).toContain('"tasks"."workspace_id" =');
      expect(taskCount.params).toContain(WORKSPACE_ID);
    });
  });
});
