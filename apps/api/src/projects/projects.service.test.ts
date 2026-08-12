import { describe, expect, it, vi } from "vitest";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import {
  apiIdempotencyRecords,
  attachments,
  auditLogs,
  jobOutbox,
  notes,
  projects,
  tasks,
  workspaceMembers,
} from "../database/schema";
import { createTenantContext, TenantContextService } from "../tenant";

import { PROJECT_AUDIT_ACTIONS, PROJECT_DOMAIN_EVENTS } from "./projects.constants";
import { ProjectsService } from "./projects.service";

import type { NoteSearchIndexProducer } from "../search/note-search-index-producer";
import type { AuthenticatedPrincipal, ProjectStatus } from "@notted/shared-types";

const userId = "20000000-0000-4000-8000-000000000001";
const workspaceId = "20000000-0000-4000-8100-000000000001";
const projectId = "20000000-0000-4000-8200-000000000001";

/**
 * No-op stub for the {@link NoteSearchIndexProducer}. Project-service tests
 * assert project lifecycle, authorization, and projection behavior; the
 * producer's contract is covered separately in
 * `search/note-search-index-producer.test.ts` and a dedicated Part 51.3 test
 * for project-delete fan-out below.
 */
function noOpSearchIndexProducer(): NoteSearchIndexProducer {
  return {
    scheduleSearchSync: vi.fn().mockResolvedValue(undefined),
  } as unknown as NoteSearchIndexProducer;
}

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

function entry(tenant: TenantContextService) {
  const authorizeUser = vi.fn().mockResolvedValue({ workspaceId, userId });
  return {
    value: {
      authorizeUser,
      run: <T>(_operation: unknown, work: () => T): T =>
        tenant.run(createTenantContext({ workspaceId, userId }), work),
    } as unknown as AuthorizationEntryService,
    authorizeUser,
  };
}

function row(status: ProjectStatus = "active") {
  const now = new Date("2026-08-01T00:00:00Z");
  return {
    id: projectId,
    workspaceId,
    name: "Alpha",
    description: null,
    coverImageUrl: null,
    color: "#3b82f6",
    status,
    dueDate: null,
    isArchived: status === "archived",
    isRestricted: true,
    createdById: userId,
    createdAt: now,
    updatedAt: now,
  };
}

