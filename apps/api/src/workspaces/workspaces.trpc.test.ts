import { HttpStatus } from "@nestjs/common";
import { TRPCError } from "@trpc/server";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import express from "express";
import supertest from "supertest";
import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import { ApiHttpException } from "../common/errors/api-http.exception";

import { WORKSPACE_TRPC_PATH, WorkspacesTrpcRouter } from "./workspaces.trpc";

import type { WorkspacesService } from "./workspaces.service";
import type { AuthService } from "../auth/auth.service";
import type { Request } from "express";

const userId = "20000000-0000-4000-8000-000000000001";
const workspaceId = "20000000-0000-4000-8100-000000000001";
const timestamp = "2026-08-01T00:00:00.000Z";

function request(authenticated = true): Request {
  const value = {
    header: (name: string) =>
      name.toLowerCase() === "idempotency-key"
        ? "workspace-trpc-00000001"
        : "https://app.notted.test",
  } as unknown as Request;
  if (authenticated) {
    setAuthPrincipal(value, {
      userId,
      sessionId: "session",
      method: "opaque-session",
      assurance: "single-factor",
      authenticatedAt: timestamp,
      expiresAt: "2026-08-02T00:00:00.000Z",
      isFresh: true,
    });
  }
  return value;
}

const workspace = {
  id: workspaceId,
  name: "Alpha",
  slug: "alpha",
  description: null,
  plan: "free",
  currentUserRole: "owner",
  logoUrl: null,
  domain: null,
  settings: { defaultPageSize: "a4" },
  storageLimitBytes: null,
  createdById: userId,
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;

describe("WorkspacesTrpcRouter", () => {
  it("mounts at the reviewed path and delegates all lifecycle procedures to one service", async () => {
    const service = {
      create: vi.fn().mockResolvedValue({ workspace, slug: workspace.slug }),
      list: vi.fn().mockResolvedValue({ items: [], page: 1, limit: 25, hasMore: false }),
      read: vi.fn().mockResolvedValue(workspace),
      update: vi.fn().mockResolvedValue({ workspace }),
      delete: vi.fn().mockResolvedValue({ id: workspaceId, deleted: true }),
    };
    const assertTrustedMutationOrigin = vi.fn();
    const transport = new WorkspacesTrpcRouter(
      service as unknown as WorkspacesService,
      { assertTrustedMutationOrigin } as unknown as AuthService,
    );
    const caller = transport.router.createCaller(transport.createContext(request()));

    expect(WORKSPACE_TRPC_PATH).toBe("/api/v1/trpc");
    await caller.workspace.create({
      name: "Alpha",
      slug: "alpha",
      settings: { defaultPageSize: "a4" },
    });
    await caller.workspace.list({});
    await caller.workspace.read({ workspaceId });
    await caller.workspace.update({ workspaceId, data: { name: "Renamed" } });
    await caller.workspace.delete({ workspaceId, data: { confirm: true } });

    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: expect.objectContaining({ userId }),
        settings: { defaultPageSize: "a4" },
        idempotencyKey: "workspace-trpc-00000001",
      }),
    );
    expect(service.list).toHaveBeenCalledOnce();
    expect(service.read).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }));
    expect(service.update).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }));
    expect(service.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        confirmed: true,
      }),
    );
    expect(assertTrustedMutationOrigin).toHaveBeenCalledTimes(3);
  });

  it("fails unauthenticated callers safely before service invocation", async () => {
    const list = vi.fn();
    const transport = new WorkspacesTrpcRouter(
      { list } as unknown as WorkspacesService,
      {} as AuthService,
    );
    const caller = transport.router.createCaller(transport.createContext(request(false)));
    await expect(caller.workspace.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(list).not.toHaveBeenCalled();
  });

  it("serves the nested workspace procedure through the Express adapter path", async () => {
    const create = vi.fn().mockResolvedValue({ workspace, slug: workspace.slug });
    const transport = new WorkspacesTrpcRouter(
      { create } as unknown as WorkspacesService,
      { assertTrustedMutationOrigin: vi.fn() } as unknown as AuthService,
    );
    const app = express();
    app.use(express.json());
    app.use(WORKSPACE_TRPC_PATH, (incoming, _response, next) => {
      setAuthPrincipal(incoming, {
        userId,
        sessionId: "session",
        method: "opaque-session",
        assurance: "single-factor",
        authenticatedAt: timestamp,
        expiresAt: "2026-08-02T00:00:00.000Z",
        isFresh: true,
      });
      next();
    });
    app.use(
      WORKSPACE_TRPC_PATH,
      createExpressMiddleware({
        router: transport.router,
        createContext: ({ req }) => transport.createContext(req),
      }),
    );

    const response = await supertest(app)
      .post(`${WORKSPACE_TRPC_PATH}/workspace.create`)
      .set("Origin", "https://app.notted.test")
      .set("Idempotency-Key", "workspace-trpc-00000001")
      .send({ name: "Alpha", slug: "alpha" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      result: { data: { workspace: { id: workspaceId }, slug: "alpha" } },
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it("maps safe application errors and hides unknown internals", async () => {
    const safe = new WorkspacesTrpcRouter(
      {
        read: vi.fn().mockRejectedValue(
          new ApiHttpException(HttpStatus.NOT_FOUND, {
            code: "NOT_FOUND",
            message: "The requested resource was not found.",
          }),
        ),
      } as unknown as WorkspacesService,
      {} as AuthService,
    );
    await expect(
      safe.router.createCaller(safe.createContext(request())).workspace.read({ workspaceId }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });

    const hidden = new WorkspacesTrpcRouter(
      {
        read: vi.fn().mockRejectedValue(new Error("database secret")),
      } as unknown as WorkspacesService,
      {} as AuthService,
    );
    const rejection = hidden.router
      .createCaller(hidden.createContext(request()))
      .workspace.read({ workspaceId });
    await expect(rejection).rejects.toBeInstanceOf(TRPCError);
    await expect(rejection).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "The request could not be completed.",
    });
  });
});
