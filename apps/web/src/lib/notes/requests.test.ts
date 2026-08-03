import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WORKSPACE_MEMBER_MAX_PAGES,
  createNote,
  moveNote,
  requestAllWorkspaceMembers,
  updateNote,
} from "./requests";

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

  function member(index: number) {
    const id = `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    return {
      id,
      userId: id,
      workspaceId,
      name: `Member ${index}`,
      email: `member${index}@example.test`,
      role: "editor" as const,
      joinedAt: "2026-08-01T00:00:00.000Z",
    };
  }

  function memberPageResponse(page: number, count: number, hasMore: boolean): Response {
    return new Response(
      JSON.stringify({
        items: Array.from({ length: count }, (_unused, index) => member(page * 1_000 + index)),
        page,
        limit: 100,
        hasMore,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  it("unions every workspace member page so no member is invisible to a client filter", async () => {
    fetchMock
      .mockResolvedValueOnce(memberPageResponse(1, 100, true))
      .mockResolvedValueOnce(memberPageResponse(2, 100, true))
      .mockResolvedValueOnce(memberPageResponse(3, 50, false));

    const result = await requestAllWorkspaceMembers(workspaceId);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the member listing to succeed");
    expect(result.data.items).toHaveLength(250);
    // The 180th member — invisible while only page 1 was requested.
    expect(result.data.items[179]?.name).toBe("Member 2079");
    expect(result.data.hasMore).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining("page=1&limit=100"),
      expect.stringContaining("page=2&limit=100"),
      expect.stringContaining("page=3&limit=100"),
    ]);
  });

  it("stops at the page bound and reports the truncation rather than hiding it", async () => {
    // A fresh `Response` per call: a body may only be read once, so reusing one
    // instance would fail the second page for the wrong reason.
    let requested = 0;
    fetchMock.mockImplementation(() => {
      requested += 1;
      return Promise.resolve(memberPageResponse(requested, 100, true));
    });

    const result = await requestAllWorkspaceMembers(workspaceId);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the member listing to succeed");
    expect(fetchMock).toHaveBeenCalledTimes(WORKSPACE_MEMBER_MAX_PAGES);
    expect(result.data.hasMore).toBe(true);
  });

  it("fails the whole listing when a later page fails, never returning a partial directory", async () => {
    fetchMock
      .mockResolvedValueOnce(memberPageResponse(1, 100, true))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));

    await expect(requestAllWorkspaceMembers(workspaceId)).resolves.toEqual({
      ok: false,
      kind: "unavailable",
    });
  });

  it("never requests a member page for an invalid workspace id", async () => {
    await expect(requestAllWorkspaceMembers("not-a-uuid")).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
