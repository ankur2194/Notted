import { describe, expect, it, vi } from "vitest";

import { NotePublicLinksService } from "./note-public-links.service";

import type { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import type { AppConfig } from "../config/app.config";
import type { AuthConfig } from "../config/auth.config";
import type { DatabaseService } from "../database/database.service";
import type { TenantContextService } from "../tenant";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const noteId = "10000000-0000-4000-8000-000000000002";
const actorId = "10000000-0000-4000-8000-000000000003";
const principal = Object.freeze({
  userId: actorId,
  sessionId: "session",
  method: "opaque-session" as const,
  assurance: "single-factor" as const,
  authenticatedAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-08-02T00:00:00.000Z",
  isFresh: true,
});
const authConfig = { secret: "test-pepper" } as AuthConfig;
const appConfig = { appUrl: new URL("https://app.example.test") } as AppConfig;

function tenantStub(): TenantContextService {
  return { get: () => ({ workspaceId, userId: actorId }) } as unknown as TenantContextService;
}

describe("NotePublicLinksService authorization", () => {
  it("authorizes status, create, and revoke under note.update", async () => {
    const denial = new Error("denied");
    const authorizeUser = vi.fn().mockRejectedValue(denial);
    const service = new NotePublicLinksService(
      {} as DatabaseService,
      { authorizeUser } as unknown as AuthorizationEntryService,
      tenantStub(),
      authConfig,
      appConfig,
    );
    await expect(service.status({ principal, workspaceId, noteId })).rejects.toBe(denial);
    await expect(service.create({ principal, workspaceId, noteId })).rejects.toBe(denial);
    await expect(service.revoke({ principal, workspaceId, noteId })).rejects.toBe(denial);
    expect(authorizeUser.mock.calls.map(([input]) => input.action)).toEqual([
      "note.update",
      "note.update",
      "note.update",
    ]);
    expect(authorizeUser.mock.calls.every(([input]) => input.resource.kind === "note")).toBe(true);
    expect(authorizeUser.mock.calls.every(([input]) => input.resource.id === noteId)).toBe(true);
  });
});
