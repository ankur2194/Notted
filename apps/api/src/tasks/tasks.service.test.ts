import { eq, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthorizationDeniedError } from "../authorization/authorization.errors";
import { ApiHttpException } from "../common/errors/api-http.exception";
import {
  apiIdempotencyRecords,
  notes,
  projects,
  tags,
  tasks,
  taskStatuses,
  taskTags,
  workspaceMembers,
} from "../database/schema";
import { assertWorkspaceInsertValues, createTenantContext, TenantContextService } from "../tenant";

import { TasksService } from "./tasks.service";

import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { DatabaseService } from "../database/database.service";
import type { AuthenticatedPrincipal } from "@notted/shared-types";

const USER_ID = "60000000-0000-4000-8000-000000000001";
const ASSIGNEE_ID = "60000000-0000-4000-8000-000000000002";
const WORKSPACE_ID = "60000000-0000-4000-8100-000000000001";
const OTHER_WORKSPACE_ID = "60000000-0000-4000-8100-000000000002";
const TASK_ID = "60000000-0000-4000-8200-000000000001";
const OTHER_TASK_ID = "60000000-0000-4000-8200-000000000002";
const MISSING_TASK_ID = "60000000-0000-4000-8200-000000000003";
const PROJECT_ID = "60000000-0000-4000-8300-000000000001";
const OTHER_PROJECT_ID = "60000000-0000-4000-8300-000000000002";
const NOTE_ID = "60000000-0000-4000-8400-000000000001";
const TAG_ID = "60000000-0000-4000-8500-000000000001";
const STATUS_ID = "60000000-0000-4000-8600-000000000001";
const IDEMPOTENCY_KEY = "task-create-000000001";

const NOW = new Date("2026-03-01T00:00:00.000Z");

const principal: AuthenticatedPrincipal = Object.freeze({
  userId: USER_ID,
  sessionId: "session",
  method: "opaque-session",
  assurance: "single-factor",
  authenticatedAt: "2026-03-01T00:00:00.000Z",
  expiresAt: "2026-03-02T00:00:00.000Z",
  isFresh: true,
});

interface TaskRowFixture {
  readonly [key: string]: unknown;
}

const baseTask: TaskRowFixture = Object.freeze({
  id: TASK_ID,
  workspaceId: WORKSPACE_ID,
  projectId: null,
  noteId: null,
  parentId: null,
  title: "Draft the brief",
  description: null,
  status: "todo",
  customStatusId: null,
  priority: "low",
  assigneeId: null,
  dueDate: null,
  completedAt: null,
  sortOrder: 1,
  recurrence: "none",
  recurrenceCron: null,
  createdById: USER_ID,
  updatedById: USER_ID,
  createdAt: NOW,
  updatedAt: NOW,
});

const createInput = Object.freeze({
  principal,
  workspaceId: WORKSPACE_ID,
  projectId: null,
  noteId: null,
  parentId: null,
  title: "Draft the brief",
  description: null,
  status: "todo" as const,
  customStatusId: null,
  priority: "low" as const,
  assigneeId: null,
  dueDate: null,
  beforeTaskId: null,
  tagIds: [],
  recurrence: "none" as const,
  recurrenceCron: null,
  idempotencyKey: IDEMPOTENCY_KEY,
});

const listInput = Object.freeze({
  principal,
  workspaceId: WORKSPACE_ID,
  page: 1,
  limit: 25,
  grouping: "none" as const,
  sortBy: "sortOrder" as const,
  sortDirection: "asc" as const,
});

