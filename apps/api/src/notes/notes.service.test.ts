import { eq, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { AuthorizationDeniedError } from "../authorization/authorization.errors";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { notes, taskStatuses } from "../database/schema";
import { createTenantContext, TenantContextService } from "../tenant";

import { NoteVersionsService } from "./note-versions.service";
import { NotesService } from "./notes.service";

import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { DatabaseService } from "../database/database.service";
import type { NoteSearchIndexProducer } from "../search/note-search-index-producer";
import type { NoteDocument } from "@notted/shared-types";

const principal = Object.freeze({
  userId: "10000000-0000-4000-8000-000000000001",
  sessionId: "session",
  method: "opaque-session" as const,
  assurance: "single-factor" as const,
  authenticatedAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-08-02T00:00:00.000Z",
  isFresh: true,
});
const workspaceId = "10000000-0000-4000-8000-000000000002";
const noteId = "10000000-0000-4000-8000-000000000003";
const projectId = "10000000-0000-4000-8000-000000000004";
const parentId = "10000000-0000-4000-8000-000000000005";
const otherProjectId = "10000000-0000-4000-8000-000000000007";
const columnId = "10000000-0000-4000-8000-000000000008";
const descendantId = "10000000-0000-4000-8000-000000000009";

/** Database that fails loudly on any access, proving authorization ran first. */
function forbiddenDatabase(): unknown {
  return new Proxy(
    {},
    {
      get: () => {
        throw new Error("SQL must not run");
      },
    },
  );
}

const copyInput = Object.freeze({
  principal,
  workspaceId,
  noteId,
  asTemplate: false,
  includeTags: true,
  projectId: null,
  folderId: null,
  parentId: null,
  idempotencyKey: "note-copy-key-0001",
});

/**
 * No-op stub for the {@link NoteSearchIndexProducer}. Existing unit tests
 * assert policy, ordering, and projection behavior; they verify the
 * producer's contract separately in
 * `search/note-search-index-producer.test.ts`. The stub keeps these suites
 * focused without exercising the producer wiring on every assertion.
 */
function noOpSearchIndexProducer(): NoteSearchIndexProducer {
  return {
    scheduleSearchSync: vi.fn().mockResolvedValue(undefined),
  } as unknown as NoteSearchIndexProducer;
}

/**
 * No-op stub for {@link NoteVersionsService}. Existing unit tests assert
 * policy, ordering, and projection behavior; the Part 55 snapshot writes are
 * verified in the dedicated `note-versions.service.test.ts` and in the new
 * snapshot-specific tests below. The stub keeps existing suites focused
 * without re-running the snapshot insert on every assertion.
 */
function noOpNoteVersionsService(): NoteVersionsService {
  return {
    recordAcceptedState: vi.fn().mockResolvedValue(undefined),
  } as unknown as NoteVersionsService;
}

describe("NotesService policy and safe behavior", () => {
  it("authorizes before any SQL for detail reads", async () => {
    const denial = new Error("concealed");
    const authorizeUser = vi.fn().mockRejectedValue(denial);
    const db = new Proxy(
      {},
      {
        get: () => {
          throw new Error("SQL must not run");
        },
      },
    );
    const service = new NotesService(
      { db } as unknown as DatabaseService,
      { authorizeUser } as unknown as AuthorizationEntryService,
      {} as TenantContextService,
      noOpSearchIndexProducer(),
      noOpNoteVersionsService(),
    );
    await expect(service.read({ principal, workspaceId, noteId })).rejects.toBe(denial);
    expect(authorizeUser).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "note.read",
        workspaceId,
        resource: { kind: "note", id: noteId },
      }),
    );
  });

  it("writes no snapshot when update authorization is denied", async () => {
    const denial = new Error("concealed");
    const versions = noOpNoteVersionsService();
    const transaction = vi.fn();
    const service = new NotesService(
      { transaction } as unknown as DatabaseService,
      { authorizeUser: vi.fn().mockRejectedValue(denial) } as unknown as AuthorizationEntryService,
      {} as TenantContextService,
      noOpSearchIndexProducer(),
      versions,
    );
    await expect(
      service.update({ principal, workspaceId, noteId, expectedVersion: 1, title: "Denied" }),
    ).rejects.toBe(denial);
    expect(transaction).not.toHaveBeenCalled();
    expect(versions.recordAcceptedState).not.toHaveBeenCalled();
  });

  it("proves both source edit and destination create authority before move SQL", async () => {
    const denial = new Error("destination denied");
    const authorizeUser = vi
      .fn()
      .mockResolvedValueOnce({ workspaceId, userId: principal.userId })
      .mockRejectedValueOnce(denial);
    const transaction = vi.fn();
    const versions = noOpNoteVersionsService();
    const service = new NotesService(
      { transaction } as unknown as DatabaseService,
      { authorizeUser } as unknown as AuthorizationEntryService,
      {} as TenantContextService,
      noOpSearchIndexProducer(),
      versions,
    );
    await expect(
      service.move({
        principal,
        workspaceId,
        noteId,
        expectedVersion: 1,
        projectId: "10000000-0000-4000-8000-000000000004",
        folderId: null,
        parentId: null,
      }),
    ).rejects.toBe(denial);
    expect(authorizeUser.mock.calls.map(([value]) => value.action)).toEqual([
      "note.update",
      "note.create",
    ]);
    expect(transaction).not.toHaveBeenCalled();
    expect(versions.recordAcceptedState).not.toHaveBeenCalled();
  });

  it("proves source read then destination create authority before any copy SQL", async () => {
    const denial = new Error("destination denied");
    const authorizeUser = vi
      .fn()
      .mockResolvedValueOnce({ workspaceId, userId: principal.userId })
      .mockRejectedValueOnce(denial);
    const transaction = vi.fn();
    const service = new NotesService(
      { db: forbiddenDatabase(), transaction } as unknown as DatabaseService,
      { authorizeUser } as unknown as AuthorizationEntryService,
      {} as TenantContextService,
      noOpSearchIndexProducer(),
      noOpNoteVersionsService(),
    );
    await expect(service.copy(copyInput)).rejects.toBe(denial);
    expect(authorizeUser.mock.calls.map(([value]) => value)).toEqual([
      expect.objectContaining({ action: "note.read", resource: { kind: "note", id: noteId } }),
      expect.objectContaining({ action: "note.create", resource: { kind: "workspace" } }),
    ]);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("names the copy destination container as the note.create resource", async () => {
    const cases = [
      [
        { projectId, parentId: null },
        { kind: "project", id: projectId },
      ],
      [
        { projectId, parentId },
        { kind: "note", id: parentId },
      ],
    ] as const;
    for (const [container, resource] of cases) {
      const denial = new Error("destination denied");
      const authorizeUser = vi
        .fn()
        .mockResolvedValueOnce({ workspaceId, userId: principal.userId })
        .mockRejectedValueOnce(denial);
      const transaction = vi.fn();
      const service = new NotesService(
        { db: forbiddenDatabase(), transaction } as unknown as DatabaseService,
        { authorizeUser } as unknown as AuthorizationEntryService,
        {} as TenantContextService,
        noOpSearchIndexProducer(),
        noOpNoteVersionsService(),
      );
      await expect(service.copy({ ...copyInput, ...container })).rejects.toBe(denial);
      expect(authorizeUser.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({ action: "note.create", resource }),
      );
      expect(transaction).not.toHaveBeenCalled();
    }
  });

  it("inserts a copy carrying the requested template flag and no link to its source", async () => {
    const source = {
      id: noteId,
      workspaceId,
      projectId: null,
      folderId: null,
      parentId: null,
      title: "Weekly review",
      content: { type: "doc", content: [{ type: "paragraph" }] },
      contentPlain: "Weekly review body",
      checklistDone: 2,
      checklistTotal: 5,
      noteType: "document",
      isTemplate: false,
      isPinned: true,
      isArchived: true,
      isDeleted: false,
      pageSize: "letter",
      version: 7,
    };
    const inserts: { values: Record<string, unknown> }[] = [];
    const producer = noOpSearchIndexProducer();
    const versions = noOpNoteVersionsService();
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: () => {
        const builder = {
          from: () => builder,
          where: () => builder,
          limit: () => Promise.resolve([]),
        };
        return builder;
      },
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserts.push({ values });
          return Promise.resolve();
        },
      }),
    };
    const service = new NotesService(
      {
        transaction: (run: (value: unknown) => Promise<unknown>) => run(tx),
      } as unknown as DatabaseService,
      {
        authorizeUser: vi.fn().mockResolvedValue({ workspaceId, userId: principal.userId }),
        run: (_operation: unknown, run: () => Promise<unknown>) => run(),
      } as unknown as AuthorizationEntryService,
      { get: () => ({ workspaceId }) } as unknown as TenantContextService,
      producer,
      versions,
    );
    // Only the insert under test stays real; the surrounding helpers have their
    // own coverage and would otherwise need the whole query builder faked.
    const readRow = vi.fn().mockResolvedValue(source);
    const loadTagIds = vi.fn().mockResolvedValue(["10000000-0000-4000-8000-000000000006"]);
    const replaceTags = vi.fn().mockResolvedValue(undefined);
    Object.assign(service, {
      readRow,
      loadTagIds,
      replaceTags,
      positionFor: vi.fn().mockResolvedValue(42),
      recordMutation: vi.fn().mockResolvedValue(undefined),
      toDetail: vi.fn().mockResolvedValue({ id: "copy" }),
    });

    await service.copy({ ...copyInput, asTemplate: true, title: "Weekly review template" });

    const values = inserts[0]?.values ?? {};
    expect(values).toMatchObject({
      workspaceId,
      title: "Weekly review template",
      content: source.content,
      contentPlain: source.contentPlain,
      // Carried across, not recomputed: the copy holds the same document, so a
      // second derivation could only ever disagree with the original.
      checklistDone: 2,
      checklistTotal: 5,
      noteType: "document",
      pageSize: "letter",
      isTemplate: true,
      isPinned: false,
      isArchived: false,
      sortOrder: 42,
      createdById: principal.userId,
      updatedById: principal.userId,
    });
    expect(values.id).not.toBe(noteId);
    // The exact key set is the evidence: no source/template-origin column
    // exists, so a copy can never stay live-linked to its original.
    expect(Object.keys(values).sort()).toEqual([
      "checklistDone",
      "checklistTotal",
      "content",
      "contentPlain",
      "createdById",
      "folderId",
      "id",
      "isArchived",
      "isPinned",
      "isTemplate",
      "noteType",
      "pageSize",
      "parentId",
      "projectId",
      "sortOrder",
      "title",
      "updatedById",
      "workspaceId",
    ]);
    expect(loadTagIds).toHaveBeenCalledWith(tx, noteId);
    expect(replaceTags).toHaveBeenCalledWith(tx, values.id, [
      "10000000-0000-4000-8000-000000000006",
    ]);
    expect(producer.scheduleSearchSync).toHaveBeenCalledWith(
      tx,
      workspaceId,
      [values.id],
      expect.objectContaining({ mutation: "note.created" }),
    );
    expect(versions.recordAcceptedState).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        version: 1,
        title: "Weekly review template",
        content: source.content,
        contentPlain: source.contentPlain,
        createdById: principal.userId,
      }),
    );
  });

  it("uses explicit transport/database note type mapping", () => {
    const service = new NotesService(
      {} as DatabaseService,
      {} as AuthorizationEntryService,
      {} as TenantContextService,
      noOpSearchIndexProducer(),
      noOpNoteVersionsService(),
    );
    expect(service["toDatabaseType"]("task-list")).toBe("task");
    expect(service["fromDatabaseType"]("task")).toBe("task-list");
    expect(service["toDatabaseType"]("document")).toBe("document");
  });

  it("uses safe version and hierarchy errors without identifiers or content", () => {
    const service = new NotesService(
      {} as DatabaseService,
      {} as AuthorizationEntryService,
      {} as TenantContextService,
      noOpSearchIndexProducer(),
      noOpNoteVersionsService(),
    );
    for (const invoke of [
      () => service["versionConflict"](),
      () => service["invalidMove"](),
      () => service["invalidFolder"](),
    ]) {
      let caught: unknown;
      try {
        invoke();
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBeDefined();
      expect(JSON.stringify(caught)).not.toContain(noteId);
      expect(JSON.stringify(caught)).not.toContain("document body");
    }
  });
});

