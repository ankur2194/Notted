import { eq, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { AuthorizationDeniedError } from "../authorization/authorization.errors";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { hashApiPayload } from "../common/idempotency/api-idempotency";
import {
  apiIdempotencyRecords,
  auditLogs,
  notes,
  projects,
  tasks,
  taskStatuses,
} from "../database/schema";
import { createTenantContext, TenantContextService } from "../tenant";

import { TaskStatusesService } from "./task-statuses.service";

import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { DatabaseService } from "../database/database.service";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

const USER_ID = "80000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "80000000-0000-4000-8100-000000000001";
const PROJECT_ID = "80000000-0000-4000-8300-000000000001";
const STATUS_ID = "80000000-0000-4000-8600-000000000001";
const OTHER_STATUS_ID = "80000000-0000-4000-8600-000000000002";
const IDEMPOTENCY_KEY = "task-status-create-0001";

const NOW = new Date("2026-04-01T00:00:00.000Z");

const principal: AuthenticatedPrincipal = Object.freeze({
  userId: USER_ID,
  sessionId: "session",
  method: "opaque-session",
  assurance: "single-factor",
  authenticatedAt: "2026-04-01T00:00:00.000Z",
  expiresAt: "2026-04-02T00:00:00.000Z",
  isFresh: true,
});

interface StatusRowFixture {
  readonly [key: string]: unknown;
}

const baseStatus: StatusRowFixture = Object.freeze({
  id: STATUS_ID,
  workspaceId: WORKSPACE_ID,
  projectId: null,
  name: "Blocked",
  color: "#ff0000",
  sortOrder: 3,
  isBuiltIn: false,
  createdAt: NOW,
  updatedAt: NOW,
});

const createInput = Object.freeze({
  principal,
  workspaceId: WORKSPACE_ID,
  projectId: null,
  name: "Blocked",
  idempotencyKey: IDEMPOTENCY_KEY,
});

function denial(): AuthorizationDeniedError {
  return new AuthorizationDeniedError({
    allowed: false,
    code: "authorization.forbidden",
    httpStatus: 403,
    safeMessage: "You do not have access to this resource.",
    audit: {
      action: "settings.update",
      actorKind: "user",
      resourceKind: "settings",
      outcome: "deny",
      reason: "role",
    },
  });
}

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
  const explode = (): never => {
    throw new Error("SQL must not run");
  };
  return {
    db: new Proxy({}, { get: explode }),
    transaction: explode,
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

interface Fixture {
  readonly replay?: readonly { readonly resourceId: string; readonly payloadHash: string }[];
  readonly statusRows?: readonly StatusRowFixture[];
  readonly nameConflict?: readonly { readonly id: string }[];
  readonly maxSortOrder?: number | null;
  readonly projectRows?: readonly { readonly id: string }[];
  readonly usage?: number;
  readonly noteUsage?: number;
}

interface Statement {
  readonly table: unknown;
  readonly values?: Record<string, unknown>;
  predicate?: unknown;
}

const dialect = new PgDialect();

/**
 * True when a captured predicate really constrains `table` to the active
 * workspace.
 *
 * The fake database enforces nothing, so this is the only thing standing
 * between the suite and a silent tenant-isolation regression: dropping
 * `whereWorkspace(taskStatuses, …)` from `readRow`, `assertNameFree`,
 * `nextSortOrder`, the update, or the delete would otherwise leave every test
 * green while a foreign tenant's column became readable, renamable, and
 * deletable. Rendering the SQL asserts the predicate itself, not merely that
 * one exists.
 */
function scopesToWorkspace(predicate: unknown, table: { readonly workspaceId: unknown }): boolean {
  if (predicate === undefined || predicate === null) return false;
  const column = dialect.sqlToQuery(sql`${table.workspaceId}`).sql;
  const rendered = dialect.sqlToQuery(predicate as SQL);
  return rendered.sql.includes(`${column} =`) && rendered.params.includes(WORKSPACE_ID);
}

function renderSql(predicate: unknown): string {
  return dialect.sqlToQuery(predicate as SQL).sql;
}

function serviceWith(fixture: Fixture = {}) {
  const tenant = new TenantContextService();
  const { entry, authorizeUser } = mockEntry(tenant);
  const inserted: { table: unknown; values: Record<string, unknown> }[] = [];
  const updates: Statement[] = [];
  const deletes: Statement[] = [];
  const reads: Statement[] = [];
  const isolationLevels: (string | undefined)[] = [];
  const statusQueue = [...(fixture.statusRows ?? [baseStatus])];

  const lastInsertedStatus = (): StatusRowFixture => {
    const record = [...inserted].reverse().find((row) => row.table === taskStatuses);
    return record === undefined
      ? baseStatus
      : { ...baseStatus, ...record.values, createdAt: NOW, updatedAt: NOW };
  };

  const rowsFor = (table: unknown, fields: Record<string, unknown>): unknown[] => {
    const keys = Object.keys(fields);
    if (table === apiIdempotencyRecords) return [...(fixture.replay ?? [])];
    if (table === projects) return [...(fixture.projectRows ?? [{ id: PROJECT_ID }])];
    if (table === tasks) return [{ count: fixture.usage ?? 0 }];
    if (table === notes) return [{ count: fixture.noteUsage ?? 0 }];
    if (table === taskStatuses) {
      // Keyed by the selected field names, the only thing that distinguishes
      // the three shapes this service reads from one table.
      if (keys.length === 1 && keys[0] === "id") return [...(fixture.nameConflict ?? [])];
      if (keys.length === 1 && keys[0] === "value") {
        return [{ value: fixture.maxSortOrder === undefined ? 3 : fixture.maxSortOrder }];
      }
      if (statusQueue.length > 0) return [statusQueue.shift()!];
      // An exhausted queue with nothing inserted is "no such row in this
      // workspace" — which is exactly how another tenant's status looks.
      return inserted.some((row) => row.table === taskStatuses) ? [lastInsertedStatus()] : [];
    }
    return [];
  };

  const chain = (table: unknown, resolve: () => unknown[]): Record<string, unknown> => {
    const node: Record<string, unknown> = {
      where: (predicate: unknown) => {
        reads.push({ table, predicate });
        return node;
      },
      orderBy: () => node,
      limit: () => node,
      then: (
        onFulfilled: (value: unknown[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(resolve()).then(onFulfilled, onRejected),
    };
    return node;
  };

  const select = (fields: Record<string, unknown>) => ({
    from: (table: unknown) => chain(table, () => rowsFor(table, fields)),
  });

  const scope = {
    execute: () => Promise.resolve(),
    select,
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserted.push({ table, values });
        return Promise.resolve();
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        const record: Statement = { table, values };
        updates.push(record);
        const node: Record<string, unknown> = {
          where: (predicate: unknown) => {
            record.predicate = predicate;
            return node;
          },
          returning: () => chain(table, () => [{ ...lastInsertedStatus(), ...values }]),
        };
        return node;
      },
    }),
    delete: (table: unknown) => {
      const record: Statement = { table };
      const node: Record<string, unknown> = {
        where: (predicate: unknown) => {
          record.predicate = predicate;
          deletes.push(record);
          return node;
        },
        returning: () => chain(table, () => [{ id: STATUS_ID }]),
      };
      return node;
    },
  };

  const database = {
    db: { select },
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
    tenant,
    inserted,
    updates,
    deletes,
    reads,
    isolationLevels,
    authorizeUser,
    service: new TaskStatusesService(database, entry, tenant),
  };
}

function deniedService() {
  const authorizeUser = vi.fn().mockRejectedValue(denial());
  return {
    authorizeUser,
    service: new TaskStatusesService(
      forbiddenDatabase(),
      { authorizeUser } as unknown as AuthorizationEntryService,
      {} as TenantContextService,
    ),
  };
}

describe("TaskStatusesService authorizes before any SQL", () => {
  const cases: readonly [
    string,
    (service: TaskStatusesService) => Promise<unknown>,
    string,
    Record<string, unknown>,
  ][] = [
    [
      "list (workspace scope)",
      (s) => s.list({ principal, workspaceId: WORKSPACE_ID }),
      "workspace.read",
      { kind: "workspace" },
    ],
    [
      "list (project scope)",
      (s) => s.list({ principal, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID }),
      "project.read",
      { kind: "project", id: PROJECT_ID },
    ],
    ["create", (s) => s.create(createInput), "settings.update", { kind: "settings" }],
    [
      "update",
      (s) =>
        s.update({ principal, workspaceId: WORKSPACE_ID, statusId: STATUS_ID, name: "Blocked" }),
      "settings.update",
      { kind: "settings" },
    ],
    [
      "remove",
      (s) => s.remove({ principal, workspaceId: WORKSPACE_ID, statusId: STATUS_ID }),
      "settings.update",
      { kind: "settings" },
    ],
  ];

  it.each(cases)("%s", async (_name, invoke, action, resource) => {
    const { service, authorizeUser } = deniedService();
    await expect(invoke(service)).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(authorizeUser).toHaveBeenCalledWith(
      expect.objectContaining({ action, workspaceId: WORKSPACE_ID, resource }),
    );
  });

  /**
   * Reuse, not a new action: an editor is denied by the SAME `settings.update`
   * rule that already guards workspace settings and storage maintenance, so the
   * permission matrix stays a single source of truth.
   */
  it("manages columns through settings.update rather than a bespoke role check", async () => {
    const { service, authorizeUser } = deniedService();
    await expect(service.create(createInput)).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(authorizeUser.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ action: "settings.update", resource: { kind: "settings" } }),
    );
  });
});

