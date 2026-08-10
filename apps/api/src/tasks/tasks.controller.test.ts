import { HttpStatus, RequestMethod } from "@nestjs/common";
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { TASK_API_PATHS } from "@notted/shared-types";
import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import {
  AUTHORIZATION_HTTP_SPEC,
  type HttpAuthorizationSpec,
} from "../authorization/authorization-http.decorator";

import { TasksController } from "./tasks.controller";

import type { TasksService } from "./tasks.service";
import type { AuthService } from "../auth/auth.service";
import type { Request } from "express";

const userId = "70000000-0000-4000-8000-000000000001";
const workspaceId = "70000000-0000-4000-8100-000000000001";
const taskId = "70000000-0000-4000-8200-000000000001";
const otherTaskId = "70000000-0000-4000-8200-000000000002";
const tagId = "70000000-0000-4000-8300-000000000001";

function request(
  params: Record<string, string> = {},
  idempotencyKey = "task-create-0000000001",
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

function controller(service: Partial<TasksService>, origin = vi.fn()): TasksController {
  return new TasksController(
    service as TasksService,
    {
      assertTrustedMutationOrigin: origin,
    } as unknown as AuthService,
  );
}

function specFor(handler: keyof TasksController): HttpAuthorizationSpec {
  const spec: unknown = Reflect.getMetadata(
    AUTHORIZATION_HTTP_SPEC,
    TasksController.prototype[handler],
  );
  if (spec === undefined) throw new Error(`missing authorization spec for ${handler}`);
  return spec as HttpAuthorizationSpec;
}

describe("TasksController routing", () => {
  it("publishes the final canonical REST paths under the versioned prefix", () => {
    expect(TASK_API_PATHS.collection(":workspaceId")).toBe("/api/v1/workspaces/:workspaceId/tasks");
    expect(TASK_API_PATHS.bulk(":workspaceId")).toBe("/api/v1/workspaces/:workspaceId/tasks/bulk");
    expect(TASK_API_PATHS.detail(":workspaceId", ":taskId")).toBe(
      "/api/v1/workspaces/:workspaceId/tasks/:taskId",
    );
    expect(TASK_API_PATHS.reorder(":workspaceId", ":taskId")).toBe(
      "/api/v1/workspaces/:workspaceId/tasks/:taskId/reorder",
    );
    expect(Reflect.getMetadata(PATH_METADATA, TasksController)).toBe(
      "workspaces/:workspaceId/tasks",
    );
  });

  it.each([
    ["list", RequestMethod.GET, "/", "workspace.read"],
    ["create", RequestMethod.POST, "/", "task.create"],
    ["bulk", RequestMethod.POST, "bulk", "workspace.read"],
    ["read", RequestMethod.GET, ":taskId", "task.read"],
    ["update", RequestMethod.PATCH, ":taskId", "task.update"],
    ["reorder", RequestMethod.POST, ":taskId/reorder", "task.update"],
    ["remove", RequestMethod.DELETE, ":taskId", "task.delete"],
  ] as const)(
    "binds %s to its verb, path and authorization action",
    (handler, method, path, action) => {
      expect(Reflect.getMetadata(METHOD_METADATA, TasksController.prototype[handler])).toBe(method);
      expect(Reflect.getMetadata(PATH_METADATA, TasksController.prototype[handler])).toBe(path);
      expect(specFor(handler).action).toBe(action);
    },
  );

  it("declares bulk before every :taskId route so it is never parsed as an identifier", () => {
    const handlers = Object.getOwnPropertyNames(TasksController.prototype);
    expect(handlers.indexOf("bulk")).toBeLessThan(handlers.indexOf("read"));
    expect(handlers.indexOf("bulk")).toBeLessThan(handlers.indexOf("update"));
    expect(handlers.indexOf("bulk")).toBeLessThan(handlers.indexOf("reorder"));
    expect(handlers.indexOf("bulk")).toBeLessThan(handlers.indexOf("remove"));
  });

  it("answers a create with 201 and leaves the other mutations on their default status", () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, TasksController.prototype.create)).toBe(
      HttpStatus.CREATED,
    );
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, TasksController.prototype.bulk)).toBeUndefined();
  });

  it("selects the workspace resource for collection routes and the task for detail routes", () => {
    const collection = request({ workspaceId });
    const detail = request({ workspaceId, taskId });
    for (const handler of ["list", "create", "bulk"] as const) {
      expect(specFor(handler).workspaceId(collection)).toBe(workspaceId);
      expect(specFor(handler).resource(collection)).toEqual({ kind: "workspace" });
    }
    for (const handler of ["read", "update", "reorder", "remove"] as const) {
      expect(specFor(handler).workspaceId(detail)).toBe(workspaceId);
      expect(specFor(handler).resource(detail)).toEqual({ kind: "task", id: taskId });
    }
  });
});