describe("NotesService checklist projection and progress", () => {
  const taskItem = (checked: boolean, text: string) => ({
    type: "taskItem",
    attrs: { checked },
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
  const checklistDocument: NoteDocument = {
    type: "doc",
    content: [{ type: "taskList", content: [taskItem(true, "A"), taskItem(false, "B")] }],
  };

  function bareService(): NotesService {
    return new NotesService(
      {} as DatabaseService,
      {} as AuthorizationEntryService,
      {} as TenantContextService,
      noOpSearchIndexProducer(),
      noOpNoteVersionsService(),
    );
  }

  /**
   * One projection, so `content_plain` and the two counters can only be written
   * together. A writer that computed the plain text by hand would be the drift
   * this test exists to prevent.
   */
  it("derives the plain text and both checklist counters from one call", () => {
    expect(bareService()["contentProjection"](checklistDocument)).toEqual({
      contentPlain: "A\nB",
      checklistDone: 1,
      checklistTotal: 2,
    });
  });

  it("reports zero counters for a document with no checklist", () => {
    expect(
      bareService()["contentProjection"]({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Plain" }] }],
      } as NoteDocument),
    ).toEqual({ contentPlain: "Plain", checklistDone: 0, checklistTotal: 0 });
  });

  /** Two currencies, never merged: an inline checkbox is not a task row. */
  it("splits summary progress into stored checklist counters and queried task counts", () => {
    const summary = bareService()["toSummary"](
      {
        id: noteId,
        workspaceId,
        projectId: null,
        folderId: null,
        parentId: null,
        boardColumnId: null,
        title: "Weekly review",
        content: checklistDocument,
        contentPlain: "A\nB",
        checklistDone: 1,
        checklistTotal: 2,
        noteType: "document" as const,
        isTemplate: false,
        isPinned: false,
        isArchived: false,
        isDeleted: false,
        deletedAt: null,
        deletionBatchId: null,
        version: 1,
        pageSize: "a4",
        sortOrder: 1,
        createdById: principal.userId,
        updatedById: null,
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
      [],
      { done: 3, total: 4 },
    );
    expect(summary.progress).toEqual({
      checklist: { done: 1, total: 2 },
      tasks: { done: 3, total: 4 },
    });
  });

  it("writes the counters alongside content_plain when a note is created", async () => {
    const inserts: { values: Record<string, unknown> }[] = [];
    const producer = noOpSearchIndexProducer();
    const versions = noOpNoteVersionsService();
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: () => {
        const builder = {
          from: () => builder,
          where: () => builder,
          limit: () => Promise.resolve([]),
        };
        return builder;
      },
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserts.push({ values });
          return Promise.resolve();
        },
      }),
    };
    const service = new NotesService(
      {
        transaction: (run: (value: unknown) => Promise<unknown>) => run(tx),
      } as unknown as DatabaseService,
      {
        authorizeUser: vi.fn().mockResolvedValue({ workspaceId, userId: principal.userId }),
        run: (_operation: unknown, run: () => Promise<unknown>) => run(),
      } as unknown as AuthorizationEntryService,
      { get: () => ({ workspaceId }) } as unknown as TenantContextService,
      producer,
      versions,
    );
    Object.assign(service, {
      validateContainer: vi.fn().mockResolvedValue(undefined),
      assertTags: vi.fn().mockResolvedValue(undefined),
      lockSiblingGroups: vi.fn().mockResolvedValue(undefined),
      positionFor: vi.fn().mockResolvedValue(1),
      replaceTags: vi.fn().mockResolvedValue(undefined),
      recordMutation: vi.fn().mockResolvedValue(undefined),
      readRow: vi.fn().mockResolvedValue({ id: "row" }),
      toDetail: vi.fn().mockResolvedValue({ id: "row" }),
    });

    await service.create({
      principal,
      workspaceId,
      projectId: null,
      folderId: null,
      parentId: null,
      title: "Weekly review",
      type: "document",
      pageSize: "a4",
      isTemplate: false,
      isPinned: false,
      isArchived: false,
      tagIds: [],
      content: checklistDocument,
      idempotencyKey: "note-create-key-0001",
    });

    expect(inserts[0]?.values).toMatchObject({
      contentPlain: "A\nB",
      checklistDone: 1,
      checklistTotal: 2,
    });
    expect(producer.scheduleSearchSync).toHaveBeenCalledWith(
      tx,
      workspaceId,
      [expect.any(String)],
      expect.objectContaining({ mutation: "note.created" }),
    );
    expect(versions.recordAcceptedState).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ version: 1, title: "Weekly review", content: checklistDocument }),
    );
  });

  it("rewrites the counters whenever an update replaces the content", async () => {
    const changeSets: Record<string, unknown>[] = [];
    const producer = noOpSearchIndexProducer();
    const versions = noOpNoteVersionsService();
    const tx = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          changeSets.push(values);
          const node = {
            where: () => node,
            returning: () =>
              Promise.resolve([
                {
                  ...baseNoteRow,
                  ...values,
                  title: "Accepted title",
                  content: checklistDocument,
                  contentPlain: "A\nB",
                  version: 5,
                },
              ]),
          };
          return node;
        },
      }),
    };
    const service = new NotesService(
      {
        transaction: (run: (value: unknown) => Promise<unknown>) => run(tx),
      } as unknown as DatabaseService,
      {
        authorizeUser: vi.fn().mockResolvedValue({ workspaceId, userId: principal.userId }),
        run: (_operation: unknown, run: () => Promise<unknown>) => run(),
      } as unknown as AuthorizationEntryService,
      { get: () => ({ workspaceId }) } as unknown as TenantContextService,
      producer,
      versions,
    );
    Object.assign(service, {
      readRow: vi.fn().mockResolvedValue({ id: noteId, isDeleted: false }),
      recordMutation: vi.fn().mockResolvedValue(undefined),
      toDetail: vi.fn().mockResolvedValue({ id: noteId }),
    });

    await service.update({
      principal,
      workspaceId,
      noteId,
      expectedVersion: 1,
      content: checklistDocument,
    });

    expect(changeSets[0]).toMatchObject({
      contentPlain: "A\nB",
      checklistDone: 1,
      checklistTotal: 2,
    });
    expect(producer.scheduleSearchSync).toHaveBeenCalledWith(
      tx,
      workspaceId,
      [noteId],
      expect.objectContaining({ mutation: "note.updated" }),
    );
    expect(versions.recordAcceptedState).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        noteId,
        version: 5,
        title: "Accepted title",
        content: checklistDocument,
        contentPlain: "A\nB",
      }),
    );
  });

  it("leaves the counters untouched when an update does not carry content", async () => {
    const changeSets: Record<string, unknown>[] = [];
    const versions = noOpNoteVersionsService();
    const tx = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          changeSets.push(values);
          const node = {
            where: () => node,
            returning: () =>
              Promise.resolve([{ ...baseNoteRow, ...values, title: "Renamed", version: 5 }]),
          };
          return node;
        },
      }),
    };
    const service = new NotesService(
      {
        transaction: (run: (value: unknown) => Promise<unknown>) => run(tx),
      } as unknown as DatabaseService,
      {
        authorizeUser: vi.fn().mockResolvedValue({ workspaceId, userId: principal.userId }),
        run: (_operation: unknown, run: () => Promise<unknown>) => run(),
      } as unknown as AuthorizationEntryService,
      { get: () => ({ workspaceId }) } as unknown as TenantContextService,
      noOpSearchIndexProducer(),
      versions,
    );
    Object.assign(service, {
      readRow: vi.fn().mockResolvedValue({ id: noteId, isDeleted: false }),
      recordMutation: vi.fn().mockResolvedValue(undefined),
      toDetail: vi.fn().mockResolvedValue({ id: noteId }),
    });

    await service.update({ principal, workspaceId, noteId, expectedVersion: 1, title: "Renamed" });

    expect(changeSets[0]).not.toHaveProperty("checklistDone");
    expect(changeSets[0]).not.toHaveProperty("contentPlain");
    expect(versions.recordAcceptedState).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ version: 5, title: "Renamed", content: baseNoteRow.content }),
    );
  });

  it("writes no snapshot or side-effect intent after a stale CAS loses", async () => {
    const versions = noOpNoteVersionsService();
    const producer = noOpSearchIndexProducer();
    const tx = {
      update: () => ({
        set: () => {
          const node = { where: () => node, returning: () => Promise.resolve([]) };
          return node;
        },
      }),
    };
    const service = new NotesService(
      {
        transaction: (run: (value: unknown) => Promise<unknown>) => run(tx),
      } as unknown as DatabaseService,
      {
        authorizeUser: vi.fn().mockResolvedValue({ workspaceId, userId: principal.userId }),
        run: (_operation: unknown, run: () => Promise<unknown>) => run(),
      } as unknown as AuthorizationEntryService,
      { get: () => ({ workspaceId }) } as unknown as TenantContextService,
      producer,
      versions,
    );
    Object.assign(service, {
      readRow: vi
        .fn()
        .mockResolvedValueOnce({ ...baseNoteRow, isDeleted: false })
        .mockResolvedValueOnce({ ...baseNoteRow, version: 6 }),
    });
    await expect(
      service.update({ principal, workspaceId, noteId, expectedVersion: 4, pageSize: "letter" }),
    ).rejects.toBeInstanceOf(ApiHttpException);
    expect(versions.recordAcceptedState).not.toHaveBeenCalled();
    expect(producer.scheduleSearchSync).not.toHaveBeenCalled();
  });

  it("aborts accepted update side effects when snapshot persistence fails", async () => {
    const snapshotFailure = new Error("snapshot failed");
    const versions = {
      recordAcceptedState: vi.fn().mockRejectedValue(snapshotFailure),
    } as unknown as NoteVersionsService;
    const producer = noOpSearchIndexProducer();
    const tx = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          const node = {
            where: () => node,
            returning: () => Promise.resolve([{ ...baseNoteRow, ...values, version: 5 }]),
          };
          return node;
        },
      }),
    };
    const service = new NotesService(
      {
        transaction: (run: (value: unknown) => Promise<unknown>) => run(tx),
      } as unknown as DatabaseService,
      {
        authorizeUser: vi.fn().mockResolvedValue({ workspaceId, userId: principal.userId }),
        run: (_operation: unknown, run: () => Promise<unknown>) => run(),
      } as unknown as AuthorizationEntryService,
      { get: () => ({ workspaceId }) } as unknown as TenantContextService,
      producer,
      versions,
    );
    Object.assign(service, {
      readRow: vi.fn().mockResolvedValue({ ...baseNoteRow, isDeleted: false }),
      recordMutation: vi.fn(),
    });
    await expect(
      service.update({ principal, workspaceId, noteId, expectedVersion: 4, pageSize: "letter" }),
    ).rejects.toBe(snapshotFailure);
    expect(service["recordMutation"]).not.toHaveBeenCalled();
    expect(producer.scheduleSearchSync).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------- //