describe("TaskStatusesService tenant isolation", () => {
  it("scopes every statement it issues to the active workspace", async () => {
    const { service, reads, updates, deletes } = serviceWith({
      statusRows: [baseStatus, baseStatus, baseStatus],
    });
    await service.list({ principal, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID });
    await service.create({ ...createInput, name: "Waiting" });
    await service.update({
      principal,
      workspaceId: WORKSPACE_ID,
      statusId: STATUS_ID,
      color: "#00ff00",
    });
    await service.remove({ principal, workspaceId: WORKSPACE_ID, statusId: STATUS_ID });

    const statusReads = reads.filter((entry) => entry.table === taskStatuses);
    expect(statusReads.length).toBeGreaterThan(0);
    for (const entry of statusReads)
      expect(scopesToWorkspace(entry.predicate, taskStatuses)).toBe(true);

    const taskReads = reads.filter((entry) => entry.table === tasks);
    expect(taskReads.length).toBe(1);
    for (const entry of taskReads) expect(scopesToWorkspace(entry.predicate, tasks)).toBe(true);

    // The delete's second usage count. Unscoped, it would report (and thereby
    // leak the existence of) another tenant's board placements.
    const noteReads = reads.filter((entry) => entry.table === notes);
    expect(noteReads.length).toBe(1);
    for (const entry of noteReads) expect(scopesToWorkspace(entry.predicate, notes)).toBe(true);

    expect(updates.length).toBe(1);
    for (const entry of updates)
      expect(scopesToWorkspace(entry.predicate, taskStatuses)).toBe(true);
    expect(deletes.length).toBe(1);
    for (const entry of deletes)
      expect(scopesToWorkspace(entry.predicate, taskStatuses)).toBe(true);
  });

  /**
   * Negative control. Without it `scopesToWorkspace` could be trivially true and
   * every assertion above would be worthless.
   */
  it("rejects a predicate that names only the row identifier", () => {
    expect(scopesToWorkspace(eq(taskStatuses.id, STATUS_ID), taskStatuses)).toBe(false);
    expect(scopesToWorkspace(undefined, taskStatuses)).toBe(false);
    expect(scopesToWorkspace(eq(notes.boardColumnId, STATUS_ID), notes)).toBe(false);
  });

  it("answers a foreign or unknown identifier with 404, never 403", async () => {
    for (const invoke of [
      (service: TaskStatusesService) =>
        service.update({
          principal,
          workspaceId: WORKSPACE_ID,
          statusId: OTHER_STATUS_ID,
          name: "Waiting",
        }),
      (service: TaskStatusesService) =>
        service.remove({ principal, workspaceId: WORKSPACE_ID, statusId: OTHER_STATUS_ID }),
    ]) {
      // The workspace-scoped read simply finds nothing, which is exactly what a
      // row belonging to another tenant looks like from inside this workspace.
      const { service } = serviceWith({ statusRows: [] });
      const error = await apiRejection(invoke(service));
      expect(error.getStatus()).toBe(404);
      expect(JSON.stringify(error.getResponse())).not.toContain(OTHER_STATUS_ID);
    }
  });
});

