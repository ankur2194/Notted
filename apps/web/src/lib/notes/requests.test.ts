import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WORKSPACE_MEMBER_MAX_PAGES,
  createFolder,
  createNote,
  deleteFolder,
  moveNote,
  permanentlyDeleteNote,
  requestAllWorkspaceMembers,
  requestFolders,
  requestNotePage,
  requestNoteShares,
  requestWorkspaceMembers,
  restoreNote,
  revokeNoteShare,
  trashNote,
  updateFolder,
  updateNote,
  upsertNoteShare,
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

  // The fourth column is Part 39's retryability hint. It is deliberately absent
  // for the kinds that describe the request itself: repeating those unchanged
  // would fail identically forever, so autosave must not loop on them.
  it.each([
    [400, null, "invalid", undefined],
    [403, null, "forbidden-or-not-found", undefined],
    [404, null, "forbidden-or-not-found", undefined],
    [409, { code: "VERSION_CONFLICT" }, "version-conflict", undefined],
    [409, { code: "ORDER_CONFLICT" }, "conflict", undefined],
    [405, null, "unavailable", false],
    [429, null, "unavailable", true],
    [500, null, "unavailable", true],
    [503, null, "unavailable", true],
  ] as const)(
    "maps %s failures to an exact rollback category",
    async (status, body, kind, retryable) => {
      fetchMock.mockResolvedValue(
        new Response(body === null ? null : JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await expect(
        updateNote(workspaceId, noteId, { expectedVersion: 1, title: "B" }),
      ).resolves.toEqual({ ok: false, kind, retryable });
    },
  );

  it.each([
    ["2", 2_000],
    ["0", 0],
    ["-1", undefined],
    ["not a number", undefined],
  ] as const)("reads a Retry-After of %s as %s ms", async (header, retryAfterMs) => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 429, headers: { "Retry-After": header } }),
    );
    await expect(
      updateNote(workspaceId, noteId, { expectedVersion: 1, title: "B" }),
    ).resolves.toEqual({ ok: false, kind: "unavailable", retryable: true, retryAfterMs });
  });

  it("clamps an absurd Retry-After rather than stalling a client indefinitely", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 503, headers: { "Retry-After": "99999" } }),
    );
    const result = await updateNote(workspaceId, noteId, { expectedVersion: 1, title: "B" });
    expect(result).toEqual({
      ok: false,
      kind: "unavailable",
      retryable: true,
      retryAfterMs: 300_000,
    });
  });

  it("sends a navigation flush as keepalive, with no abort timer to cancel it", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    await updateNote(workspaceId, noteId, { expectedVersion: 1, title: "B" }, { keepalive: true });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.keepalive).toBe(true);
    // An abort timer scheduled on a page that is going away either never fires
    // or cancels the very request the flush exists to deliver.
    expect(init?.signal).toBeUndefined();
    // `sendBeacon` is not used: it cannot carry the JSON content type and the
    // credentialed same-site request the API's trusted-origin check needs.
    expect(init?.credentials).toBe("include");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
  });

  it("falls back to an ordinary request when the body exceeds the keepalive limit", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    await updateNote(
      workspaceId,
      noteId,
      {
        expectedVersion: 1,
        content: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "x".repeat(19_000) }] },
            { type: "paragraph", content: [{ type: "text", text: "y".repeat(19_000) }] },
            { type: "paragraph", content: [{ type: "text", text: "z".repeat(19_000) }] },
            { type: "paragraph", content: [{ type: "text", text: "w".repeat(19_000) }] },
          ],
        },
      },
      { keepalive: true },
    );

    // The fetch specification rejects a keepalive body over 64 KiB outright, so
    // a large note flushes as a normal request instead of vanishing.
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.keepalive).toBeUndefined();
    expect(init?.signal).toBeDefined();
  });

  it("does not mark an ordinary request as keepalive", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    await updateNote(workspaceId, noteId, { expectedVersion: 1, title: "B" });
    expect(fetchMock.mock.calls[0]?.[1]?.keepalive).toBeUndefined();
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
      retryable: true,
    });
  });

  it("never requests a member page for an invalid workspace id", async () => {
    await expect(requestAllWorkspaceMembers("not-a-uuid")).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN] as const)(
    "refuses the non-positive-integer member page %s",
    async (page) => {
      await expect(requestWorkspaceMembers(workspaceId, page)).resolves.toEqual({
        ok: false,
        kind: "invalid",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

const folderId = "30000000-0000-4000-8000-000000000003";
const userId = "30000000-0000-4000-8000-000000000004";

const folder = {
  id: folderId,
  workspaceId,
  parentId: null,
  name: "Specifications",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const grant = {
  id: "30000000-0000-4000-8000-000000000005",
  noteId,
  userId,
  permission: "edit" as const,
  createdAt: "2026-08-01T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("note list, trash, and folder requests", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  const listQuery = {
    page: 1,
    limit: 25,
    scope: "workspace-root",
    view: "normal",
    sortBy: "updatedAt",
    sortDirection: "desc",
  } as const;

  it("serializes only the list selectors that were supplied", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], page: 1, limit: 25, hasMore: false }));

    await expect(requestNotePage(workspaceId, listQuery)).resolves.toEqual({
      ok: true,
      data: { items: [], page: 1, limit: 25, hasMore: false },
    });

    const params = new URL(String(fetchMock.mock.calls[0]![0]), "https://api.test").searchParams;
    expect(Object.fromEntries(params.entries())).toEqual({
      page: "1",
      limit: "25",
      scope: "workspace-root",
      view: "normal",
      sortBy: "updatedAt",
      sortDirection: "desc",
    });
  });

  it("includes the optional project, folder, and type selectors", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], page: 1, limit: 25, hasMore: false }));

    await requestNotePage(workspaceId, {
      ...listQuery,
      scope: "project",
      projectId: folderId,
      folderId: noteId,
      type: "task-list",
    });

    const params = new URL(String(fetchMock.mock.calls[0]![0]), "https://api.test").searchParams;
    expect(params.get("projectId")).toBe(folderId);
    expect(params.get("folderId")).toBe(noteId);
    expect(params.get("type")).toBe("task-list");
  });

  /**
   * Regression: callers hold the schema's *output*, where the explicit boolean
   * selectors are real booleans and the optional id selectors may be `null` —
   * `parseNoteSearchParams` returns exactly that and the page components pass
   * it straight through. Re-validating it against the schema's query-string
   * *input* contract used to reject the whole query, so the archived view
   * failed closed and rendered empty without ever issuing a request.
   */
  it("accepts the parsed query shape its own callers produce", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], page: 1, limit: 25, hasMore: false }));

    await expect(
      requestNotePage(workspaceId, {
        ...listQuery,
        folderId: null,
        parentId: null,
        isArchived: true,
      }),
    ).resolves.toMatchObject({ ok: true });

    const params = new URL(String(fetchMock.mock.calls[0]![0]), "https://api.test").searchParams;
    expect(params.get("isArchived")).toBe("true");
    expect(params.has("folderId")).toBe(false);
  });

  it("rejects an out-of-contract list query before the network boundary", async () => {
    await expect(
      requestNotePage(workspaceId, { ...listQuery, limit: 5_000 }),
    ).resolves.toMatchObject({ ok: false, kind: "invalid" });
    await expect(requestNotePage("not-a-uuid", listQuery)).resolves.toMatchObject({
      ok: false,
      kind: "invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a note page whose items do not match the contract", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [{ id: noteId }], page: 1, limit: 25 }));

    await expect(requestNotePage(workspaceId, listQuery)).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
  });

  /**
   * Every destructive note mutation carries `expectedVersion`, so a stale tab
   * loses the race instead of overwriting a newer edit. The client refuses to
   * send the request at all when that field is missing.
   */
  it.each([
    ["trashNote", (input: unknown) => trashNote(workspaceId, noteId, input as never), "DELETE"],
    ["restoreNote", (input: unknown) => restoreNote(workspaceId, noteId, input as never), "POST"],
  ])(
    "sends %s with its expected version and refuses without one",
    async (_name, invoke, method) => {
      await expect(invoke({})).resolves.toEqual({ ok: false, kind: "invalid" });
      expect(fetchMock).not.toHaveBeenCalled();

      fetchMock.mockResolvedValue(
        jsonResponse({
          id: noteId,
          ...(method === "DELETE"
            ? { deleted: true, affected: 1, version: 2, deletedAt: "2026-08-01T00:00:00.000Z" }
            : { restored: true, affected: 1, version: 3 }),
        }),
      );

      await expect(invoke({ expectedVersion: 1 })).resolves.toMatchObject({ ok: true });
      expect(fetchMock.mock.calls[0]![1]?.method).toBe(method);
      expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ expectedVersion: 1 });
    },
  );

  /**
   * Permanent deletion is unrecoverable, so the contract demands the exact
   * title alongside an explicit confirmation. A caller that supplies only the
   * version never reaches the network.
   */
  it("requires confirmation and the exact title to permanently delete", async () => {
    await expect(
      permanentlyDeleteNote(workspaceId, noteId, { expectedVersion: 1 } as never),
    ).resolves.toEqual({ ok: false, kind: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(jsonResponse({ id: noteId, permanentlyDeleted: true }));

    await expect(
      permanentlyDeleteNote(workspaceId, noteId, {
        expectedVersion: 1,
        confirm: true,
        expectedTitle: "Quarterly plan",
      }),
    ).resolves.toEqual({ ok: true, data: { id: noteId, permanentlyDeleted: true } });
  });

  it("rejects note mutations whose route ids are not UUIDs", async () => {
    await expect(trashNote(workspaceId, "forged", { expectedVersion: 1 })).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    await expect(restoreNote("forged", noteId, { expectedVersion: 1 })).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests folders with a bounded page size", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ items: [folder], page: 1, limit: 100, hasMore: false }),
    );

    await expect(requestFolders(workspaceId)).resolves.toEqual({
      ok: true,
      data: { items: [folder], page: 1, limit: 100, hasMore: false },
    });
    expect(String(fetchMock.mock.calls[0]![0])).toContain("page=1&limit=100");
  });

  it("refuses a folder listing for an invalid workspace id", async () => {
    await expect(requestFolders("not-a-uuid")).resolves.toEqual({ ok: false, kind: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a folder and rejects an empty name", async () => {
    await expect(createFolder(workspaceId, { name: "" })).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(jsonResponse({ folder }));

    await expect(createFolder(workspaceId, { name: folder.name })).resolves.toEqual({
      ok: true,
      data: { folder },
    });
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("POST");
  });

  it("requires at least one changed field to update a folder", async () => {
    await expect(updateFolder(workspaceId, folderId, {})).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(jsonResponse({ folder }));

    await expect(updateFolder(workspaceId, folderId, { name: "Renamed" })).resolves.toEqual({
      ok: true,
      data: { folder },
    });
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("PATCH");
  });

  it("always sends an explicit confirmation when deleting a folder", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: folderId, deleted: true, removedFolders: 2, unfiledNotes: 5 }),
    );

    await expect(deleteFolder(workspaceId, folderId)).resolves.toEqual({
      ok: true,
      data: { id: folderId, deleted: true, removedFolders: 2, unfiledNotes: 5 },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ confirm: true });
  });

  it("refuses a folder deletion for a malformed folder id", async () => {
    await expect(deleteFolder(workspaceId, "forged")).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("note sharing requests", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("lists the grants on one note", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ items: [grant], limit: 1_000, returned: 1, truncated: false }),
    );

    await expect(requestNoteShares(workspaceId, noteId)).resolves.toEqual({
      ok: true,
      data: { items: [grant], limit: 1_000, returned: 1, truncated: false },
    });
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe(
      `/api/v1/workspaces/${workspaceId}/notes/${noteId}/shares`,
    );
  });

  it("upserts a grant with a contract-allowed permission only", async () => {
    await expect(
      upsertNoteShare(workspaceId, noteId, userId, { permission: "owner" } as never),
    ).resolves.toEqual({ ok: false, kind: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(jsonResponse({ share: grant }));

    await expect(
      upsertNoteShare(workspaceId, noteId, userId, { permission: "edit" }),
    ).resolves.toEqual({ ok: true, data: { share: grant } });
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("PUT");
  });

  it("revokes a grant by user id", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ noteId, userId, revoked: true }));

    await expect(revokeNoteShare(workspaceId, noteId, userId)).resolves.toEqual({
      ok: true,
      data: { noteId, userId, revoked: true },
    });
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("DELETE");
  });

  /**
   * A share route carries three identifiers and any one of them being forged is
   * a cross-tenant probe. All three are validated before a request is made, so
   * the API never has to answer a question that would disclose existence.
   */
  it.each([
    ["workspace", ["forged", noteId, userId]],
    ["note", [workspaceId, "forged", userId]],
    ["user", [workspaceId, noteId, "forged"]],
  ] as const)("refuses a share mutation with a forged %s id", async (_which, ids) => {
    const [ws, note, user] = ids;

    await expect(revokeNoteShare(ws, note, user)).resolves.toEqual({ ok: false, kind: "invalid" });
    await expect(upsertNoteShare(ws, note, user, { permission: "view" })).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["workspace", ["forged", noteId]],
    ["note", [workspaceId, "forged"]],
  ] as const)("refuses a share listing with a forged %s id", async (_which, ids) => {
    await expect(requestNoteShares(ids[0], ids[1])).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an unreadable conflict envelope as a generic conflict", async () => {
    fetchMock.mockResolvedValue(new Response("not json", { status: 409 }));

    await expect(
      upsertNoteShare(workspaceId, noteId, userId, { permission: "view" }),
    ).resolves.toEqual({ ok: false, kind: "conflict" });
  });

  it("reads a version conflict from a nested error envelope", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: "VERSION_CONFLICT" } }, 409));

    await expect(
      upsertNoteShare(workspaceId, noteId, userId, { permission: "view" }),
    ).resolves.toEqual({ ok: false, kind: "version-conflict" });
  });

  it("maps a thrown request to unavailable", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));

    await expect(requestNoteShares(workspaceId, noteId)).resolves.toEqual({
      ok: false,
      kind: "unavailable",
      retryable: true,
    });
  });
});
