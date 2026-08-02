import { describe, expect, it, vi } from "vitest";

import { NoteSharesService } from "./note-shares.service";

import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { DatabaseService } from "../database/database.service";
import type { TenantContextService } from "../tenant";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const noteId = "10000000-0000-4000-8000-000000000002";
const actorId = "10000000-0000-4000-8000-000000000003";
const targetId = "10000000-0000-4000-8000-000000000004";
const principal = Object.freeze({
  userId: actorId,
  sessionId: "session",
  method: "opaque-session" as const,
  assurance: "single-factor" as const,
  authenticatedAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-08-02T00:00:00.000Z",
  isFresh: true,
});

describe("NoteSharesService authorization", () => {
  it("rejects self grants before policy or SQL", async () => {
    const authorizeUser = vi.fn();
    const transaction = vi.fn();
    const service = new NoteSharesService(
      { transaction } as unknown as DatabaseService,
      { authorizeUser } as unknown as AuthorizationEntryService,
      {} as TenantContextService,
    );
    await expect(
      service.upsert({ principal, workspaceId, noteId, userId: actorId, permission: "view" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(authorizeUser).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("passes target membership, restricted-project caps, and actor delegation to centralized note.share", async () => {
    const denial = new Error("delegation denied");
    const authorizeUser = vi.fn().mockRejectedValue(denial);
    const transaction = vi.fn();
    const service = new NoteSharesService(
      { transaction } as unknown as DatabaseService,
      { authorizeUser } as unknown as AuthorizationEntryService,
      {} as TenantContextService,
    );
    await expect(
      service.upsert({ principal, workspaceId, noteId, userId: targetId, permission: "edit" }),
    ).rejects.toBe(denial);
    expect(authorizeUser).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "note.share",
        workspaceId,
        resource: {
          kind: "note",
          id: noteId,
          delegation: { targetUserId: targetId, requestedPermission: "edit" },
        },
      }),
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("requires current note update authority for listing and revocation", async () => {
    const denial = new Error("management denied");
    const authorizeUser = vi.fn().mockRejectedValue(denial);
    const service = new NoteSharesService(
      {} as DatabaseService,
      { authorizeUser } as unknown as AuthorizationEntryService,
      {} as TenantContextService,
    );
    await expect(service.list({ principal, workspaceId, noteId })).rejects.toBe(denial);
    await expect(service.revoke({ principal, workspaceId, noteId, userId: targetId })).rejects.toBe(
      denial,
    );
    expect(authorizeUser.mock.calls.map(([input]) => input.action)).toEqual([
      "note.update",
      "note.update",
    ]);
  });
});