describe("TaskStatusesService naming rules", () => {
  it.each(["done", "Done", "IN_PROGRESS", "Canceled", "todo"])(
    "refuses %s because it shadows a built-in status",
    async (name) => {
      const { service, inserted, isolationLevels } = serviceWith();
      const error = await apiRejection(service.create({ ...createInput, name }));
      expect(error.getStatus()).toBe(400);
      // Rejected before the transaction opens, not rolled back afterwards.
      expect(isolationLevels).toEqual([]);
      expect(inserted).toEqual([]);
    },
  );

  it("refuses a reserved name on rename too", async () => {
    const { service } = serviceWith();
    const error = await apiRejection(
      service.update({
        principal,
        workspaceId: WORKSPACE_ID,
        statusId: STATUS_ID,
        name: "done",
      }),
    );
    expect(error.getStatus()).toBe(400);
  });

  it("enforces workspace-level name uniqueness inside the transaction", async () => {
    const { service, reads, inserted, isolationLevels } = serviceWith({
      nameConflict: [{ id: OTHER_STATUS_ID }],
    });
    const error = await apiRejection(service.create(createInput));
    expect(error.getStatus()).toBe(409);
    expect(inserted.filter((row) => row.table === taskStatuses)).toEqual([]);
    // Serializable, because the `(workspace_id, project_id, name)` unique index
    // cannot back this rule up: PostgreSQL treats NULL project_id as distinct.
    expect(isolationLevels).toEqual(["serializable"]);
    const conflictRead = reads.find(
      (entry) => entry.table === taskStatuses && renderSql(entry.predicate).includes("is null"),
    );
    expect(conflictRead).toBeDefined();
  });

  it("scopes the uniqueness probe to the project when one is named", async () => {
    const { service, reads } = serviceWith({
      nameConflict: [{ id: OTHER_STATUS_ID }],
      statusRows: [{ ...baseStatus, projectId: PROJECT_ID }],
    });
    await apiRejection(service.create({ ...createInput, projectId: PROJECT_ID }));
    const probe = reads.find(
      (entry) => entry.table === taskStatuses && renderSql(entry.predicate).includes('"name" ='),
    );
    expect(probe).toBeDefined();
    expect(renderSql(probe?.predicate)).not.toContain("is null");
  });

  it("skips the uniqueness probe when the submitted name is unchanged", async () => {
    const { service, updates } = serviceWith({
      statusRows: [{ ...baseStatus, name: "Blocked" }],
    });
    await service.update({
      principal,
      workspaceId: WORKSPACE_ID,
      statusId: STATUS_ID,
      name: "Blocked",
    });
    // Unchanged name skips the uniqueness probe entirely; the row would
    // otherwise collide with itself.
    expect(updates[0]?.values?.name).toBe("Blocked");
  });
});

