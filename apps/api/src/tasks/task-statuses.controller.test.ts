import { HttpStatus, RequestMethod } from "@nestjs/common";
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { TASK_STATUS_API_PATHS } from "@notted/shared-types";
import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import {
  AUTHORIZATION_HTTP_SPEC,
  type HttpAuthorizationSpec,
} from "../authorization/authorization-http.decorator";

import { TaskStatusesController } from "./task-statuses.controller";

import type { TaskStatusesService } from "./task-statuses.service";
import type { AuthService } from "../auth/auth.service";
import type { Request } from "express";

const userId = "90000000-0000-4000-8000-000000000001";
const workspaceId = "90000000-0000-4000-8100-000000000001";
const statusId = "90000000-0000-4000-8600-000000000001";
const projectId = "90000000-0000-4000-8300-000000000001";

function request(
  params: Record<string, string> = {},
  idempotencyKey = "task-status-create-0001",
): Request {
  const value = {
    params,
    header: (name: string) =>
      name.toLowerCase() === "idempotency-key" ? idempotencyKey : "https://app.notted.test",
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

function controller(
  service: Partial<TaskStatusesService>,
  origin = vi.fn(),
): TaskStatusesController {
  return new TaskStatusesController(
    service as TaskStatusesService,
    {
      assertTrustedMutationOrigin: origin,
    } as unknown as AuthService,
  );
}

function specFor(handler: keyof TaskStatusesController): HttpAuthorizationSpec {
  const spec: unknown = Reflect.getMetadata(
    AUTHORIZATION_HTTP_SPEC,
    TaskStatusesController.prototype[handler],
  );
  if (spec === undefined) throw new Error(`missing authorization spec for ${handler}`);
  return spec as HttpAuthorizationSpec;
}

describe("TaskStatusesController routing", () => {
  it("publishes the canonical REST paths under the versioned prefix", () => {
    expect(TASK_STATUS_API_PATHS.collection(":workspaceId")).toBe(
      "/api/v1/workspaces/:workspaceId/task-statuses",
    );
    expect(TASK_STATUS_API_PATHS.detail(":workspaceId", ":statusId")).toBe(
      "/api/v1/workspaces/:workspaceId/task-statuses/:statusId",
    );
    expect(Reflect.getMetadata(PATH_METADATA, TaskStatusesController)).toBe(
      "workspaces/:workspaceId/task-statuses",
    );
  });

  /**
   * Managing columns reuses `settings.update`, the existing owner/admin action.
   * If this table ever grows a bespoke action, the permission matrix has been
   * forked and this is where it shows.
   */
  it.each([
    ["list", RequestMethod.GET, "/", "workspace.read", { kind: "workspace" }],
    ["create", RequestMethod.POST, "/", "settings.update", { kind: "settings" }],
    ["update", RequestMethod.PATCH, ":statusId", "settings.update", { kind: "settings" }],
    ["remove", RequestMethod.DELETE, ":statusId", "settings.update", { kind: "settings" }],
  ] as const)(
    "binds %s to its verb, path, authorization action and resource",
    (handler, method, path, action, resource) => {
      expect(Reflect.getMetadata(METHOD_METADATA, TaskStatusesController.prototype[handler])).toBe(
        method,
      );
      expect(Reflect.getMetadata(PATH_METADATA, TaskStatusesController.prototype[handler])).toBe(
        path,
      );
      const spec = specFor(handler);
      const call = request({ workspaceId, statusId });
      expect(spec.action).toBe(action);
      expect(spec.workspaceId(call)).toBe(workspaceId);
      expect(spec.resource(call)).toEqual(resource);
    },
  );

  it("answers a create with 201 and leaves the other routes on their default status", () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, TaskStatusesController.prototype.create)).toBe(
      HttpStatus.CREATED,
    );
    for (const handler of ["list", "update", "remove"] as const) {
      expect(
        Reflect.getMetadata(HTTP_CODE_METADATA, TaskStatusesController.prototype[handler]),
      ).toBeUndefined();
    }
  });
});

describe("TaskStatusesController boundary enforcement", () => {
  it("enforces trusted origin and an idempotency key before creating", async () => {
    const create = vi.fn().mockResolvedValue({ status: { id: statusId } });
    const origin = vi.fn();
    await controller({ create }, origin).create(request({ workspaceId }), {
      name: "Blocked",
      color: "#ff0000",
    });
    expect(origin).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: expect.objectContaining({ userId }),
        workspaceId,
        // The contract default is resolved here, never left undefined.
        projectId: null,
        name: "Blocked",
        color: "#ff0000",
        idempotencyKey: "task-status-create-0001",
      }),
    );
  });

  it("rejects a create without a usable idempotency key", () => {
    const create = vi.fn();
    expect(() =>
      controller({ create }).create(request({ workspaceId }, "short"), { name: "Blocked" }),
    ).toThrow("A valid Idempotency-Key header is required.");
    expect(create).not.toHaveBeenCalled();
  });

  it("enforces trusted origin on every mutating route", async () => {
    const origin = vi.fn();
    const update = vi.fn().mockResolvedValue({ status: { id: statusId } });
    const remove = vi
      .fn()
      .mockResolvedValue({ id: statusId, deleted: true, affected: 0, affectedNotes: 0 });
    const instance = controller({ update, remove }, origin);
    const detail = request({ workspaceId, statusId });
    await instance.update(detail, { name: "Waiting" });
    await instance.remove(detail);
    expect(origin).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ statusId, name: "Waiting" }));
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ statusId, workspaceId }));
  });

  it.each([
    ["create", { name: "" }],
    ["create (reserved built-in name)", { name: "Done" }],
    ["create (unknown field)", { name: "Blocked", sortOrder: 3 }],
    ["create (bad color)", { name: "Blocked", color: "red" }],
    ["update (empty)", {}],
    ["update (bad color)", { color: "#12345" }],
  ] as const)("rejects invalid %s input before touching the service", (label, body) => {
    const method = vi.fn();
    const handler = label.startsWith("create") ? "create" : "update";
    const instance = controller({ [handler]: method } as Partial<TaskStatusesService>);
    const call = request({ workspaceId, statusId });
    expect(() =>
      handler === "create" ? instance.create(call, body) : instance.update(call, body),
    ).toThrow("The request is invalid.");
    expect(method).not.toHaveBeenCalled();
  });

  it("forwards the project filter and refuses unknown query parameters", async () => {
    const list = vi.fn().mockResolvedValue({ items: [] });
    await controller({ list }).list(request({ workspaceId }), { projectId });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, projectId }));
    expect(() => controller({ list }).list(request({ workspaceId }), { page: "2" })).toThrow(
      "The request is invalid.",
    );
  });

  it("treats an absent query as the workspace-wide listing", async () => {
    const list = vi.fn().mockResolvedValue({ items: [] });
    await controller({ list }).list(request({ workspaceId }), undefined);
    expect(list).toHaveBeenCalledWith(
      expect.not.objectContaining({ projectId: expect.anything() }),
    );
  });
});
