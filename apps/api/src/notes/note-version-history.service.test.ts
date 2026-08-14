import { describe, expect, it, vi } from "vitest";

import { NotesService } from "./notes.service";

const principal = {
  userId: "00000000-0000-4000-8000-000000000001",
  sessionId: "session",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const workspaceId = "00000000-0000-4000-8000-000000000002";
const noteId = "00000000-0000-4000-8000-000000000003";

function service(authorizeUser = vi.fn().mockRejectedValue(new Error("concealed"))) {
  const database = { db: { select: vi.fn() }, transaction: vi.fn() };
  const authorization = {
    authorizeUser,
    run: vi.fn((_operation: unknown, work: () => unknown) => work()),
  };
  return {
    database,
    authorization,
    notes: new NotesService(
      database as never,
      authorization as never,
      { get: () => ({ workspaceId }) } as never,
      { scheduleSearchSync: vi.fn() } as never,
      { recordAcceptedState: vi.fn() } as never,
      { scheduleGeneration: vi.fn() } as never,
    ),
  };
}

describe("NotesService version history", () => {
  it.each([
    ["listVersions", "note.read"],
    ["readVersion", "note.read"],
    ["restoreVersion", "note.update"],
  ] as const)(
    "authorizes %s with %s before SQL and conceals denied tenants",
    async (method, action) => {
      const fixture = service();
      const input = {
        principal,
        workspaceId,
        noteId,
        versionId: "00000000-0000-4000-8000-000000000004",
        expectedVersion: 2,
        limit: 20,
      };

      await expect(fixture.notes[method](input as never)).rejects.toThrow("concealed");
      expect(fixture.authorization.authorizeUser).toHaveBeenCalledWith(
        expect.objectContaining({ action, workspaceId }),
      );
      expect(fixture.database.db.select).not.toHaveBeenCalled();
      expect(fixture.database.transaction).not.toHaveBeenCalled();
    },
  );

  it("keeps restore side effects inside one serializable transaction and orders durable intents", async () => {
    const authorizeUser = vi.fn().mockResolvedValue({ workspaceId });
    const fixture = service(authorizeUser);
    fixture.database.transaction.mockImplementation(
      async (work: (tx: unknown) => unknown, options: unknown) => {
        expect(options).toEqual({ isolationLevel: "serializable" });
        return work({});
      },
    );
    Object.assign(fixture.notes, {
      readVersionRow: vi.fn().mockRejectedValue(new Error("historical migration failed")),
    });

    await expect(
      fixture.notes.restoreVersion({
        principal,
        workspaceId,
        noteId,
        versionId: "00000000-0000-4000-8000-000000000004",
        expectedVersion: 2,
      } as never),
    ).rejects.toThrow();
    expect(fixture.database.transaction).toHaveBeenCalledOnce();
  });
});