// Part 49.1 — note board column on move
// --------------------------------------------------------------------------- //

const dialect = new PgDialect();

/**
 * True when a captured predicate really constrains `table` to the active
 * workspace. The fake database enforces nothing, so this is the only thing
 * standing between the suite and a silent tenant-isolation regression:
 * dropping `whereWorkspace(taskStatuses, …)` from the board-column lookup
 * would otherwise leave every test green while another tenant's column became
 * assignable to this workspace's notes. Rendering the SQL asserts the
 * predicate itself, not merely that one exists.
 */
function scopesToWorkspace(predicate: unknown, table: { readonly workspaceId: unknown }): boolean {
  if (predicate === undefined || predicate === null) return false;
  const column = dialect.sqlToQuery(sql`${table.workspaceId}`).sql;
  const rendered = dialect.sqlToQuery(predicate as SQL);
  return rendered.sql.includes(`${column} =`) && rendered.params.includes(workspaceId);
}

interface Statement {
  readonly table: unknown;
  readonly values?: Record<string, unknown>;
  predicate?: unknown;
}

const baseNoteRow = Object.freeze({
  id: noteId,
  workspaceId,
  projectId: null as string | null,
  folderId: null as string | null,
  parentId: null as string | null,
  boardColumnId: null as string | null,
  title: "Weekly review",
  content: { type: "doc", content: [] },
  contentPlain: "",
  checklistDone: 0,
  checklistTotal: 0,
  noteType: "document" as const,
  isTemplate: false,
  isPinned: false,
  isArchived: false,
  isDeleted: false,
  deletedAt: null,
  deletionBatchId: null,
  version: 4,
  pageSize: "a4",
  sortOrder: 1,
  createdById: principal.userId,
  updatedById: null,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
});

