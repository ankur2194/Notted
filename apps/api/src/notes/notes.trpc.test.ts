import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import { createTrpcContext } from "../trpc/trpc.context";
import { trpc } from "../trpc/trpc.router";

import { NotesTrpcRouter } from "./notes.trpc";

import type { NotesService } from "./notes.service";
import type { AuthService } from "../auth/auth.service";
import type { Request } from "express";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const noteId = "10000000-0000-4000-8000-000000000002";
const userId = "10000000-0000-4000-8000-000000000003";

const noteDetail = Object.freeze({
  id: noteId,
  workspaceId,
  location: "workspace-root",
  projectId: null,
  folderId: null,
  parentId: null,
  boardColumnId: null,
  title: "Tasks",
  type: "task-list",
  pageSize: "a4",
  sortOrder: 1,
  isTemplate: false,
  isPinned: false,
  isArchived: false,
  isDeleted: false,
  tagIds: [],
  progress: { checklist: { done: 0, total: 0 }, tasks: { done: 0, total: 0 } },
  version: 1,
  deletedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  content: { type: "doc", content: [] },
  contentPlain: "",
  createdById: userId,
  updatedById: userId,
  currentActorId: userId,
  capabilities: { canUpdate: true, canDelete: true, canShare: true },
});

function request(authenticated = true): Request {
  const value = {
    header: (name: string) =>
      name.toLowerCase() === "idempotency-key" ? "note-trpc-key-0001" : "https://app.notted.test",
  } as unknown as Request;
  if (authenticated) {
    setAuthPrincipal(value, {
      userId,
      sessionId: "session",
      method: "opaque-session",
      assurance: "single-factor",
      authenticatedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-02T00:00:00.000Z",
      isFresh: true,
    });
  }
  return value;
}

describe("Part 31 composable note tRPC transport", () => {
  it("composes note/folder procedures and delegates the same strict contracts", async () => {
    const create = vi.fn().mockResolvedValue({ note: noteDetail });
    const createFolder = vi.fn().mockResolvedValue({
      folder: {
        id: noteId,
        workspaceId,
        parentId: null,
        name: "Folder",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    });
    const origin = vi.fn();
    const transport = new NotesTrpcRouter(
      { create, createFolder } as unknown as NotesService,
      { assertTrustedMutationOrigin: origin } as unknown as AuthService,
    );
    const router = trpc.router({ note: transport.noteRouter, folder: transport.folderRouter });
    const caller = router.createCaller(createTrpcContext(request()));
    await caller.note.create({ workspaceId, data: { title: "Tasks", type: "task-list" } });
    await caller.folder.create({ workspaceId, data: { name: "Folder" } });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "task-list",
        idempotencyKey: "note-trpc-key-0001",
      }),
    );
    expect(createFolder).toHaveBeenCalledWith(expect.objectContaining({ name: "Folder" }));
    expect(origin).toHaveBeenCalledTimes(2);
  });

  it("routes note.copy to NotesService.copy with the shared copy contract", async () => {
    const copy = vi.fn().mockResolvedValue({ note: { ...noteDetail, isTemplate: true } });
    const origin = vi.fn();
    const transport = new NotesTrpcRouter(
      { copy } as unknown as NotesService,
      {
        assertTrustedMutationOrigin: origin,
      } as unknown as AuthService,
    );
    const router = trpc.router({ note: transport.noteRouter });
    const caller = router.createCaller(createTrpcContext(request()));
    await caller.note.copy({ workspaceId, noteId, data: { asTemplate: true } });
    expect(origin).toHaveBeenCalledBefore(copy);
    expect(copy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        noteId,
        asTemplate: true,
        includeTags: true,
        projectId: null,
        folderId: null,
        parentId: null,
        idempotencyKey: "note-trpc-key-0001",
      }),
    );
    await expect(
      caller.note.copy({ workspaceId, noteId, data: { asTemplate: "yes" } } as never),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(copy).toHaveBeenCalledTimes(1);
  });

  it("denies unauthenticated callers before service invocation", async () => {
    const list = vi.fn();
    const transport = new NotesTrpcRouter({ list } as unknown as NotesService, {} as AuthService);
    const router = trpc.router({ note: transport.noteRouter });
    const rejection = router.createCaller(createTrpcContext(request(false))).note.list({
      workspaceId,
      query: {},
    });
    await expect(rejection).rejects.toBeInstanceOf(TRPCError);
    await expect(rejection).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(list).not.toHaveBeenCalled();
  });

  it("rejects forged contentPlain at the tRPC boundary", async () => {
    const create = vi.fn();
    const transport = new NotesTrpcRouter({ create } as unknown as NotesService, {} as AuthService);
    const router = trpc.router({ note: transport.noteRouter });
    await expect(
      router.createCaller(createTrpcContext(request())).note.create({
        workspaceId,
        data: { title: "A", contentPlain: "forged" },
      } as never),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(create).not.toHaveBeenCalled();
  });
});
