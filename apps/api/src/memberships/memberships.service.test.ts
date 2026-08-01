import { describe, expect, it, vi } from "vitest";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import { emailDeliveries, invitations, jobOutbox } from "../database/schema";
import { createTenantContext, TenantContextService } from "../tenant";

import { InvitationTokenService } from "./invitation-token.service";
import { MembershipsService } from "./memberships.service";

import type { AuthConfig } from "../config/auth.config";
import type { AuthenticatedPrincipal, WorkspaceRole } from "@notted/shared-types";

const secret = "part-28-unit-test-secret-that-is-long-enough";
const workspaceId = "20000000-0000-4000-8100-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";

function principal(): AuthenticatedPrincipal {
  return Object.freeze({
    userId,
    sessionId: "session",
    method: "opaque-session",
    assurance: "single-factor",
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isFresh: true,
  });
}

function tokenService(): InvitationTokenService {
  return new InvitationTokenService({ secret } as AuthConfig);
}

describe("MembershipsService (unit)", () => {
  it("derives stable domain-separated tokens while different invitation UUIDs receive different hashes", () => {
    const tokens = tokenService();
    const firstId = "20000000-0000-4000-8300-000000000001";
    const secondId = "20000000-0000-4000-8300-000000000002";
    expect(tokens.derive(firstId)).toHaveLength(43);
    expect(tokens.derive(firstId)).toBe(tokens.derive(firstId));
    expect(tokens.derive(firstId)).not.toBe(tokens.derive(secondId));
    expect(tokens.hashForInvitation(firstId)).not.toBe(tokens.hashForInvitation(secondId));
  });

  it("persists only a token hash and identifier-only outbox data when creating an invitation intent", async () => {
    const tokens = tokenService();
    const inserts: Array<{ table: unknown; value: Record<string, unknown> }> = [];
    const tx = {
      insert: (table: unknown) => ({
        values: (value: Record<string, unknown>) => {
          inserts.push({ table, value });
          return Promise.resolve();
        },
      }),
    } as unknown as DatabaseTransaction;
    const tenant = new TenantContextService();
    const service = new MembershipsService(
      {} as DatabaseService,
      {} as AuthorizationEntryService,
      tenant,
      tokens,
    );
    const internal = service as unknown as {
      createInvitation(
        scope: DatabaseTransaction,
        input: { workspaceId: string; email: string; role: WorkspaceRole; actorId: string },
      ): Promise<{ id: string; email: string }>;
    };

    const row = await tenant.run(createTenantContext({ workspaceId, userId }), async () =>
      internal.createInvitation(tx, {
        workspaceId,
        email: "person@example.com",
        role: "viewer",
        actorId: userId,
      }),
    );
    const rawToken = tokens.derive(row.id);
    const invitationInsert = inserts.find((entry) => entry.table === invitations)?.value;
    const deliveryInsert = inserts.find((entry) => entry.table === emailDeliveries)?.value;
    const outboxInsert = inserts.find((entry) => entry.table === jobOutbox)?.value;
    expect(invitationInsert?.tokenHash).toBe(tokens.hash(rawToken));
    expect(invitationInsert).not.toHaveProperty("token");
    expect(deliveryInsert).not.toHaveProperty("token");
    expect(outboxInsert?.payload).toEqual(
      expect.objectContaining({
        workspaceId,
        resourceIds: [row.id, expect.any(String)],
        actorId: userId,
      }),
    );
    expect(
      JSON.stringify({ invitationInsert, deliveryInsert, outboxInsert, apiResult: row }),
    ).not.toContain(rawToken);
  });

  it("propagates an outbox write failure so the enclosing database transaction can roll back invitation and delivery", async () => {
    const tenant = new TenantContextService();
    const tx = {
      insert: (table: unknown) => ({
        values: () =>
          table === jobOutbox ? Promise.reject(new Error("outbox unavailable")) : Promise.resolve(),
      }),
    } as unknown as DatabaseTransaction;
    const service = new MembershipsService(
      {} as DatabaseService,
      {} as AuthorizationEntryService,
      tenant,
      tokenService(),
    );
    const internal = service as unknown as {
      createInvitation(
        scope: DatabaseTransaction,
        input: { workspaceId: string; email: string; role: WorkspaceRole; actorId: string },
      ): Promise<unknown>;
    };
    await expect(
      tenant.run(createTenantContext({ workspaceId, userId }), async () =>
        internal.createInvitation(tx, {
          workspaceId,
          email: "rollback@example.com",
          role: "viewer",
          actorId: userId,
        }),
      ),
    ).rejects.toThrow("outbox unavailable");
  });

  it("enforces owner-only owner grants in service logic even after policy authorization", () => {
    const service = new MembershipsService(
      {} as DatabaseService,
      {} as AuthorizationEntryService,
      new TenantContextService(),
      tokenService(),
    );
    const internal = service as unknown as {
      assertCanGrantRole(actor: WorkspaceRole, requested: WorkspaceRole): void;
    };
    expect(() => internal.assertCanGrantRole("owner", "owner")).not.toThrow();
    expect(() => internal.assertCanGrantRole("admin", "owner")).toThrow("Only an owner");
    expect(() => internal.assertCanGrantRole("editor", "viewer")).toThrow(
      "cannot manage invitations",
    );
  });

  it("does not touch the database when centralized authorization rejects a list", async () => {
    const select = vi.fn();
    const authorizeUser = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("concealed"), { decision: { allowed: false, httpStatus: 404 } }),
      );
    const service = new MembershipsService(
      { db: { select } } as unknown as DatabaseService,
      { authorizeUser } as unknown as AuthorizationEntryService,
      new TenantContextService(),
      tokenService(),
    );
    await expect(
      service.listMembers({
        principal: principal(),
        workspaceId,
        page: 1,
        limit: 25,
      }),
    ).rejects.toMatchObject({ decision: { httpStatus: 404 } });
    expect(authorizeUser).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.list",
        resource: { kind: "workspace" },
      }),
    );
    expect(select).not.toHaveBeenCalled();
  });

  it("requires member.invite to list invitation email/state", async () => {
    const select = vi.fn();
    const authorizeUser = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("forbidden"), { decision: { allowed: false, httpStatus: 403 } }),
      );
    const service = new MembershipsService(
      { db: { select } } as unknown as DatabaseService,
      { authorizeUser } as unknown as AuthorizationEntryService,
      new TenantContextService(),
      tokenService(),
    );
    await expect(
      service.listInvitations({
        principal: principal(),
        workspaceId,
        page: 1,
        limit: 25,
      }),
    ).rejects.toMatchObject({ decision: { httpStatus: 403 } });
    expect(authorizeUser).toHaveBeenCalledWith(
      expect.objectContaining({ action: "member.invite" }),
    );
    expect(select).not.toHaveBeenCalled();
  });

  it("uses one invitation-ID lock namespace for every terminal transition", async () => {
    const service = new MembershipsService(
      {} as DatabaseService,
      {} as AuthorizationEntryService,
      new TenantContextService(),
      tokenService(),
    );
    const lockMutation = vi.fn().mockResolvedValue(undefined);
    const internal = service as unknown as {
      lockMutation: typeof lockMutation;
      lockInvitation(tx: DatabaseTransaction, invitationId: string): Promise<void>;
    };
    internal.lockMutation = lockMutation;
    const invitationId = "20000000-0000-4000-8300-000000000001";
    await internal.lockInvitation({} as DatabaseTransaction, invitationId);
    expect(lockMutation).toHaveBeenCalledWith(expect.anything(), `invitation-id:${invitationId}`);
  });
});
