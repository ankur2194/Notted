import { HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import { ApiHttpException } from "../common/errors/api-http.exception";

import { FoldersController, NotesController } from "./notes.controller";

import type { NotesService } from "./notes.service";
import type { AuthService } from "../auth/auth.service";
import type { Request } from "express";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const noteId = "10000000-0000-4000-8000-000000000002";
const folderId = "10000000-0000-4000-8000-000000000003";
const userId = "10000000-0000-4000-8000-000000000004";

function request(params: Record<string, string>, headers: Record<string, string> = {}): Request {
  const value = {
    params,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  setAuthPrincipal(value, {
    userId,
    sessionId: "session",
    method: "opaque-session",
    assurance: "single-factor",
    authenticatedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-08-02T00:00:00.000Z",
    isFresh: true,
  });
  return value;
}

describe("Part 31 thin REST transports", () => {
  it("maps task-list create and never accepts contentPlain", async () => {
    const create = vi.fn().mockResolvedValue({ note: {} });
    const origin = vi.fn();
    const controller = new NotesController(
      { create } as unknown as NotesService,
      { assertTrustedMutationOrigin: origin } as unknown as AuthService,
    );
    const req = request(
      { workspaceId },
      { "idempotency-key": "note-create-key-0001", origin: "https://app.notted.test" },
    );
    await controller.create(req, {
      title: "Tasks",
      type: "task-list",
      content: { type: "doc", content: [] },
    });
    expect(origin).toHaveBeenCalledBefore(create);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        type: "task-list",
        projectId: null,
        folderId: null,
        parentId: null,
        idempotencyKey: "note-create-key-0001",
      }),
    );

    expect(() => controller.create(req, { title: "Forged", contentPlain: "secret" })).toThrow(
      expect.objectContaining({ status: HttpStatus.BAD_REQUEST }),
    );
  });

  it("requires trusted origin before every note mutation delegates", () => {
    const service = { update: vi.fn() };
    const denied = new ApiHttpException(HttpStatus.FORBIDDEN, {
      code: "CSRF_ORIGIN_INVALID",
      message: "The request origin is not allowed.",
    });
    const controller = new NotesController(
      service as unknown as NotesService,
      {
        assertTrustedMutationOrigin: vi.fn(() => {
          throw denied;
        }),
      } as unknown as AuthService,
    );
    expect(() =>
      controller.update(request({ workspaceId, noteId }), { expectedVersion: 1, title: "A" }),
    ).toThrow(denied);
    expect(service.update).not.toHaveBeenCalled();
  });

  it("maps versioned move selectors without sibling arrays", async () => {
    const move = vi.fn().mockResolvedValue({ note: {} });
    const controller = new NotesController(
      { move } as unknown as NotesService,
      { assertTrustedMutationOrigin: vi.fn() } as unknown as AuthService,
    );
    await controller.move(request({ workspaceId, noteId }), {
      expectedVersion: 4,
      projectId: null,
      folderId,
      parentId: null,
      beforeNoteId: null,
    });
    expect(move).toHaveBeenCalledWith(
      expect.objectContaining({ noteId, folderId, expectedVersion: 4 }),
    );
  });

  it("keeps folder deletion confirmed and delegates only identifiers", async () => {
    const deleteFolder = vi
      .fn()
      .mockResolvedValue({ id: folderId, deleted: true, removedFolders: 1, unfiledNotes: 0 });
    const controller = new FoldersController(
      { deleteFolder } as unknown as NotesService,
      { assertTrustedMutationOrigin: vi.fn() } as unknown as AuthService,
    );
    await controller.delete(request({ workspaceId, folderId }), { confirm: true });
    expect(deleteFolder).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, folderId }));
    expect(() =>
      controller.delete(request({ workspaceId, folderId }), { confirm: false }),
    ).toThrow();
  });
});
