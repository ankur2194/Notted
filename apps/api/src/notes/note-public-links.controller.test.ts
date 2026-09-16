import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";

import { NotePublicLinkController } from "./note-public-links.controller";

import type { NotePublicLinksService } from "./note-public-links.service";
import type { AuthService } from "../auth/auth.service";
import type { Request } from "express";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const noteId = "10000000-0000-4000-8000-000000000002";

function request(): Request {
  const value = { params: { workspaceId, noteId } } as unknown as Request;
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

describe("NotePublicLinkController", () => {
  it("reads status without a trusted-origin check", async () => {
    const status = vi.fn().mockResolvedValue({ enabled: false, createdAt: null });
    const origin = vi.fn();
    const controller = new NotePublicLinkController(
      { status } as unknown as NotePublicLinksService,
      { assertTrustedMutationOrigin: origin } as unknown as AuthService,
    );
    await controller.status(request());
    expect(origin).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, noteId }));
  });

  it("checks trusted origin before create", async () => {
    const create = vi.fn().mockResolvedValue({ url: "https://app.example/p/token" });
    const origin = vi.fn();
    const controller = new NotePublicLinkController(
      { create } as unknown as NotePublicLinksService,
      { assertTrustedMutationOrigin: origin } as unknown as AuthService,
    );
    await controller.create(request());
    expect(origin).toHaveBeenCalledBefore(create);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, noteId }));
  });

  it("checks trusted origin before revoke", async () => {
    const revoke = vi.fn().mockResolvedValue({ noteId, revoked: true });
    const origin = vi.fn();
    const controller = new NotePublicLinkController(
      { revoke } as unknown as NotePublicLinksService,
      { assertTrustedMutationOrigin: origin } as unknown as AuthService,
    );
    await controller.revoke(request());
    expect(origin).toHaveBeenCalledBefore(revoke);
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, noteId }));
  });
});
