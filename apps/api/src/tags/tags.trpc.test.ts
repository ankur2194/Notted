import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import { createTrpcContext } from "../trpc/trpc.context";
import { trpc } from "../trpc/trpc.router";

import { TagsTrpcRouter } from "./tags.trpc";

import type { TagsService } from "./tags.service";
import type { AuthService } from "../auth/auth.service";
import type { Request } from "express";

const workspaceId = "50000000-0000-4000-8000-000000000001";
const tagId = "50000000-0000-4000-8000-000000000002";
const userId = "50000000-0000-4000-8000-000000000003";

const summary = Object.freeze({
  id: tagId,
  workspaceId,
  name: "Roadmap",
  color: "#6b7280",
  noteCount: 0,
  taskCount: 0,
  createdAt: "2026-08-01T00:00:00.000Z",
});

function request(authenticated = true): Request {
  const value = {
    header: (name: string) =>
      name.toLowerCase() === "idempotency-key"
        ? "tag-trpc-key-00000001"
        : "https://app.notted.test",
  } as unknown as Request;
  if (authenticated) {
    setAuthPrincipal(value, {
      userId,
      sessionId: "session",
      method: "opaque-session",
      assurance: "single-factor",
      authenticatedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-02T00:00:00.000Z",
      isFresh: true,
    });
  }
  return value;
}

function caller(service: Partial<TagsService>, origin = vi.fn()) {
  const transport = new TagsTrpcRouter(
    service as TagsService,
    {
      assertTrustedMutationOrigin: origin,
    } as unknown as AuthService,
  );
  return trpc.router({ tag: transport.tagRouter }).createCaller(createTrpcContext(request()));
}

describe("Part 46 composable tag tRPC transport", () => {
  it("delegates the same strict contracts the REST surface uses", async () => {
    const create = vi.fn().mockResolvedValue({ tag: summary });
    const update = vi.fn().mockResolvedValue({ tag: summary });
    const remove = vi.fn().mockResolvedValue({
      tagId,
      deleted: true,
      removedNoteAssignments: 2,
      removedTaskAssignments: 1,
    });
    const list = vi
      .fn()
      .mockResolvedValue({ items: [summary], page: 1, limit: 25, hasMore: false });
    const origin = vi.fn();
    const client = caller({ create, update, remove, list }, origin);

    await client.tag.list({ workspaceId, query: {} });
    await client.tag.create({ workspaceId, data: { name: "Roadmap" } });
    await client.tag.update({ workspaceId, tagId, data: { color: "#ABCDEF" } });
    await client.tag.delete({ workspaceId, tagId });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        name: "Roadmap",
        color: "#6b7280",
        idempotencyKey: "tag-trpc-key-00000001",
      }),
    );
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ tagId, color: "#abcdef" }));
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ tagId, workspaceId }));
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, page: 1, limit: 25, sortBy: "name" }),
    );
    // Every mutation, and only the mutations, re-proves a trusted origin.
    expect(origin).toHaveBeenCalledTimes(3);
  });

  it("denies unauthenticated callers before service invocation", async () => {
    const list = vi.fn();
    const transport = new TagsTrpcRouter({ list } as unknown as TagsService, {} as AuthService);
    const rejection = trpc
      .router({ tag: transport.tagRouter })
      .createCaller(createTrpcContext(request(false)))
      .tag.list({ workspaceId, query: {} });
    await expect(rejection).rejects.toBeInstanceOf(TRPCError);
    await expect(rejection).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(list).not.toHaveBeenCalled();
  });

  it("rejects an empty tag update and an unknown field at the boundary", async () => {
    const update = vi.fn();
    const client = caller({ update });
    await expect(
      client.tag.update({ workspaceId, tagId, data: {} } as never),
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      client.tag.update({ workspaceId, tagId, data: { noteCount: 4 } } as never),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(update).not.toHaveBeenCalled();
  });
});