describe("TaskStatusesService creation", () => {
  it("appends behind every existing column and stamps the active workspace", async () => {
    const { service, inserted } = serviceWith({ maxSortOrder: 7 });
    const result = await service.create({ ...createInput, name: "Waiting", color: "#123456" });
    const values = inserted.find((row) => row.table === taskStatuses)?.values ?? {};
    expect(values).toMatchObject({
      workspaceId: WORKSPACE_ID,
      projectId: null,
      name: "Waiting",
      color: "#123456",
      sortOrder: 8,
    });
    expect(result.status.workspaceId).toBe(WORKSPACE_ID);
  });

  it("starts at 1 for the first column in a workspace", async () => {
    const { service, inserted } = serviceWith({ maxSortOrder: null });
    await service.create({ ...createInput, name: "Waiting" });
    expect(inserted.find((row) => row.table === taskStatuses)?.values?.sortOrder).toBe(1);
  });

  it("leaves the color to the column default when none is supplied", async () => {
    const { service, inserted } = serviceWith();
    await service.create({ ...createInput, name: "Waiting" });
    const values = inserted.find((row) => row.table === taskStatuses)?.values ?? {};
    expect("color" in values).toBe(false);
  });

  it("refuses a project that does not belong to this workspace", async () => {
    const { service, inserted } = serviceWith({ projectRows: [] });
    const error = await apiRejection(service.create({ ...createInput, projectId: PROJECT_ID }));
    expect(error.getStatus()).toBe(404);
    expect(inserted.filter((row) => row.table === taskStatuses)).toEqual([]);
  });

  it("replays a stored idempotent create instead of inserting twice", async () => {
    const { service, inserted } = serviceWith({
      replay: [
        {
          resourceId: STATUS_ID,
          payloadHash: hashApiPayload({ projectId: null, name: "Blocked", color: null }),
        },
      ],
    });
    await expect(service.create(createInput)).resolves.toMatchObject({
      status: { id: STATUS_ID },
    });
    expect(inserted.filter((row) => row.table === taskStatuses)).toEqual([]);
  });

  it("refuses to reuse an idempotency key for a different column", async () => {
    const { service, inserted } = serviceWith({
      replay: [{ resourceId: STATUS_ID, payloadHash: "a-different-request" }],
    });
    const error = await apiRejection(service.create(createInput));
    expect(error.getStatus()).toBe(409);
    expect(inserted.filter((row) => row.table === taskStatuses)).toEqual([]);
  });

  it("records an audit entry that carries no status name", async () => {
    const { service, inserted } = serviceWith();
    await service.create({ ...createInput, name: "Waiting" });
    const audit = inserted.find((row) => row.table === auditLogs)?.values ?? {};
    expect(audit).toMatchObject({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      action: "task_status.created",
      entityType: "task_status",
    });
    expect(JSON.stringify(audit)).not.toContain("Waiting");
  });
});

