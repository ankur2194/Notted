import { HttpStatus, RequestMethod } from "@nestjs/common";
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import {
  AUTHORIZATION_HTTP_SPEC,
  type HttpAuthorizationSpec,
} from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";

import { FoldersController, NotesController } from "./notes.controller";

import type { NotesService } from "./notes.service";
import type { AuthService } from "../auth/auth.service";
import type { Request } from "express";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const noteId = "10000000-0000-4000-8000-000000000002";
const folderId = "10000000-0000-4000-8000-000000000003";
const userId = "10000000-0000-4000-8000-000000000004";
const columnId = "10000000-0000-4000-8000-000000000005";

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
    const req = request({ workspaceId, noteId });
    await controller.move(req, {
      expectedVersion: 4,
      projectId: null,
      folderId,
      parentId: null,
      beforeNoteId: null,
    });
    expect(move).toHaveBeenCalledWith(
      expect.objectContaining({ noteId, folderId, expectedVersion: 4 }),
    );
    // Omitted stays omitted at the transport: "keep the current column" is a
    // service decision, and a transport-supplied default would erase it.
    expect(move.mock.calls[0]?.[0]).not.toHaveProperty("boardColumnId");

    // Part 49 adds a board column to the SAME route rather than a new one, so
    // the recorded action must still be `note.update` and nothing else.
    const spec = Reflect.getMetadata(
      AUTHORIZATION_HTTP_SPEC,
      NotesController.prototype.move,
    ) as HttpAuthorizationSpec;
    expect(spec.action).toBe("note.update");
    expect(spec.workspaceId(req)).toBe(workspaceId);
    expect(spec.resource(req)).toEqual({ kind: "note", id: noteId });
    expect(Reflect.getMetadata(PATH_METADATA, NotesController.prototype.move)).toBe(":noteId/move");
    expect(Reflect.getMetadata(METHOD_METADATA, NotesController.prototype.move)).toBe(
      RequestMethod.POST,
    );
  });

  it("passes an explicit board column through to the service verbatim", async () => {
    const move = vi.fn().mockResolvedValue({ note: {} });
    const controller = new NotesController(
      { move } as unknown as NotesService,
      { assertTrustedMutationOrigin: vi.fn() } as unknown as AuthService,
    );
    await controller.move(request({ workspaceId, noteId }), {
      expectedVersion: 4,
      projectId: null,
      folderId: null,
      parentId: null,
      boardColumnId: columnId,
    });
    expect(move).toHaveBeenCalledWith(expect.objectContaining({ boardColumnId: columnId }));
    expect(() =>
      controller.move(request({ workspaceId, noteId }), {
        expectedVersion: 4,
        projectId: null,
        folderId: null,
        parentId: null,
        boardColumnId: "not-a-uuid",
      }),
    ).toThrow(expect.objectContaining({ status: HttpStatus.BAD_REQUEST }));
  });

  it("exposes copy as a created POST authorized on the source note", async () => {
    const copy = vi.fn().mockResolvedValue({ note: {} });
    const origin = vi.fn();
    const controller = new NotesController(
      { copy } as unknown as NotesService,
      { assertTrustedMutationOrigin: origin } as unknown as AuthService,
    );
    const req = request(
      { workspaceId, noteId },
      { "idempotency-key": "note-copy-key-0001", origin: "https://app.notted.test" },
    );
    await controller.copy(req, { asTemplate: true, includeTags: false, title: "Template" });
    expect(origin).toHaveBeenCalledBefore(copy);
    expect(copy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        noteId,
        asTemplate: true,
        includeTags: false,
        title: "Template",
        projectId: null,
        folderId: null,
        parentId: null,
        idempotencyKey: "note-copy-key-0001",
      }),
    );

    expect(Reflect.getMetadata(PATH_METADATA, NotesController.prototype.copy)).toBe(":noteId/copy");
    expect(Reflect.getMetadata(METHOD_METADATA, NotesController.prototype.copy)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, NotesController.prototype.copy)).toBe(201);
    // The route authorizes the SOURCE note; the destination `note.create`
    // check lives in the service, which alone knows the target container.
    const spec = Reflect.getMetadata(
      AUTHORIZATION_HTTP_SPEC,
      NotesController.prototype.copy,
    ) as HttpAuthorizationSpec;
    expect(spec.action).toBe("note.read");
    expect(spec.workspaceId(req)).toBe(workspaceId);
    expect(spec.resource(req)).toEqual({ kind: "note", id: noteId });

    expect(() => controller.copy(req, { asTemplate: "yes" })).toThrow(
      expect.objectContaining({ status: HttpStatus.BAD_REQUEST }),
    );
    expect(() => controller.copy(request({ workspaceId, noteId }), { asTemplate: true })).toThrow(
      expect.objectContaining({ status: HttpStatus.BAD_REQUEST }),
    );
    expect(copy).toHaveBeenCalledTimes(1);
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
