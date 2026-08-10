import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import { createTrpcContext } from "../trpc/trpc.context";
import { trpc } from "../trpc/trpc.router";

import { TasksTrpcRouter } from "./tasks.trpc";

import type { TasksService } from "./tasks.service";
import type { AuthService } from "../auth/auth.service";
import type { Request } from "express";

const workspaceId = "80000000-0000-4000-8000-000000000001";
const taskId = "80000000-0000-4000-8000-000000000002";
const otherTaskId = "80000000-0000-4000-8000-000000000003";
const userId = "80000000-0000-4000-8000-000000000004";
const tagId = "80000000-0000-4000-8000-000000000005";

const summary = Object.freeze({
  id: taskId,
  workspaceId,
  projectId: null,
  noteId: null,
  parentId: null,
  title: "Draft the brief",
  status: "todo",
  customStatusId: null,
  statusLabel: null,
  priority: "low",
  assigneeId: null,
  dueDate: null,
  completedAt: null,
  sortOrder: 1,
  recurrence: "none",
  recurrenceCron: null,
  tagIds: [],
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
});

const detail = Object.freeze({
  ...summary,
  description: null,
  createdById: userId,
  updatedById: userId,
});

function request(authenticated = true): Request {
  const value = {
    header: (name: string) =>
      name.toLowerCase() === "idempotency-key"
        ? "task-trpc-key-00000001"
        : "https://app.notted.test",
  } as unknown as Request;
  if (authenticated) {
    setAuthPrincipal(value, {
      userId,
      sessionId: "session",
      method: "opaque-session",
      assurance: "single-factor",
      authenticatedAt: "2026-03-01T00:00:00.000Z",
      expiresAt: "2026-03-02T00:00:00.000Z",
      isFresh: true,
    });
  }
  return value;
}

function caller(service: Partial<TasksService>, origin = vi.fn()) {
  const transport = new TasksTrpcRouter(
    service as TasksService,
    {
      assertTrustedMutationOrigin: origin,
    } as unknown as AuthService,
  );
  return trpc.router({ task: transport.taskRouter }).createCaller(createTrpcContext(request()));
}

describe("Part 47 composable task tRPC transport", () => {
  it("exposes the full task surface and delegates the REST Zod contracts verbatim", async () => {
    const list = vi
      .fn()
      .mockResolvedValue({ items: [summary], page: 1, limit: 25, hasMore: false });
    const read = vi.fn().mockResolvedValue(detail);
    const create = vi.fn().mockResolvedValue({ task: detail });
    const update = vi.fn().mockResolvedValue({ task: detail, spawned: null });
    const reorder = vi.fn().mockResolvedValue({ task: summary });
    const remove = vi.fn().mockResolvedValue({ id: taskId, deleted: true, affected: 1 });
    const bulk = vi.fn().mockResolvedValue({
      updated: [taskId],
      skipped: [{ taskId: otherTaskId, reason: "unavailable" }],
      affected: 1,
    });
    const origin = vi.fn();
    const client = caller({ list, read, create, update, reorder, remove, bulk }, origin);

    await client.task.list({ workspaceId, query: {} });
    await client.task.read({ workspaceId, taskId });
    await client.task.create({ workspaceId, data: { title: "Draft the brief" } });
    await client.task.update({ workspaceId, taskId, data: { status: "done" } });
    await client.task.reorder({ workspaceId, taskId, data: { beforeTaskId: otherTaskId } });
    await client.task.delete({ workspaceId, taskId });
    await client.task.bulk({
      workspaceId,
      data: { taskIds: [taskId, otherTaskId], action: { kind: "tag", tagIds: [tagId] } },
    });

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, page: 1, limit: 25, sortBy: "sortOrder" }),
    );
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, taskId }));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Draft the brief",
        status: "todo",
        recurrence: "none",
        tagIds: [],
        idempotencyKey: "task-trpc-key-00000001",
      }),
    );
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ taskId, status: "done" }));
    expect(reorder).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, beforeTaskId: otherTaskId }),
    );
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ taskId, workspaceId }));
    expect(bulk).toHaveBeenCalledWith(
      expect.objectContaining({
        taskIds: [taskId, otherTaskId],
        action: { kind: "tag", tagIds: [tagId] },
        idempotencyKey: "task-trpc-key-00000001",
      }),
    );
    // Every mutation, and only the mutations, re-proves a trusted origin.
    expect(origin).toHaveBeenCalledTimes(5);
  });

  it("denies unauthenticated callers before service invocation", async () => {
    const list = vi.fn();
    const transport = new TasksTrpcRouter({ list } as unknown as TasksService, {} as AuthService);
    const rejection = trpc
      .router({ task: transport.taskRouter })
      .createCaller(createTrpcContext(request(false)))
      .task.list({ workspaceId, query: {} });
    await expect(rejection).rejects.toBeInstanceOf(TRPCError);
    await expect(rejection).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(list).not.toHaveBeenCalled();
  });

  it("rejects an empty update, an unknown field and a bad recurrence at the boundary", async () => {
    const update = vi.fn();
    const client = caller({ update });
    await expect(
      client.task.update({ workspaceId, taskId, data: {} } as never),
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      client.task.update({ workspaceId, taskId, data: { statusLabel: "Doing" } } as never),
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      client.task.update({ workspaceId, taskId, data: { recurrence: "custom" } } as never),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a bulk batch with duplicate identifiers before the service sees it", async () => {
    const bulk = vi.fn();
    const client = caller({ bulk });
    await expect(
      client.task.bulk({
        workspaceId,
        data: { taskIds: [taskId, taskId], action: { kind: "delete" } },
      }),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(bulk).not.toHaveBeenCalled();
  });
});