interface MoveFixture {
  /** Overrides on the row `readRow` returns for the note being moved. */
  readonly source?: Partial<typeof baseNoteRow>;
  /** What the workspace-scoped `task_statuses` lookup finds, if anything. */
  readonly column?: { readonly projectId: string | null };
  /** Descendants `noteSubtreeIds` reports below the moved note. */
  readonly descendantIds?: readonly string[];
}

/**
 * Hand-rolled chainable fake keyed by table identity, recording every `where`
 * predicate. Only the code under test stays real — the surrounding placement
 * helpers have their own coverage and would otherwise need the whole query
 * builder faked.
 */
function moveService(fixture: MoveFixture = {}) {
  const tenant = new TenantContextService();
  const source = { ...baseNoteRow, ...fixture.source };
  const columnRows = fixture.column === undefined ? [] : [fixture.column];
  const reads: Statement[] = [];
  const updates: Statement[] = [];

  const tx = {
    select: () => ({
      from: (table: unknown) => {
        const node: Record<string, unknown> = {
          where: (predicate: unknown) => {
            reads.push({ table, predicate });
            return node;
          },
          limit: () => Promise.resolve(table === taskStatuses ? [...columnRows] : []),
        };
        return node;
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
          // The row PostgreSQL would return: the fake applies the change set,
          // and `version` is the one column the database computes itself.
          returning: () => Promise.resolve([{ ...source, ...values, version: source.version + 1 }]),
          // The descendant update is awaited on `where` and never returns rows.
          then: (onFulfilled: (value: unknown) => unknown) =>
            Promise.resolve(undefined).then(onFulfilled),
        };
        return node;
      },
    }),
  };

  const authorizeUser = vi.fn().mockResolvedValue({ workspaceId, userId: principal.userId });
  const positionFor = vi.fn().mockResolvedValue(5);
  const producer = noOpSearchIndexProducer();
  const versions = noOpNoteVersionsService();
  const service = new NotesService(
    {
      db: {},
      transaction: (work: (value: unknown) => Promise<unknown>) => work(tx),
    } as unknown as DatabaseService,
    {
      authorizeUser,
      run: <T>(operation: { workspaceId: string; userId: string | null }, work: () => T): T =>
        tenant.run(
          createTenantContext({ workspaceId: operation.workspaceId, userId: operation.userId }),
          work,
        ),
    } as unknown as AuthorizationEntryService,
    tenant,
    producer,
    versions,
  );
  Object.assign(service, {
    readRow: vi.fn().mockResolvedValue(source),
    validateContainer: vi.fn().mockResolvedValue(undefined),
    assertNoNoteCycle: vi.fn().mockResolvedValue(undefined),
    lockSiblingGroups: vi.fn().mockResolvedValue(undefined),
    noteSubtreeIds: vi.fn().mockResolvedValue([noteId, ...(fixture.descendantIds ?? [])]),
    positionFor,
    recordMutation: vi.fn().mockResolvedValue(undefined),
    loadTagIds: vi.fn().mockResolvedValue([]),
    loadTaskProgress: vi.fn().mockResolvedValue({ done: 0, total: 0 }),
  });
  return { service, source, reads, updates, authorizeUser, positionFor, producer, versions };
}