describe("ProjectsService (unit)", () => {
  it("keeps status and isArchived mirrored for archive, complete, and restore", async () => {
    for (const [method, expectedStatus, expectedAudit, expectedEvent] of [
      ["archive", "archived", PROJECT_AUDIT_ACTIONS.archive, PROJECT_DOMAIN_EVENTS.archive],
      ["complete", "completed", PROJECT_AUDIT_ACTIONS.complete, PROJECT_DOMAIN_EVENTS.complete],
      ["restore", "active", PROJECT_AUDIT_ACTIONS.restore, PROJECT_DOMAIN_EVENTS.restore],
    ] as const) {
      const tenant = new TenantContextService();
      const authorized = entry(tenant);
      let currentStatus: ProjectStatus = "active";
      const inserted: { table: unknown; value: Record<string, unknown> }[] = [];
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({ limit: () => Promise.resolve([row(currentStatus)]) }),
          }),
        }),
        update: () => ({
          set: (value: { status: ProjectStatus; isArchived: boolean }) => ({
            where: () => {
              currentStatus = value.status;
              expect(value.isArchived).toBe(value.status === "archived");
              return Promise.resolve();
            },
          }),
        }),
        insert: (table: unknown) => ({
          values: (value: Record<string, unknown>) => {
            inserted.push({ table, value });
            return Promise.resolve();
          },
        }),
      };
      const database = {
        transaction: <T>(work: (scope: typeof tx) => Promise<T>) => work(tx),
      } as unknown as DatabaseService;
      const service = new ProjectsService(
        database,
        authorized.value,
        tenant,
        noOpSearchIndexProducer(),
      );
      const result = await service[method]({ principal: principal(), workspaceId, projectId });
      expect(result.project.status).toBe(expectedStatus);
      expect(result.project.isArchived).toBe(expectedStatus === "archived");
      expect(inserted.find((value) => value.table === auditLogs)?.value.action).toBe(expectedAudit);
      expect(inserted.find((value) => value.table === jobOutbox)?.value.jobType).toBe(
        expectedEvent,
      );
    }
  });

  it("nullifies scoped note and task links before audit/outbox and project deletion", async () => {
    const tenant = new TenantContextService();
    const authorized = entry(tenant);
    const operations: string[] = [];
    const tx = {
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([row()]) }) }),
      }),
      update: (table: unknown) => ({
        set: (value: { projectId: null }) => ({
          where: () => {
            expect(value.projectId).toBeNull();
            operations.push(table === notes ? "nullify:notes" : "nullify:tasks");
            return Promise.resolve();
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: (value: { action?: string; jobType?: string }) => {
          operations.push(
            table === auditLogs ? `audit:${value.action}` : `outbox:${value.jobType}`,
          );
          return Promise.resolve();
        },
      }),
      delete: (table: unknown) => ({
        where: () => ({
          returning: () => {
            expect(table).toBe(projects);
            operations.push("delete:project");
            return Promise.resolve([{ id: projectId }]);
          },
        }),
      }),
    };
    const service = new ProjectsService(
      {
        transaction: <T>(work: (scope: typeof tx) => Promise<T>) => work(tx),
      } as unknown as DatabaseService,
      authorized.value,
      tenant,
      noOpSearchIndexProducer(),
    );
    await expect(
      service.delete({ principal: principal(), workspaceId, projectId }),
    ).resolves.toEqual({
      id: projectId,
      deleted: true,
    });
    expect(operations).toEqual([
      "nullify:notes",
      "nullify:tasks",
      `audit:${PROJECT_AUDIT_ACTIONS.delete}`,
      `outbox:${PROJECT_DOMAIN_EVENTS.delete}`,
      "delete:project",
    ]);
  });

  it("authorizes before any read and preserves concealed denials", async () => {
    const tenant = new TenantContextService();
    const select = vi.fn();
    const authorizeUser = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("concealed"), { decision: { allowed: false, httpStatus: 404 } }),
      );
    const service = new ProjectsService(
      { db: { select } } as unknown as DatabaseService,
      { authorizeUser } as unknown as AuthorizationEntryService,
      tenant,
      noOpSearchIndexProducer(),
    );
    await expect(
      service.read({ principal: principal(), workspaceId, projectId }),
    ).rejects.toMatchObject({
      decision: { httpStatus: 404 },
    });
    expect(authorizeUser).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        action: "project.read",
        resource: { kind: "project", id: projectId },
      }),
    );
    expect(select).not.toHaveBeenCalled();
  });

  it("projects scoped activity, combined task and checklist progress, and only authorized active members", async () => {
    const tenant = new TenantContextService();
    const authorized = entry(tenant);
    const noteUpdated = new Date("2026-08-02T00:00:00Z");
    const taskUpdated = new Date("2026-08-03T00:00:00Z");
    const queriedTables: unknown[] = [];
    const db = {
      select: () => ({
        from: (table: unknown) => {
          queriedTables.push(table);
          if (table === projects) {
            return { where: () => ({ limit: () => Promise.resolve([row()]) }) };
          }
          if (table === notes) {
            return {
              where: () =>
                Promise.resolve([
                  { lastActivityAt: noteUpdated, checklistDone: 1, checklistTotal: 4 },
                ]),
            };
          }
          if (table === tasks) {
            return {
              where: () =>
                Promise.resolve([{ lastActivityAt: taskUpdated, completed: 2, total: 3 }]),
            };
          }
          if (table === workspaceMembers) {
            return {
              innerJoin: () => ({
                leftJoin: () => ({
                  where: () => ({
                    orderBy: () =>
                      Promise.resolve([
                        {
                          userId,
                          name: "Workspace Owner",
                          avatarUrl: null,
                          workspaceRole: "owner",
                          projectRole: null,
                        },
                        {
                          userId: "20000000-0000-4000-8000-000000000002",
                          name: "Project Editor",
                          avatarUrl: null,
                          workspaceRole: "editor",
                          projectRole: "editor",
                        },
                      ]),
                  }),
                }),
              }),
            };
          }
          throw new Error("Unexpected table");
        },
      }),
    };
    const service = new ProjectsService(
      { db } as unknown as DatabaseService,
      authorized.value,
      tenant,
      noOpSearchIndexProducer(),
    );

    const detail = await service.read({ principal: principal(), workspaceId, projectId });

    expect(detail.lastActivityAt).toBe(taskUpdated.toISOString());
    // Task rows (2 of 3) plus inline checklist items (1 of 4) in one bar. The
    // two halves come from the shared aggregates in `sql-aggregates`, so this
    // rollup cannot define "done" differently from a note's own progress.
    expect(detail.taskProgress).toEqual({
      coverage: "tasks-and-checklists",
      completed: 3,
      total: 7,
    });
    expect(detail.members).toEqual([
      expect.objectContaining({
        name: "Workspace Owner",
        accessSource: "workspace-admin",
        projectRole: null,
      }),
      expect.objectContaining({
        name: "Project Editor",
        accessSource: "project",
        projectRole: "editor",
      }),
    ]);
    expect(queriedTables).toEqual([projects, notes, tasks, projects, workspaceMembers]);
  });

  it("requires a ready cover attachment in the active workspace", async () => {
    const tenant = new TenantContextService();
    const service = new ProjectsService(
      {} as DatabaseService,
      {} as AuthorizationEntryService,
      tenant,
      noOpSearchIndexProducer(),
    );
    const coverId = "20000000-0000-4000-8900-000000000001";
    const queriedTables: unknown[] = [];
    const readyTx = {
      select: () => ({
        from: (table: unknown) => {
          queriedTables.push(table);
          return { where: () => ({ limit: () => Promise.resolve([{ id: coverId }]) }) };
        },
      }),
    } as unknown as DatabaseTransaction;
    const internal = service as unknown as {
      assertCoverAttachmentReady(
        tx: DatabaseTransaction,
        coverImageUrl: string | null | undefined,
      ): Promise<void>;
    };

    await tenant.run(createTenantContext({ workspaceId, userId }), () =>
      internal.assertCoverAttachmentReady(readyTx, `/api/v1/attachments/${coverId}`),
    );
    expect(queriedTables).toEqual([attachments]);

    const missingTx = {
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
      }),
    } as unknown as DatabaseTransaction;
    await expect(
      tenant.run(createTenantContext({ workspaceId, userId }), () =>
        internal.assertCoverAttachmentReady(missingTx, `/api/v1/attachments/${coverId}`),
      ),
    ).rejects.toMatchObject({ safeResponse: { code: "NOT_FOUND" } });
    await expect(
      tenant.run(createTenantContext({ workspaceId, userId }), () =>
        internal.assertCoverAttachmentReady(readyTx, "https://cdn.example.test/cover.png"),
      ),
    ).rejects.toMatchObject({ safeResponse: { code: "VALIDATION_ERROR" } });
  });

  it("rolls back the business insert when audit/outbox persistence fails", async () => {
    const tenant = new TenantContextService();
    const authorized = entry(tenant);
    const committed: unknown[] = [];
    const database = {
      transaction: async <T>(work: (scope: unknown) => Promise<T>): Promise<T> => {
        const provisional: unknown[] = [];
        const tx = {
          execute: () => Promise.resolve(),
          insert: (table: unknown) => ({
            values: (value: unknown) => {
              if (table === jobOutbox) return Promise.reject(new Error("outbox unavailable"));
              provisional.push({ table, value });
              return Promise.resolve();
            },
          }),
          select: () => ({
            from: (table: unknown) => ({
              where: () => ({
                limit: () =>
                  table === apiIdempotencyRecords ? Promise.resolve([]) : Promise.resolve([row()]),
              }),
            }),
          }),
        };
        try {
          const result = await work(tx);
          committed.push(...provisional);
          return result;
        } catch (error: unknown) {
          provisional.length = 0;
          throw error;
        }
      },
    };
    const service = new ProjectsService(
      database as unknown as DatabaseService,
      authorized.value,
      tenant,
      noOpSearchIndexProducer(),
    );
    await expect(
      service.create({ principal: principal(), workspaceId, name: "Alpha" }),
    ).rejects.toThrow("outbox unavailable");
    expect(committed).toEqual([]);
  });
});