describe("TasksController boundary enforcement", () => {
  it("enforces trusted origin and an idempotency key before creating", async () => {
    const create = vi.fn().mockResolvedValue({ task: { id: taskId } });
    const origin = vi.fn();
    await controller({ create }, origin).create(request({ workspaceId }), {
      title: "Draft the brief",
      priority: "high",
    });
    expect(origin).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: expect.objectContaining({ userId }),
        workspaceId,
        title: "Draft the brief",
        priority: "high",
        // Contract defaults are resolved here, never left undefined for the service.
        status: "todo",
        recurrence: "none",
        projectId: null,
        noteId: null,
        parentId: null,
        tagIds: [],
        idempotencyKey: "task-create-0000000001",
      }),
    );
  });

  it.each(["create", "bulk"] as const)("rejects %s without a usable idempotency key", (handler) => {
    const method = vi.fn();
    const instance = controller(handler === "create" ? { create: method } : { bulk: method });
    const call = request({ workspaceId }, "short");
    expect(() =>
      handler === "create"
        ? instance.create(call, { title: "Draft" })
        : instance.bulk(call, { taskIds: [taskId], action: { kind: "delete" } }),
    ).toThrow("A valid Idempotency-Key header is required.");
    expect(method).not.toHaveBeenCalled();
  });

  it("enforces trusted origin on every mutating route", async () => {
    const origin = vi.fn();
    const update = vi.fn().mockResolvedValue({ task: { id: taskId }, spawned: null });
    const reorder = vi.fn().mockResolvedValue({ task: { id: taskId } });
    const remove = vi.fn().mockResolvedValue({ id: taskId, deleted: true, affected: 1 });
    const bulk = vi.fn().mockResolvedValue({ updated: [taskId], skipped: [], affected: 1 });
    const instance = controller({ update, reorder, remove, bulk }, origin);
    const detail = request({ workspaceId, taskId });
    await instance.update(detail, { title: "Later" });
    await instance.reorder(detail, { beforeTaskId: otherTaskId });
    await instance.remove(detail);
    await instance.bulk(request({ workspaceId }), {
      taskIds: [taskId],
      action: { kind: "tag", tagIds: [tagId] },
    });
    expect(origin).toHaveBeenCalledTimes(4);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ taskId, title: "Later" }));
    expect(reorder).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, beforeTaskId: otherTaskId }),
    );
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ taskId, workspaceId }));
    expect(bulk).toHaveBeenCalledWith(
      expect.objectContaining({ taskIds: [taskId], action: { kind: "tag", tagIds: [tagId] } }),
    );
  });

  it.each([
    ["create", { title: "" }],
    ["update", {}],
    ["reorder", { beforeTaskId: "not-a-uuid" }],
    ["bulk", { taskIds: [], action: { kind: "delete" } }],
  ] as const)("rejects invalid %s input before touching the service", (handler, body) => {
    const method = vi.fn();
    const origin = vi.fn();
    const instance = controller({ [handler]: method } as unknown as Partial<TasksService>, origin);
    const call = request({ workspaceId, taskId });
    expect(() => {
      if (handler === "create") return instance.create(call, body);
      if (handler === "update") return instance.update(call, body);
      if (handler === "reorder") return instance.reorder(call, body);
      return instance.bulk(call, body);
    }).toThrow("The request is invalid.");
    expect(origin).toHaveBeenCalledOnce();
    expect(method).not.toHaveBeenCalled();
  });

  it("coerces and forwards the list query without accepting unknown filters", async () => {
    const list = vi.fn().mockResolvedValue({ items: [], page: 2, limit: 10, hasMore: false });
    await controller({ list }).list(request({ workspaceId }), {
      page: "2",
      limit: "10",
      status: "in_progress",
      isCompleted: "false",
      grouping: "status",
      sortBy: "dueDate",
      sortDirection: "desc",
    });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        page: 2,
        limit: 10,
        status: "in_progress",
        isCompleted: false,
        grouping: "status",
        sortBy: "dueDate",
        sortDirection: "desc",
      }),
    );
    expect(() => controller({ list }).list(request({ workspaceId }), { overdue: "true" })).toThrow(
      "The request is invalid.",
    );
  });

  it("rejects a recurrence whose cron and recipe disagree at the boundary", () => {
    const create = vi.fn();
    const instance = controller({ create });
    expect(() =>
      instance.create(request({ workspaceId }), { title: "Draft", recurrence: "custom" }),
    ).toThrow("The request is invalid.");
    expect(() =>
      instance.create(request({ workspaceId }), {
        title: "Draft",
        recurrence: "weekly",
        recurrenceCron: "0 9 * * *",
      }),
    ).toThrow("The request is invalid.");
    expect(create).not.toHaveBeenCalled();
  });
});