describe("TaskStatusesService built-in protection", () => {
  const builtIn = { ...baseStatus, isBuiltIn: true, name: "Review" };

  it("refuses to rename a built-in status", async () => {
    const { service, updates } = serviceWith({ statusRows: [builtIn] });
    const error = await apiRejection(
      service.update({
        principal,
        workspaceId: WORKSPACE_ID,
        statusId: STATUS_ID,
        name: "Waiting",
      }),
    );
    expect(error.getStatus()).toBe(409);
    expect(updates).toEqual([]);
  });

  it("still allows recoloring a built-in status", async () => {
    const { service, updates } = serviceWith({ statusRows: [builtIn] });
    await service.update({
      principal,
      workspaceId: WORKSPACE_ID,
      statusId: STATUS_ID,
      color: "#00ff00",
    });
    expect(updates[0]?.values?.color).toBe("#00ff00");
  });

  it("refuses to delete a built-in status", async () => {
    const { service, deletes } = serviceWith({ statusRows: [builtIn] });
    const error = await apiRejection(
      service.remove({ principal, workspaceId: WORKSPACE_ID, statusId: STATUS_ID }),
    );
    expect(error.getStatus()).toBe(409);
    expect(deletes).toEqual([]);
  });
});

describe("TaskStatusesService deletion", () => {
  /**
   * No reassignment argument and no task write: `tasks.custom_status_id` is
   * `ON DELETE SET NULL` and every affected task still carries the built-in
   * `status` it never lost, so the count is reporting, not repair.
   */
  it("reports how many tasks fall back to their built-in status", async () => {
    const { service, inserted, updates } = serviceWith({ usage: 4 });
    await expect(
      service.remove({ principal, workspaceId: WORKSPACE_ID, statusId: STATUS_ID }),
    ).resolves.toEqual({ id: STATUS_ID, deleted: true, affected: 4, affectedNotes: 0 });
    expect(updates.filter((row) => row.table === tasks)).toEqual([]);
    expect(inserted.filter((row) => row.table === tasks)).toEqual([]);
  });

  it("reports zero when nothing used the column", async () => {
    const { service } = serviceWith({ usage: 0 });
    await expect(
      service.remove({ principal, workspaceId: WORKSPACE_ID, statusId: STATUS_ID }),
    ).resolves.toMatchObject({ affected: 0, affectedNotes: 0 });
  });

  /**
   * `notes.board_column_id` points at the SAME table with `ON DELETE SET NULL`,
   * but a note has no built-in status underneath it: the placement is simply
   * gone. Counting it separately is the only warning the user ever gets, so it
   * is a distinct number and never folded into `affected`.
   */
  it("counts the notes that lose their board column, scoped to the workspace", async () => {
    const { service, reads, updates, deletes } = serviceWith({ usage: 1, noteUsage: 7 });
    await expect(
      service.remove({ principal, workspaceId: WORKSPACE_ID, statusId: STATUS_ID }),
    ).resolves.toEqual({ id: STATUS_ID, deleted: true, affected: 1, affectedNotes: 7 });

    const noteReads = reads.filter((entry) => entry.table === notes);
    expect(noteReads).toHaveLength(1);
    expect(scopesToWorkspace(noteReads[0]?.predicate, notes)).toBe(true);
    expect(renderSql(noteReads[0]?.predicate)).toContain(
      dialect.sqlToQuery(sql`${notes.boardColumnId}`).sql,
    );
    // Reporting only: the count never turns into a write against `notes`.
    expect(updates.filter((row) => row.table === notes)).toEqual([]);
    expect(deletes.filter((row) => row.table === notes)).toEqual([]);
  });
});

describe("TaskStatusesService listing", () => {
  it("returns workspace-wide columns only when no project is named", async () => {
    const { service, reads } = serviceWith({ statusRows: [baseStatus] });
    const result = await service.list({ principal, workspaceId: WORKSPACE_ID });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: STATUS_ID, name: "Blocked", isBuiltIn: false });
    expect(renderSql(reads[0]?.predicate)).toContain("is null");
  });

  it("widens to the project's own columns when one is named", async () => {
    const { service, reads } = serviceWith({ statusRows: [baseStatus] });
    await service.list({ principal, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID });
    const rendered = renderSql(reads[0]?.predicate);
    expect(rendered).toContain("is null");
    expect(rendered).toContain("or");
  });

  it("substitutes the neutral default for a row with no stored color", async () => {
    const { service } = serviceWith({ statusRows: [{ ...baseStatus, color: null }] });
    const result = await service.list({ principal, workspaceId: WORKSPACE_ID });
    expect(result.items[0]?.color).toBe("#6b7280");
  });
});