function moveInput(overrides: Record<string, unknown> = {}) {
  return {
    principal,
    workspaceId,
    noteId,
    expectedVersion: baseNoteRow.version,
    projectId: null,
    folderId: null,
    parentId: null,
    ...overrides,
  } as Parameters<NotesService["move"]>[0];
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

describe("NotesService.move board column", () => {
  it("adds a search intent for the moved root and every affected descendant", async () => {
    const descendants = [descendantId, "10000000-0000-4000-8000-000000000010"];
    const { service, producer, versions } = moveService({ descendantIds: descendants });
    await service.move(moveInput());
    expect(producer.scheduleSearchSync).toHaveBeenCalledWith(
      expect.anything(),
      workspaceId,
      [noteId, ...descendants],
      expect.objectContaining({ mutation: "note.moved" }),
    );
    expect(versions.recordAcceptedState).not.toHaveBeenCalled();
  });

  it("accepts a workspace-wide column for any destination", async () => {
    const { service, updates } = moveService({ column: { projectId: null } });
    const result = await service.move(moveInput({ projectId, boardColumnId: columnId }));
    expect(result.note.boardColumnId).toBe(columnId);
    expect(updates[0]?.values).toMatchObject({ boardColumnId: columnId });
  });

  it("accepts a project-scoped column for its own project", async () => {
    const { service } = moveService({ column: { projectId } });
    const result = await service.move(moveInput({ projectId, boardColumnId: columnId }));
    expect(result.note.boardColumnId).toBe(columnId);
  });

  const foreignColumnCases: readonly [string, MoveFixture["column"]][] = [
    ["a column scoped to a different project", { projectId: otherProjectId }],
    ["an unknown or other-tenant column", undefined],
  ];

  /**
   * 404, never 403: the workspace-scoped read finds nothing for a foreign
   * tenant's column and a mismatched project answers identically, so the move
   * endpoint cannot be used as an existence oracle for either.
   */
  it.each(foreignColumnCases)("answers %s with 404 and writes nothing", async (_name, column) => {
    const { service, updates } = moveService({ column });
    const error = await apiRejection(
      service.move(moveInput({ projectId, boardColumnId: columnId })),
    );
    expect(error.getStatus()).toBe(404);
    expect(error.getStatus()).not.toBe(403);
    expect(error.safeResponse.code).toBe("NOT_FOUND");
    expect(JSON.stringify(error.safeResponse)).not.toContain(columnId);
    expect(updates).toHaveLength(0);
  });

  /**
   * A hierarchy change must never fail because of an orthogonal axis: the note
   * moves and its stranded project-scoped column clears to "No column", which
   * the returned summary states so the UI can announce it.
   */
  it("clears a stranded project-scoped column on a cross-project move instead of failing", async () => {
    const { service, updates } = moveService({
      source: { projectId, boardColumnId: columnId },
      column: { projectId },
    });
    const result = await service.move(moveInput({ projectId: otherProjectId }));
    expect(result.note.boardColumnId).toBeNull();
    expect(updates[0]?.values).toMatchObject({ boardColumnId: null });
  });

  it("keeps a workspace-wide column across a cross-project move", async () => {
    const { service } = moveService({
      source: { projectId, boardColumnId: columnId },
      column: { projectId: null },
    });
    const result = await service.move(moveInput({ projectId: otherProjectId }));
    expect(result.note.boardColumnId).toBe(columnId);
  });

  it("keeps the current column when the field is omitted and the project is unchanged", async () => {
    const { service, reads } = moveService({
      source: { projectId, boardColumnId: columnId },
    });
    const result = await service.move(moveInput({ projectId }));
    expect(result.note.boardColumnId).toBe(columnId);
    // No lookup at all: nothing can strand a column that is not moving project.
    expect(reads.filter((entry) => entry.table === taskStatuses)).toHaveLength(0);
  });

  /**
   * The board column is not inherited, so a column-only change touches exactly
   * one row: no descendant UPDATE and no descendant re-authorization. Widening
   * `containerChanges` to include it would silently bump a whole subtree.
   */
  it("bumps only the moved row by one version for a column-only change", async () => {
    const { service, updates, authorizeUser } = moveService({
      source: { projectId, boardColumnId: null },
      column: { projectId: null },
      descendantIds: [descendantId],
    });
    const result = await service.move(moveInput({ projectId, boardColumnId: columnId }));
    expect(updates).toHaveLength(1);
    expect(updates[0]?.table).toBe(notes);
    expect(dialect.sqlToQuery(updates[0]?.values?.version as SQL).sql).toContain("+ 1");
    expect(result.note.version).toBe(baseNoteRow.version + 1);
    // Source edit and destination create only — no descendant `note.update`.
    expect(authorizeUser).toHaveBeenCalledTimes(2);
  });

  it("leaves beforeNoteId anchoring untouched when a column is supplied", async () => {
    const { service, positionFor } = moveService({ column: { projectId: null } });
    const beforeNoteId = parentId;
    await service.move(moveInput({ projectId, boardColumnId: columnId, beforeNoteId }));
    expect(positionFor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ beforeNoteId }),
      beforeNoteId,
      noteId,
    );
  });

  it("scopes every board-column lookup to the active workspace", async () => {
    const { service, reads } = moveService({ column: { projectId: null } });
    await service.move(moveInput({ projectId, boardColumnId: columnId }));
    const columnReads = reads.filter((entry) => entry.table === taskStatuses);
    expect(columnReads.length).toBeGreaterThan(0);
    for (const entry of columnReads)
      expect(scopesToWorkspace(entry.predicate, taskStatuses)).toBe(true);
  });

  /**
   * Negative control. Without it `scopesToWorkspace` could be trivially true
   * and the assertion above would be worthless.
   */
  it("rejects a predicate that names only the column identifier", () => {
    expect(scopesToWorkspace(eq(taskStatuses.id, columnId), taskStatuses)).toBe(false);
    expect(scopesToWorkspace(undefined, taskStatuses)).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// Part 58 — restore reconciles the persisted Yjs authority
// --------------------------------------------------------------------------- //

describe("NotesService.restoreVersion collaborative reconciliation", () => {
  const restoredDocument = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Restored" }] }],
  } as NoteDocument;

  it("resets the Yjs generation inside the same transaction as the notes write", async () => {
    const versions = noOpNoteVersionsService();
    const collaboration = { resetToDocument: vi.fn().mockResolvedValue(undefined) };
    const order: string[] = [];
    const tx = {
      select: () => {
        const builder = {
          from: () => builder,
          where: () => builder,
          for: () => builder,
          limit: () => Promise.resolve([{ ...baseNoteRow, isDeleted: false, version: 5 }]),
        };
        return builder;
      },
      update: () => ({
        set: (values: Record<string, unknown>) => {
          order.push("notes.update");
          const node = {
            where: () => node,
            returning: () =>
              Promise.resolve([
                { ...baseNoteRow, ...values, content: restoredDocument, version: 6 },
              ]),
          };
          return node;
        },
      }),
    };
    const service = new NotesService(
      {
        transaction: (run: (value: unknown) => Promise<unknown>) => run(tx),
      } as unknown as DatabaseService,
      {
        authorizeUser: vi.fn().mockResolvedValue({ workspaceId, userId: principal.userId }),
        run: (_operation: unknown, run: () => Promise<unknown>) => run(),
      } as unknown as AuthorizationEntryService,
      { get: () => ({ workspaceId }) } as unknown as TenantContextService,
      noOpSearchIndexProducer(),
      versions,
      undefined,
      collaboration as never,
    );
    Object.assign(service, {
      assertVersion: vi.fn(),
      readVersionRow: vi
        .fn()
        .mockResolvedValue({ version: 2, latestCheckpointVersion: 6, title: "Old" }),
      migrateHistoricalContent: vi.fn().mockReturnValue(restoredDocument),
      recordMutation: vi.fn().mockImplementation(() => {
        order.push("recordMutation");
        return Promise.resolve();
      }),
      toDetail: vi.fn().mockResolvedValue({ id: noteId }),
      toVersionSummary: vi.fn().mockReturnValue({ version: 2 }),
      versionSummaryForVersion: vi.fn().mockResolvedValue({ version: 6 }),
    });
    collaboration.resetToDocument.mockImplementation(() => {
      order.push("resetToDocument");
      return Promise.resolve();
    });

    await service.restoreVersion({
      principal,
      workspaceId,
      noteId,
      versionId: "20000000-0000-4000-8000-000000000001",
      expectedVersion: 5,
    });

    // One write authority: the restored projection becomes the new Yjs epoch in
    // the SAME transaction that wrote it, before any side-effect intent.
    expect(collaboration.resetToDocument).toHaveBeenCalledWith(tx, {
      noteId,
      workspaceId,
      document: restoredDocument,
      noteVersion: 6,
      actorId: principal.userId,
    });
    expect(order).toEqual(["notes.update", "resetToDocument", "recordMutation"]);
    expect(versions.recordAcceptedState).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ version: 6 }),
    );
  });
});