// --------------------------------------------------------------------------- //
// Part 51.3 — search-index sync fan-out on project delete
// --------------------------------------------------------------------------- //

describe("ProjectsService Part 51.3 search-index sync fan-out", () => {
  /**
   * Project delete nullifies `notes.project_id` for every linked note. The
   * indexed `projectId` filter field changes for every one of them, so each
   * affected note must re-sync. The IDs are captured BEFORE the nullify
   * update; the producer is invoked inside the same transaction.
   */
  it("schedules a search sync covering every note whose projectId was nulled", async () => {
    const tenant = new TenantContextService();
    const authorized = entry(tenant);
    const affectedNoteIds = [
      "20000000-0000-4000-8000-000000000010",
      "20000000-0000-4000-8000-000000000011",
      "20000000-0000-4000-8000-000000000012",
    ];
    const producer = {
      scheduleSearchSync: vi.fn().mockResolvedValue(undefined),
    } as unknown as NoteSearchIndexProducer;
    const selectCalls: { readonly table: unknown; readonly predicate: unknown }[] = [];
    const tx = {
      select: (fields: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: (predicate: unknown) => {
            // Capture the note-id lookup BEFORE the nullify update.
            if (table === notes && "id" in fields) {
              selectCalls.push({ table, predicate });
              return Promise.resolve(affectedNoteIds.map((id) => ({ id })));
            }
            return { limit: () => Promise.resolve([row()]) };
          },
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => Promise.resolve(),
        }),
      }),
      insert: () => ({
        values: () => Promise.resolve(),
      }),
      delete: (table: unknown) => ({
        where: () => ({
          returning: () => {
            expect(table).toBe(projects);
            return Promise.resolve([{ id: projectId }]);
          },
        }),
      }),
    };
    const service = new ProjectsService(
      {
        transaction: <T>(work: (scope: typeof tx) => Promise<T>) => work(tx),
      } as unknown as DatabaseService,
      authorized.value,
      tenant,
      producer,
    );

    await service.delete({ principal: principal(), workspaceId, projectId });

    // Exactly one producer call, in the same transaction, covering every
    // affected note id. The producer handles chunking internally; the service
    // passes the full list.
    expect(producer.scheduleSearchSync).toHaveBeenCalledTimes(1);
    const [txArg, workspaceArg, idsArg, optionsArg] = (
      producer.scheduleSearchSync as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0] as unknown as readonly [
      unknown,
      string,
      readonly string[],
      { readonly actorId: string; readonly mutation: string },
    ];
    expect(txArg).toBe(tx);
    expect(workspaceArg).toBe(workspaceId);
    expect(idsArg).toEqual(affectedNoteIds);
    expect(optionsArg.actorId).toBe(userId);
    expect(optionsArg.mutation).toBe(PROJECT_DOMAIN_EVENTS.delete);
  });

  it("skips the producer call when no notes are linked to the project", async () => {
    const tenant = new TenantContextService();
    const authorized = entry(tenant);
    const producer = {
      scheduleSearchSync: vi.fn().mockResolvedValue(undefined),
    } as unknown as NoteSearchIndexProducer;
    const tx = {
      select: (fields: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === notes && "id" in fields) return Promise.resolve([]);
            return { limit: () => Promise.resolve([row()]) };
          },
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => Promise.resolve(),
        }),
      }),
      insert: () => ({
        values: () => Promise.resolve(),
      }),
      delete: () => ({
        where: () => ({
          returning: () => Promise.resolve([{ id: projectId }]),
        }),
      }),
    };
    const service = new ProjectsService(
      {
        transaction: <T>(work: (scope: typeof tx) => Promise<T>) => work(tx),
      } as unknown as DatabaseService,
      authorized.value,
      tenant,
      producer,
    );

    await service.delete({ principal: principal(), workspaceId, projectId });

    expect(producer.scheduleSearchSync).not.toHaveBeenCalled();
  });
});
