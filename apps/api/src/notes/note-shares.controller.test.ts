import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";

import { NoteSharesController } from "./note-shares.controller";

import type { NoteSharesService } from "./note-shares.service";
import type { AuthService } from "../auth/auth.service";
import type { Request } from "express";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const noteId = "10000000-0000-4000-8000-000000000002";
const userId = "10000000-0000-4000-8000-000000000003";

function request(): Request {
  const value = { params: { workspaceId, noteId, userId } } as unknown as Request;
  setAuthPrincipal(value, {
    userId: "10000000-0000-4000-8000-000000000004",
    sessionId: "session",
    method: "opaque-session",
    assurance: "single-factor",
    authenticatedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-08-02T00:00:00.000Z",
    isFresh: true,
  });
  return value;
}

describe("NoteSharesController", () => {
  it("validates view/edit mutation input and checks trusted origin before delegation", async () => {
    const upsert = vi.fn().mockResolvedValue({ share: {} });
    const origin = vi.fn();
    const controller = new NoteSharesController(
      { upsert } as unknown as NoteSharesService,
      { assertTrustedMutationOrigin: origin } as unknown as AuthService,
    );
    await controller.upsert(request(), { permission: "edit" });
    expect(origin).toHaveBeenCalledBefore(upsert);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, noteId, userId, permission: "edit" }),
    );
    expect(() => controller.upsert(request(), { permission: "comment" })).toThrow();
  });

  it("keeps list and revoke route identifiers bounded", async () => {
    const service = {
      list: vi.fn().mockResolvedValue({ items: [] }),
      revoke: vi.fn().mockResolvedValue({ revoked: true }),
    };
    const controller = new NoteSharesController(
      service as unknown as NoteSharesService,
      { assertTrustedMutationOrigin: vi.fn() } as unknown as AuthService,
    );
    await controller.list(request());
    await controller.revoke(request());
    expect(service.list).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, noteId }));
    expect(service.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, noteId, userId }),
    );
  });
});
