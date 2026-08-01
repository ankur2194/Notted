import { GUARDS_METADATA } from "@nestjs/common/constants";
import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import { AuthGuard } from "../auth/auth.guard";
import {
  AUTHORIZATION_HTTP_SPEC,
  type HttpAuthorizationSpec,
} from "../authorization/authorization-http.decorator";

import { MembershipsController } from "./memberships.controller";

import type { MembershipsService } from "./memberships.service";
import type { AuthService } from "../auth/auth.service";
import type { Request } from "express";

const workspaceId = "20000000-0000-4000-8100-000000000001";
const memberId = "20000000-0000-4000-8200-000000000001";
const invitationId = "20000000-0000-4000-8300-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";

function request(params: Record<string, string> = {}): Request {
  const value = { params, header: () => "https://app.notted.test" } as unknown as Request;
  setAuthPrincipal(value, {
    userId,
    sessionId: "session",
    method: "opaque-session",
    assurance: "single-factor",
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isFresh: true,
  });
  return value;
}

function controller(service: Partial<MembershipsService>, origin = vi.fn()): MembershipsController {
  return new MembershipsController(
    service as MembershipsService,
    { assertTrustedMutationOrigin: origin } as unknown as AuthService,
  );
}

describe("MembershipsController", () => {
  it("normalizes and delegates invitation creation only after trusted-origin validation", async () => {
    const invite = vi.fn().mockResolvedValue({ invitation: { id: invitationId } });
    const origin = vi.fn();
    await controller({ invite }, origin).invite(request({ workspaceId }), {
      email: " Person@Example.COM ",
      role: "editor",
    });
    expect(origin).toHaveBeenCalledOnce();
    expect(invite).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        email: "person@example.com",
        role: "editor",
        principal: expect.objectContaining({ userId }),
      }),
    );
  });

  it("maps malformed mutation bodies to safe validation errors without calling the service", () => {
    const invite = vi.fn();
    const origin = vi.fn();
    expect(() =>
      controller({ invite }, origin).invite(request({ workspaceId }), {
        email: "bad",
        role: "owner",
        tokenHash: "forbidden",
      }),
    ).toThrow("The request is invalid.");
    expect(origin).toHaveBeenCalledOnce();
    expect(invite).not.toHaveBeenCalled();
  });

  it("keeps acceptance AuthGuard-only and never returns or derives a token in the controller", async () => {
    const accept = vi.fn().mockResolvedValue({ membership: { id: memberId }, joined: true });
    const origin = vi.fn();
    const token = "A".repeat(43);
    await controller({ accept }, origin).accept(request(), { token });
    expect(origin).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({ token, principal: expect.objectContaining({ userId }) }),
    );
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      MembershipsController.prototype.accept,
    ) as readonly unknown[];
    expect(guards).toContain(AuthGuard);
    expect(
      Reflect.getMetadata(AUTHORIZATION_HTTP_SPEC, MembershipsController.prototype.accept),
    ).toBeUndefined();
  });

  it("delegates role change, removal, resend, revoke, and leave with route-bound UUIDs", async () => {
    const service = {
      changeRole: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue({}),
      resend: vi.fn().mockResolvedValue({}),
      revoke: vi.fn().mockResolvedValue({}),
      leave: vi.fn().mockResolvedValue({}),
    };
    const origin = vi.fn();
    const transport = controller(service, origin);
    await transport.changeRole(request({ workspaceId, memberId }), { role: "viewer" });
    await transport.remove(request({ workspaceId, memberId }));
    await transport.resend(request({ workspaceId, invitationId }));
    await transport.revoke(request({ workspaceId, invitationId }));
    await transport.leave(request({ workspaceId }));
    expect(service.changeRole).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, memberId, role: "viewer" }),
    );
    expect(service.remove).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, memberId }));
    expect(service.resend).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, invitationId }),
    );
    expect(service.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, invitationId }),
    );
    expect(service.leave).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }));
    expect(origin).toHaveBeenCalledTimes(5);
  });

  it("wires the canonical centralized authorization actions and resource selectors", () => {
    const specs = {
      listMembers: "member.list",
      listInvitations: "member.invite",
      invite: "member.invite",
      resend: "member.invite",
      revoke: "member.invite",
      changeRole: "member.update",
      remove: "member.remove",
      leave: "member.list",
    } as const;
    for (const [method, action] of Object.entries(specs)) {
      const handler = MembershipsController.prototype[method as keyof typeof specs];
      const spec = Reflect.getMetadata(AUTHORIZATION_HTTP_SPEC, handler) as HttpAuthorizationSpec;
      expect(spec.action).toBe(action);
      expect(spec.workspaceId(request({ workspaceId, memberId }))).toBe(workspaceId);
    }
    const update = Reflect.getMetadata(
      AUTHORIZATION_HTTP_SPEC,
      MembershipsController.prototype.changeRole,
    ) as HttpAuthorizationSpec;
    expect(update.resource(request({ workspaceId, memberId }))).toEqual({
      kind: "member",
      id: memberId,
    });
  });
});
