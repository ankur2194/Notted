import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNote, moveNote, updateNote } from "./requests";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const noteId = "30000000-0000-4000-8000-000000000002";

describe("note requests", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses the caller's stable idempotency key and never sends contentPlain", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          note: {
            id: noteId,
            workspaceId,
            location: "workspace-root",
            projectId: null,
            folderId: null,
            parentId: null,
            title: "A",
            type: "document",
            pageSize: "a4",
            sortOrder: 1,
            isTemplate: false,
            isPinned: false,
            isArchived: false,
            isDeleted: false,
            tagIds: [],
            version: 1,
            deletedAt: null,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
            content: { type: "doc", content: [] },
            contentPlain: "",
            createdById: noteId,
            updatedById: noteId,
            currentActorId: noteId,
            capabilities: { canUpdate: true, canDelete: true, canShare: true },
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    await createNote(workspaceId, { title: "A" }, "stable-note-submission");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("stable-note-submission");
    expect(String(init?.body)).not.toContain("contentPlain");
  });

  it.each([
    [400, null, "invalid"],
    [403, null, "forbidden-or-not-found"],
    [404, null, "forbidden-or-not-found"],
    [409, { code: "VERSION_CONFLICT" }, "version-conflict"],
    [409, { code: "ORDER_CONFLICT" }, "conflict"],
    [503, null, "unavailable"],
  ] as const)("maps %s failures to an exact rollback category", async (status, body, kind) => {
    fetchMock.mockResolvedValue(
      new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      updateNote(workspaceId, noteId, { expectedVersion: 1, title: "B" }),
    ).resolves.toEqual({ ok: false, kind });
  });

  it("rejects incomplete move selectors before the network boundary", async () => {
    const result = await moveNote(workspaceId, noteId, {
      expectedVersion: 1,
      projectId: null,
      folderId: null,
    } as never);
    expect(result).toEqual({ ok: false, kind: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
