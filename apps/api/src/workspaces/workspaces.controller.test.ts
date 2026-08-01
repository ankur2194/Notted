import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";

import { WorkspacesController } from "./workspaces.controller";

import type { WorkspacesService } from "./workspaces.service";
import type { AuthService } from "../auth/auth.service";
import type { Request } from "express";

const userId = "20000000-0000-4000-8000-000000000001";
const workspaceId = "20000000-0000-4000-8100-000000000001";

function request(params: { id?: string } = {}): Request {
  const value = {
    params: params.id === undefined ? {} : { id: params.id },
    header: (name: string) =>
      name.toLowerCase() === "idempotency-key"
        ? "workspace-create-00000001"
        : "https://app.notted.test",
  } as unknown as Request;
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

describe("WorkspacesController", () => {
  it("creates a workspace with the parsed body, principal, and trusted-origin check", async () => {
    const create = vi.fn().mockResolvedValue({
      workspace: { id: workspaceId },
      slug: "notted-alpha",
    });
    const assertTrustedMutationOrigin = vi.fn();
    const controller = new WorkspacesController(
      { create } as unknown as WorkspacesService,
      { assertTrustedMutationOrigin } as unknown as AuthService,
    );

    await controller.create(request(), {
      name: "Notted Alpha",
      slug: "notted-alpha",
      description: "Isolation tenant",
      settings: { defaultPageSize: "letter" },
    });

    expect(assertTrustedMutationOrigin).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({
      principal: expect.objectContaining({ userId }),
      name: "Notted Alpha",
      slug: "notted-alpha",
      description: "Isolation tenant",
      domain: null,
      settings: { defaultPageSize: "letter" },
      idempotencyKey: "workspace-create-00000001",
      requestId: null,
    });
  });

  it("rejects an invalid create body after the origin check", () => {
    const create = vi.fn();
    const assertTrustedMutationOrigin = vi.fn();
    const controller = new WorkspacesController(
      { create } as unknown as WorkspacesService,
      { assertTrustedMutationOrigin } as unknown as AuthService,
    );

    expect(() => controller.create(request(), { name: "X" })).toThrow("The request is invalid.");
    expect(assertTrustedMutationOrigin).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it("parses list query defaults and forwards the authenticated principal", async () => {
    const list = vi.fn().mockResolvedValue({ items: [], page: 1, limit: 25, hasMore: false });
    const controller = new WorkspacesController(
      { list } as unknown as WorkspacesService,
      {} as AuthService,
    );

    await controller.list(request(), {});
    expect(list).toHaveBeenCalledWith({
      principal: expect.objectContaining({ userId }),
      page: 1,
      limit: 25,
      name: undefined,
      plan: undefined,
      currentUserRole: undefined,
      sortBy: "updatedAt",
      sortDirection: "desc",
    });
  });

  it("reads one workspace by route id and forwards the principal", async () => {
    const read = vi.fn().mockResolvedValue({ id: workspaceId });
    const controller = new WorkspacesController(
      { read } as unknown as WorkspacesService,
      {} as AuthService,
    );

    await controller.read(request({ id: workspaceId }));
    expect(read).toHaveBeenCalledWith({
      principal: expect.objectContaining({ userId }),
      workspaceId,
      requestId: null,
    });
  });

  it("updates with a parsed body and trusted-origin check", async () => {
    const update = vi.fn().mockResolvedValue({ workspace: { id: workspaceId } });
    const assertTrustedMutationOrigin = vi.fn();
    const controller = new WorkspacesController(
      { update } as unknown as WorkspacesService,
      { assertTrustedMutationOrigin } as unknown as AuthService,
    );

    await controller.update(request({ id: workspaceId }), {
      name: "Renamed",
      settings: { defaultPageSize: "a4" },
    });
    expect(assertTrustedMutationOrigin).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({
      principal: expect.objectContaining({ userId }),
      workspaceId,
      name: "Renamed",
      slug: undefined,
      description: undefined,
      domain: undefined,
      settings: { defaultPageSize: "a4" },
      requestId: null,
    });
  });

  it("requires the literal confirmation gate on delete", () => {
    const deleteFn = vi.fn();
    const assertTrustedMutationOrigin = vi.fn();
    const controller = new WorkspacesController(
      { delete: deleteFn } as unknown as WorkspacesService,
      { assertTrustedMutationOrigin } as unknown as AuthService,
    );

    expect(() => controller.delete(request({ id: workspaceId }), { confirm: false })).toThrow(
      "The request is invalid.",
    );
    expect(() => controller.delete(request({ id: workspaceId }), {})).toThrow(
      "The request is invalid.",
    );
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("deletes with confirmation and forwards expectedName", async () => {
    const deleteFn = vi.fn().mockResolvedValue({ id: workspaceId, deleted: true });
    const assertTrustedMutationOrigin = vi.fn();
    const controller = new WorkspacesController(
      { delete: deleteFn } as unknown as WorkspacesService,
      { assertTrustedMutationOrigin } as unknown as AuthService,
    );

    await controller.delete(request({ id: workspaceId }), {
      confirm: true,
      expectedName: "Notted Alpha",
    });
    expect(assertTrustedMutationOrigin).toHaveBeenCalledOnce();
    expect(deleteFn).toHaveBeenCalledWith({
      principal: expect.objectContaining({ userId }),
      workspaceId,
      confirmed: true,
      expectedName: "Notted Alpha",
      requestId: null,
    });
  });
});