describe("NotesService detail capabilities", () => {
  function denial(): AuthorizationDeniedError {
    return new AuthorizationDeniedError({
      allowed: false,
      code: "forbidden",
      httpStatus: 403,
      safeMessage: "concealed",
      audit: {},
    } as unknown as AuthorizationDeniedError["decision"]);
  }

  /** Builds a detail-only harness whose policy answer is driven per action. */
  function detailService(allows: (action: string) => boolean): NotesService {
    const service = new NotesService(
      {} as DatabaseService,
      {
        authorizeUser: vi.fn(({ action }: { action: string }) =>
          allows(action)
            ? Promise.resolve({ workspaceId, userId: principal.userId })
            : Promise.reject(denial()),
        ),
      } as unknown as AuthorizationEntryService,
      {} as TenantContextService,
      noOpSearchIndexProducer(),
      noOpNoteVersionsService(),
    );
    Object.assign(service, {
      loadTagIds: vi.fn().mockResolvedValue([]),
      loadTaskProgress: vi.fn().mockResolvedValue({ done: 0, total: 0 }),
      toSummary: () => ({ id: noteId }),
    });
    return service;
  }

  const row = {
    id: noteId,
    content: { type: "doc", content: [] },
    contentPlain: "",
    createdById: principal.userId,
    updatedById: null,
  };

  // A workspace VIEWER can export a note it can read but cannot edit it, so
  // `canExport` must come from the `export.create` policy on its own and never
  // be aliased to `canUpdate` the way `canShare` is.
  it("reports canExport from the export.create policy, independent of canUpdate", async () => {
    const service = detailService((action) => action === "export.create");

    const detail = await service["toDetail"](row as never, { principal, workspaceId, noteId });

    expect(detail.capabilities).toEqual({
      canUpdate: false,
      canDelete: false,
      canShare: false,
      canExport: true,
    });
  });

  it("reports canExport false when the export.create policy denies, without throwing", async () => {
    const service = detailService((action) => action !== "export.create");

    const detail = await service["toDetail"](row as never, { principal, workspaceId, noteId });

    expect(detail.capabilities).toEqual({
      canUpdate: true,
      canDelete: true,
      canShare: true,
      canExport: false,
    });
  });
});