function denial(): AuthorizationDeniedError {
  return new AuthorizationDeniedError({
    allowed: false,
    code: "authorization.concealed",
    httpStatus: 404,
    safeMessage: "The requested resource was not found.",
    audit: {
      action: "task.update",
      actorKind: "user",
      resourceKind: "task",
      outcome: "deny",
      reason: "concealed",
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

interface Fixture {
  readonly replay?: readonly { readonly resourceId: string; readonly payloadHash: string }[];
  readonly taskRows?: readonly TaskRowFixture[];
  readonly siblings?: readonly { readonly id: string; readonly sortOrder: number }[];
  readonly subtree?: readonly { readonly id: string; readonly parentId: string | null }[];
  readonly after?: readonly { readonly sortOrder: number }[];
  readonly members?: readonly { readonly id: string }[];
  readonly statuses?: readonly { readonly projectId: string | null }[];
  readonly statusNames?: readonly { readonly id: string; readonly name: string }[];
  readonly tagRows?: readonly { readonly id: string }[];
  readonly taskTagRows?: readonly { readonly taskId: string; readonly tagId: string }[];
  readonly projectRows?: readonly { readonly id: string; readonly status: string }[];
  readonly noteRows?: readonly {
    readonly id: string;
    readonly projectId: string | null;
    readonly isDeleted: boolean;
  }[];
  readonly updated?: readonly TaskRowFixture[];
}

/** One captured statement: the table, the values written, and the predicate. */
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
 * between the suite and a silent tenant-isolation regression: deleting
 * `whereWorkspace(tasks, …)` from `readRow`, `loadSiblings`, `subtreeIds`, or
 * `applyBulk`'s scope would otherwise leave every task test green while a
 * foreign tenant's task id became readable, reorderable, and deletable.
 * Rendering the SQL asserts the predicate itself, not merely that one exists.
 */
function scopesToWorkspace(predicate: unknown, table: { readonly workspaceId: unknown }): boolean {
  if (predicate === undefined || predicate === null) return false;
  const column = dialect.sqlToQuery(sql`${table.workspaceId}`).sql;
  const rendered = dialect.sqlToQuery(predicate as SQL);
  return rendered.sql.includes(`${column} =`) && rendered.params.includes(WORKSPACE_ID);
}

function serviceWith(fixture: Fixture = {}) {
  const tenant = new TenantContextService();
  const { entry, authorizeUser } = mockEntry(tenant);
  const inserted: { table: unknown; values: unknown }[] = [];
  const updates: Statement[] = [];
  const deletes: Statement[] = [];
  const reads: Statement[] = [];
  /**
   * Ordered log of the statement kinds a transaction issued.
   *
   * Lock ORDER is the only thing that separates a correct transaction from one
   * that deadlocks, and neither `updates` nor `reads` preserves it. `create`
   * takes the group advisory lock and only then row-locks siblings; a path that
   * row-updates first and locks the group afterwards is the inverse order and
   * the two abort each other with 40P01.
   */
  const operations: ("execute" | "update" | "insert" | "delete")[] = [];
  const isolationLevels: (string | undefined)[] = [];
  const taskQueue = [...(fixture.taskRows ?? [baseTask])];

  const lastInsertedTask = (): TaskRowFixture => {
    const record = [...inserted].reverse().find((row) => row.table === tasks);
    return record === undefined
      ? baseTask
      : {
          ...baseTask,
          ...(record.values as Record<string, unknown>),
          createdAt: NOW,
          updatedAt: NOW,
        };
  };

  const rowsFor = (table: unknown, fields: Record<string, unknown>): unknown[] => {
    const keys = Object.keys(fields);
    if (table === apiIdempotencyRecords) return [...(fixture.replay ?? [])];
    if (table === workspaceMembers) {
      return keys.includes("role") ? [{ role: "owner" }] : [...(fixture.members ?? [{ id: "m" }])];
    }
    if (table === projects) {
      return [...(fixture.projectRows ?? [{ id: PROJECT_ID, status: "active" }])];
    }
    if (table === notes) {
      return [...(fixture.noteRows ?? [{ id: NOTE_ID, projectId: null, isDeleted: false }])];
    }
    if (table === taskStatuses) {
      return keys.includes("name")
        ? [...(fixture.statusNames ?? [])]
        : [...(fixture.statuses ?? [{ projectId: null }])];
    }
    if (table === tags) return [...(fixture.tagRows ?? [{ id: TAG_ID }])];
    if (table === taskTags) return [...(fixture.taskTagRows ?? [])];
    if (table === tasks) {
      if (keys.length === 1) return [...(fixture.after ?? [])];
      if (keys.length === 2 && keys.includes("parentId")) {
        return [...(fixture.subtree ?? [{ id: TASK_ID, parentId: null }])];
      }
      if (keys.length === 2) return [...(fixture.siblings ?? [{ id: TASK_ID, sortOrder: 1 }])];
      return [taskQueue.length > 0 ? taskQueue.shift()! : lastInsertedTask()];
    }
    return [];
  };

  /**
   * Chainable, awaitable query stub — every builder method returns itself.
   *
   * `where` RECORDS its predicate instead of discarding it. Without that, every
   * `whereWorkspace(tasks, …)` in the service could be deleted and this suite
   * would stay green while a foreign tenant's task became readable.
   */
  const chain = (table: unknown, resolve: () => unknown[]): Record<string, unknown> => {
    const node: Record<string, unknown> = {
      where: (predicate: unknown) => {
        reads.push({ table, predicate });
        return node;
      },
      innerJoin: () => node,
      orderBy: () => node,
      limit: () => node,
      offset: () => node,
      for: () => node,
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
    execute: () => {
      operations.push("execute");
      return Promise.resolve();
    },
    select,
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        operations.push("insert");
        inserted.push({ table, values });
        return Promise.resolve();
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        const record: Statement = { table, values };
        operations.push("update");
        updates.push(record);
        const applied = () => [...(fixture.updated ?? [{ ...baseTask, ...values, id: TASK_ID }])];
        const node: Record<string, unknown> = {
          where: (predicate: unknown) => {
            record.predicate = predicate;
            return node;
          },
          returning: () => chain(table, applied),
          then: (onFulfilled: (value: unknown) => unknown) =>
            Promise.resolve(undefined).then(onFulfilled),
        };
        return node;
      },
    }),
    delete: (table: unknown) => {
      const node: Record<string, unknown> = {
        where: (predicate: unknown) => {
          deletes.push({ table, predicate });
          return node;
        },
        returning: () => chain(table, () => [{ id: TASK_ID }]),
        then: (onFulfilled: (value: unknown) => unknown) =>
          Promise.resolve(undefined).then(onFulfilled),
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
    operations,
    isolationLevels,
    authorizeUser,
    service: new TasksService(database, entry, tenant),
  };
}

function deniedService() {
  const authorizeUser = vi.fn().mockRejectedValue(denial());
  return {
    authorizeUser,
    service: new TasksService(
      forbiddenDatabase(),
      { authorizeUser } as unknown as AuthorizationEntryService,
      {} as TenantContextService,
    ),
  };
}

describe("TasksService authorizes before any SQL", () => {
  const cases: readonly [
    string,
    (service: TasksService) => Promise<unknown>,
    string,
    Record<string, unknown>,
  ][] = [
    ["list (workspace scope)", (s) => s.list(listInput), "workspace.read", { kind: "workspace" }],
    [
      "list (note scope)",
      (s) => s.list({ ...listInput, noteId: NOTE_ID }),
      "note.read",
      { kind: "note", id: NOTE_ID },
    ],
    [
      "list (project scope)",
      (s) => s.list({ ...listInput, projectId: PROJECT_ID }),
      "project.read",
      { kind: "project", id: PROJECT_ID },
    ],
    [
      "read",
      (s) => s.read({ principal, workspaceId: WORKSPACE_ID, taskId: TASK_ID }),
      "task.read",
      { kind: "task", id: TASK_ID },
    ],
    ["create", (s) => s.create(createInput), "task.create", { kind: "workspace" }],
    [
      "create (into a parent task)",
      (s) => s.create({ ...createInput, parentId: OTHER_TASK_ID }),
      "task.create",
      { kind: "task", id: OTHER_TASK_ID },
    ],
    [
      "create (into a project)",
      (s) => s.create({ ...createInput, projectId: PROJECT_ID }),
      "task.create",
      { kind: "project", id: PROJECT_ID },
    ],
    [
      "update",
      (s) => s.update({ principal, workspaceId: WORKSPACE_ID, taskId: TASK_ID, title: "Later" }),
      "task.update",
      { kind: "task", id: TASK_ID },
    ],
    [
      "reorder",
      (s) =>
        s.reorder({
          principal,
          workspaceId: WORKSPACE_ID,
          taskId: TASK_ID,
          beforeTaskId: null,
        }),
      "task.update",
      { kind: "task", id: TASK_ID },
    ],
    [
      "remove",
      (s) => s.remove({ principal, workspaceId: WORKSPACE_ID, taskId: TASK_ID }),
      "task.delete",
      { kind: "task", id: TASK_ID },
    ],
  ];

  it.each(cases)("%s", async (_name, invoke, action, resource) => {
    const { service, authorizeUser } = deniedService();
    await expect(invoke(service)).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(authorizeUser).toHaveBeenCalledWith(
      expect.objectContaining({ action, workspaceId: WORKSPACE_ID, resource }),
    );
  });

  it("bulk authorizes every identifier before touching the database", async () => {
    const { service, authorizeUser } = deniedService();
    const result = await service.bulk({
      principal,
      workspaceId: WORKSPACE_ID,
      taskIds: [TASK_ID, OTHER_TASK_ID, MISSING_TASK_ID],
      action: { kind: "delete" },
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(authorizeUser).toHaveBeenCalledTimes(3);
    expect(authorizeUser).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.delete", resource: { kind: "task", id: TASK_ID } }),
    );
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([
      { taskId: TASK_ID, reason: "unavailable" },
      { taskId: OTHER_TASK_ID, reason: "unavailable" },
      { taskId: MISSING_TASK_ID, reason: "unavailable" },
    ]);
  });

  it("reorder proves destination create authority as well as source update", async () => {
    const authorizeUser = vi
      .fn()
      .mockResolvedValueOnce({ workspaceId: WORKSPACE_ID, userId: USER_ID })
      .mockRejectedValueOnce(denial());
    const service = new TasksService(
      forbiddenDatabase(),
      { authorizeUser } as unknown as AuthorizationEntryService,
      {} as TenantContextService,
    );
    await expect(
      service.reorder({
        principal,
        workspaceId: WORKSPACE_ID,
        taskId: TASK_ID,
        beforeTaskId: null,
        projectId: PROJECT_ID,
      }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(authorizeUser).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: "task.create",
        resource: { kind: "project", id: PROJECT_ID },
      }),
    );
  });
});

describe("TasksService update requires the narrower grants", () => {
  it("additionally proves task.assign when the assignee changes", async () => {
    const authorizeUser = vi
      .fn()
      .mockResolvedValueOnce({ workspaceId: WORKSPACE_ID, userId: USER_ID })
      .mockRejectedValueOnce(denial());
    const service = new TasksService(
      forbiddenDatabase(),
      { authorizeUser } as unknown as AuthorizationEntryService,
      {} as TenantContextService,
    );
    await expect(
      service.update({
        principal,
        workspaceId: WORKSPACE_ID,
        taskId: TASK_ID,
        assigneeId: ASSIGNEE_ID,
      }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(authorizeUser).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: "task.assign",
        resource: { kind: "task", id: TASK_ID, targetUserId: ASSIGNEE_ID },
      }),
    );
  });

  it("additionally proves task.tag when the tag set changes", async () => {
    const authorizeUser = vi
      .fn()
      .mockResolvedValueOnce({ workspaceId: WORKSPACE_ID, userId: USER_ID })
      .mockRejectedValueOnce(denial());
    const service = new TasksService(
      forbiddenDatabase(),
      { authorizeUser } as unknown as AuthorizationEntryService,
      {} as TenantContextService,
    );
    await expect(
      service.update({
        principal,
        workspaceId: WORKSPACE_ID,
        taskId: TASK_ID,
        tagIds: [TAG_ID],
      }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(authorizeUser).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ action: "task.tag", resource: { kind: "task", id: TASK_ID } }),
    );
  });
});

describe("TasksService bulk conceals denied and missing identifiers alike", () => {
  it("reports one uniform reason so the batch cannot be used as an existence oracle", async () => {
    const tenant = new TenantContextService();
    const { entry, authorizeUser } = mockEntry(tenant);
    authorizeUser
      .mockResolvedValueOnce({ workspaceId: WORKSPACE_ID, userId: USER_ID })
      .mockRejectedValueOnce(denial())
      .mockRejectedValueOnce(denial());
    const built = serviceWith();
    const service = new TasksService(built.database, entry, tenant);
    const result = await service.bulk({
      principal,
      workspaceId: WORKSPACE_ID,
      taskIds: [TASK_ID, OTHER_TASK_ID, MISSING_TASK_ID],
      action: { kind: "priority", priority: "high" },
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(authorizeUser).toHaveBeenCalledTimes(3);
    expect(authorizeUser).toHaveBeenCalledWith(expect.objectContaining({ action: "task.update" }));
    expect(result.updated).toEqual([TASK_ID]);
    // A task the caller may not touch and a task that does not exist are
    // indistinguishable in the response.
    expect(result.skipped).toEqual([
      { taskId: OTHER_TASK_ID, reason: "unavailable" },
      { taskId: MISSING_TASK_ID, reason: "unavailable" },
    ]);
  });

  it("maps each bulk action kind onto the grant it actually needs", async () => {
    const expectations: readonly [Parameters<TasksService["bulk"]>[0]["action"], string][] = [
      [{ kind: "status", status: "done" }, "task.update"],
      [{ kind: "priority", priority: "high" }, "task.update"],
      [{ kind: "assign", assigneeId: ASSIGNEE_ID }, "task.assign"],
      [{ kind: "tag", tagIds: [TAG_ID] }, "task.tag"],
      [{ kind: "delete" }, "task.delete"],
    ];
    for (const [action, expected] of expectations) {
      const { service, authorizeUser } = deniedService();
      await service.bulk({
        principal,
        workspaceId: WORKSPACE_ID,
        taskIds: [TASK_ID],
        action,
        idempotencyKey: IDEMPOTENCY_KEY,
      });
      expect(authorizeUser).toHaveBeenCalledWith(expect.objectContaining({ action: expected }));
    }
  });
});

describe("TasksService ordering", () => {
  it("answers a vanished reorder anchor with 409 ORDER_CONFLICT, not a silent append", async () => {
    const { service } = serviceWith({
      siblings: [
        { id: TASK_ID, sortOrder: 1 },
        { id: OTHER_TASK_ID, sortOrder: 2 },
      ],
    });
    const error = await apiRejection(
      service.reorder({
        principal,
        workspaceId: WORKSPACE_ID,
        taskId: TASK_ID,
        beforeTaskId: MISSING_TASK_ID,
      }),
    );
    expect(error.getStatus()).toBe(409);
    expect(error.safeResponse.code).toBe("ORDER_CONFLICT");
    expect(error.safeResponse.message).toBe("The task order changed. Retry.");
  });

  it("places a task at the midpoint of its requested anchor", async () => {
    const { service, updates } = serviceWith({
      siblings: [
        { id: TASK_ID, sortOrder: 1 },
        { id: OTHER_TASK_ID, sortOrder: 2 },
        { id: MISSING_TASK_ID, sortOrder: 3 },
      ],
    });
    await service.reorder({
      principal,
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      beforeTaskId: MISSING_TASK_ID,
    });
    // TASK_ID is excluded from its own sibling set, leaving [2, 3].
    expect(updates.at(-1)?.values?.sortOrder).toBe(2.5);
  });
});

describe("TasksService recurring completion", () => {
  const dueDate = new Date("2026-03-01T09:00:00.000Z");

  // The spawn advances past the COMPLETION instant, not only past the due date,
  // so the clock has to be pinned or these expectations would drift with the
  // calendar. On-time completion is the default; the catch-up case pins its own.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T09:05:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns the next weekly occurrence inside the completing transaction", async () => {
    const current: TaskRowFixture = { ...baseTask, recurrence: "weekly", dueDate, status: "todo" };
    const { service, inserted } = serviceWith({
      taskRows: [current],
      updated: [{ ...current, status: "done", completedAt: NOW }],
    });
    const result = await service.update({
      principal,
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      status: "done",
    });
    expect(result.task.status).toBe("done");
    expect(result.spawned).not.toBeNull();
    expect(result.spawned?.dueDate).toBe("2026-03-08T09:00:00.000Z");
    expect(result.spawned?.status).toBe("todo");
    expect(result.spawned?.completedAt).toBeNull();
    expect(result.spawned?.recurrence).toBe("weekly");
    const spawnInsert = inserted.find((row) => row.table === tasks)?.values as Record<
      string,
      unknown
    >;
    expect(spawnInsert.workspaceId).toBe(WORKSPACE_ID);
    expect(spawnInsert.title).toBe(current.title);
  });

  /**
   * `create` takes the sibling-group advisory lock and only then row-locks
   * siblings while renormalizing. A completion that row-updates the task first
   * and locks the group afterwards takes the same two locks in the opposite
   * order, and the two abort each other with 40P01 — which no caller retries.
   */
  it("locks the sibling group before updating the row when a successor will be inserted", async () => {
    const current: TaskRowFixture = { ...baseTask, recurrence: "weekly", dueDate, status: "todo" };
    const { service, operations } = serviceWith({
      taskRows: [current],
      updated: [{ ...current, status: "done", completedAt: NOW }],
    });
    await service.update({
      principal,
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      status: "done",
    });
    expect(operations).toContain("update");
    expect(operations.indexOf("execute")).toBeGreaterThanOrEqual(0);
    expect(operations.indexOf("execute")).toBeLessThan(operations.indexOf("update"));
  });

  it("does not lock the sibling group for an ordinary edit that spawns nothing", async () => {
    // The lock is contention, so it is paid only when a successor is coming.
    const { service, operations } = serviceWith({ taskRows: [{ ...baseTask }] });
    await service.update({
      principal,
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      title: "Renamed",
    });
    expect(operations).toContain("update");
    expect(operations).not.toContain("execute");
  });

  it("spawns a future occurrence when a recurring task is completed long overdue", async () => {
    // Five months late. Spawning 2026-03-08 would hand the user an immediately
    // overdue task and demand ~22 more completions to reach the present.
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    const current = { ...baseTask, recurrence: "weekly", dueDate, status: "todo" };
    const { service } = serviceWith({
      taskRows: [current],
      updated: [{ ...current, status: "done", completedAt: NOW }],
    });
    const result = await service.update({
      principal,
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      status: "done",
    });
    expect(result.spawned?.dueDate).toBe("2026-08-16T09:00:00.000Z");
    expect(result.spawned?.status).toBe("todo");
  });

  it("spawns nothing for a non-recurring task", async () => {
    const current = { ...baseTask, recurrence: "none", dueDate, status: "todo" };
    const { service, inserted } = serviceWith({
      taskRows: [current],
      updated: [{ ...current, status: "done", completedAt: NOW }],
    });
    const result = await service.update({
      principal,
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      status: "done",
    });
    expect(result.spawned).toBeNull();
    expect(inserted.some((row) => row.table === tasks)).toBe(false);
  });

  it("spawns nothing for a recurring task with no due date to advance from", async () => {
    const current = { ...baseTask, recurrence: "weekly", dueDate: null, status: "todo" };
    const { service } = serviceWith({
      taskRows: [current],
      updated: [{ ...current, status: "done", completedAt: NOW }],
    });
    const result = await service.update({
      principal,
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      status: "done",
    });
    expect(result.spawned).toBeNull();
  });

  it("clears completedAt when a task leaves done and does not spawn", async () => {
    const current = {
      ...baseTask,
      recurrence: "weekly",
      dueDate,
      status: "done",
      completedAt: NOW,
    };
    const { service, updates, inserted } = serviceWith({
      taskRows: [current],
      updated: [{ ...current, status: "todo", completedAt: null }],
    });
    const result = await service.update({
      principal,
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      status: "todo",
    });
    const applied = updates.find((entry) => entry.table === tasks)?.values;
    expect(applied).toMatchObject({ status: "todo", completedAt: null });
    expect(result.task.completedAt).toBeNull();
    expect(result.spawned).toBeNull();
    expect(inserted.some((row) => row.table === tasks)).toBe(false);
  });
});

describe("TasksService tenant and membership invariants", () => {
  it("persists only the active tenant workspace and rejects a cross-workspace insert", async () => {
    const { service, inserted, tenant } = serviceWith();
    await service.create(createInput);
    const taskInsert = inserted.find((entry) => entry.table === tasks)?.values as {
      readonly workspaceId: string;
    };
    expect(taskInsert.workspaceId).toBe(WORKSPACE_ID);
    tenant.run(createTenantContext({ workspaceId: WORKSPACE_ID, userId: USER_ID }), () => {
      expect(() =>
        assertWorkspaceInsertValues({ workspaceId: OTHER_WORKSPACE_ID }, tenant, "task.create"),
      ).toThrow();
    });
  });

  it("conceals an assignee outside the workspace as 404", async () => {
    const { service, inserted } = serviceWith({ members: [] });
    const error = await apiRejection(service.create({ ...createInput, assigneeId: ASSIGNEE_ID }));
    expect(error.getStatus()).toBe(404);
    expect(error.safeResponse.code).toBe("NOT_FOUND");
    expect(inserted.some((row) => row.table === tasks)).toBe(false);
  });

  it("conceals a custom status scoped to another project as 404", async () => {
    const { service, inserted } = serviceWith({ statuses: [{ projectId: OTHER_PROJECT_ID }] });
    const error = await apiRejection(
      service.create({ ...createInput, projectId: PROJECT_ID, customStatusId: STATUS_ID }),
    );
    expect(error.getStatus()).toBe(404);
    expect(inserted.some((row) => row.table === tasks)).toBe(false);
  });

  it("accepts a workspace-wide custom status for any project", async () => {
    const { service, inserted } = serviceWith({ statuses: [{ projectId: null }] });
    await service.create({ ...createInput, projectId: PROJECT_ID, customStatusId: STATUS_ID });
    const taskInsert = inserted.find((entry) => entry.table === tasks)?.values as {
      readonly customStatusId: string;
    };
    expect(taskInsert.customStatusId).toBe(STATUS_ID);
  });

  it("conceals a note whose project disagrees with the requested project", async () => {
    const { service, inserted } = serviceWith({
      noteRows: [{ id: NOTE_ID, projectId: OTHER_PROJECT_ID, isDeleted: false }],
    });
    const error = await apiRejection(
      service.create({ ...createInput, noteId: NOTE_ID, projectId: PROJECT_ID }),
    );
    expect(error.getStatus()).toBe(404);
    expect(inserted.some((row) => row.table === tasks)).toBe(false);
  });
});

describe("TasksService deletion", () => {
  it("hard-deletes and reports the cascaded subtree size", async () => {
    const { service, deletes } = serviceWith({
      subtree: [
        { id: TASK_ID, parentId: null },
        { id: OTHER_TASK_ID, parentId: TASK_ID },
        { id: MISSING_TASK_ID, parentId: OTHER_TASK_ID },
      ],
    });
    const result = await service.remove({
      principal,
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
    });
    expect(result).toEqual({ id: TASK_ID, deleted: true, affected: 3 });
    expect(deletes.map((entry) => entry.table)).toContain(tasks);
  });

  /**
   * The confirmation a user sees names the tasks they selected. The self-FK
   * cascade destroys their descendants too, and `DELETE ... RETURNING` never
   * reports those, so a batch that reported only `updated.length` would
   * understate the damage by the whole subtree.
   */
  it("reports the cascaded blast radius of a bulk delete, not just the named ids", async () => {
    const { service } = serviceWith({
      subtree: [
        { id: TASK_ID, parentId: null },
        { id: OTHER_TASK_ID, parentId: TASK_ID },
        { id: MISSING_TASK_ID, parentId: OTHER_TASK_ID },
      ],
    });
    const result = await service.bulk({
      principal,
      workspaceId: WORKSPACE_ID,
      taskIds: [TASK_ID],
      action: { kind: "delete" },
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(result.updated).toEqual([TASK_ID]);
    expect(result.affected).toBe(3);
  });

  it("counts a bulk non-delete as exactly the tasks it named", async () => {
    const { service } = serviceWith();
    const result = await service.bulk({
      principal,
      workspaceId: WORKSPACE_ID,
      taskIds: [TASK_ID, OTHER_TASK_ID],
      action: { kind: "priority", priority: "high" },
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(result.affected).toBe(2);
  });
});

describe("TasksService tenant isolation", () => {
  /**
   * Every read and every mutation must carry the workspace predicate. The
   * assertion is on the RENDERED predicate, so removing `whereWorkspace` from
   * any one of these paths fails here rather than passing silently.
   */
  it("scopes every task read and mutation to the active workspace", async () => {
    const { service, reads, updates, deletes } = serviceWith({
      siblings: [
        { id: TASK_ID, sortOrder: 1 },
        { id: OTHER_TASK_ID, sortOrder: 2 },
      ],
      subtree: [{ id: TASK_ID, parentId: null }],
    });
    await service.read({ principal, workspaceId: WORKSPACE_ID, taskId: TASK_ID });
    await service.update({
      principal,
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      title: "Renamed",
    });
    await service.reorder({
      principal,
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      beforeTaskId: OTHER_TASK_ID,
    });
    await service.remove({ principal, workspaceId: WORKSPACE_ID, taskId: TASK_ID });
    await service.bulk({
      principal,
      workspaceId: WORKSPACE_ID,
      taskIds: [TASK_ID],
      action: { kind: "delete" },
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    const taskReads = reads.filter((entry) => entry.table === tasks);
    expect(taskReads.length).toBeGreaterThan(0);
    for (const entry of taskReads) expect(scopesToWorkspace(entry.predicate, tasks)).toBe(true);

    const taskUpdates = updates.filter((entry) => entry.table === tasks);
    expect(taskUpdates.length).toBeGreaterThan(0);
    for (const entry of taskUpdates) expect(scopesToWorkspace(entry.predicate, tasks)).toBe(true);

    const taskDeletes = deletes.filter((entry) => entry.table === tasks);
    expect(taskDeletes.length).toBeGreaterThan(0);
    for (const entry of taskDeletes) expect(scopesToWorkspace(entry.predicate, tasks)).toBe(true);
  });

  it("opens every task mutation as serializable", async () => {
    const { service, isolationLevels } = serviceWith({
      subtree: [{ id: TASK_ID, parentId: null }],
    });
    await service.remove({ principal, workspaceId: WORKSPACE_ID, taskId: TASK_ID });
    expect(isolationLevels).toEqual(["serializable"]);
  });

  it("fails the scope assertion for an id-only predicate, so the check is not vacuous", () => {
    expect(scopesToWorkspace(eq(tasks.id, TASK_ID), tasks)).toBe(false);
    expect(scopesToWorkspace(undefined, tasks)).toBe(false);
  });
});
