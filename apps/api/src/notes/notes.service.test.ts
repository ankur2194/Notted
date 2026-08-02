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
