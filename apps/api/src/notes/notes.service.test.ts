import { describe, expect, it, vi } from "vitest";

import { NotesService } from "./notes.service";

import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { DatabaseService } from "../database/database.service";
import type { TenantContextService } from "../tenant";

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

  it("proves both source edit and destination create authority before move SQL", async () => {
    const denial = new Error("destination denied");
    const authorizeUser = vi
      .fn()
      .mockResolvedValueOnce({ workspaceId, userId: principal.userId })
      .mockRejectedValueOnce(denial);
    const transaction = vi.fn();
    const service = new NotesService(
      { transaction } as unknown as DatabaseService,
      { authorizeUser } as unknown as AuthorizationEntryService,
      {} as TenantContextService,
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
      noteType: "document",
      isTemplate: false,
      isPinned: true,
      isArchived: true,
      isDeleted: false,
      pageSize: "letter",
      version: 7,
    };
    const inserts: { values: Record<string, unknown> }[] = [];
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
  });

  it("uses explicit transport/database note type mapping", () => {
    const service = new NotesService(
      {} as DatabaseService,
      {} as AuthorizationEntryService,
      {} as TenantContextService,
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
    );
    for (const invoke of [
      () => service["versionConflict"](),
      () => service["invalidMove"](),
      () => service["invalidFolder"](),
    ]) {
      try {
        invoke();
      } catch (error: unknown) {
        expect(JSON.stringify(error)).not.toContain(noteId);
        expect(JSON.stringify(error)).not.toContain("document body");
      }
    }
  });
});
