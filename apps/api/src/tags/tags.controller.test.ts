import { HttpStatus, RequestMethod } from "@nestjs/common";
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { TAG_API_PATHS } from "@notted/shared-types";
import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import {
  AUTHORIZATION_HTTP_SPEC,
  type HttpAuthorizationSpec,
} from "../authorization/authorization-http.decorator";

import { TagsController } from "./tags.controller";

import type { TagsService } from "./tags.service";
import type { AuthService } from "../auth/auth.service";
import type { Request } from "express";

const userId = "40000000-0000-4000-8000-000000000001";
const workspaceId = "40000000-0000-4000-8100-000000000001";
const tagId = "40000000-0000-4000-8200-000000000001";

function request(
  params: Record<string, string> = {},
  idempotencyKey = "tag-create-0000000001",
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

function controller(service: Partial<TagsService>, origin = vi.fn()): TagsController {
  return new TagsController(
    service as TagsService,
    {
      assertTrustedMutationOrigin: origin,
    } as unknown as AuthService,
  );
}

function specFor(handler: keyof TagsController): HttpAuthorizationSpec {
  const spec: unknown = Reflect.getMetadata(
    AUTHORIZATION_HTTP_SPEC,
    TagsController.prototype[handler],
  );
  if (spec === undefined) throw new Error(`missing authorization spec for ${handler}`);
  return spec as HttpAuthorizationSpec;
}

describe("TagsController", () => {
  it("publishes the final canonical REST paths under the versioned prefix", () => {
    expect(TAG_API_PATHS.collection(":workspaceId")).toBe("/api/v1/workspaces/:workspaceId/tags");
    expect(TAG_API_PATHS.detail(":workspaceId", ":tagId")).toBe(
      "/api/v1/workspaces/:workspaceId/tags/:tagId",
    );
    expect(Reflect.getMetadata(PATH_METADATA, TagsController)).toBe("workspaces/:workspaceId/tags");
  });

  it.each([
    ["list", RequestMethod.GET, "tag.read"],
    ["create", RequestMethod.POST, "tag.create"],
    ["update", RequestMethod.PATCH, "tag.update"],
    ["remove", RequestMethod.DELETE, "tag.delete"],
  ] as const)("binds %s to its verb and authorization action", (handler, method, action) => {
    expect(Reflect.getMetadata(METHOD_METADATA, TagsController.prototype[handler])).toBe(method);
    expect(specFor(handler).action).toBe(action);
  });

  it("answers a create with 201", () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, TagsController.prototype.create)).toBe(
      HttpStatus.CREATED,
    );
  });

  it("selects the workspace resource for collection routes and the tag for detail routes", () => {
    const collection = request({ workspaceId });
    const detail = request({ workspaceId, tagId });
    for (const handler of ["list", "create"] as const) {
      expect(specFor(handler).workspaceId(collection)).toBe(workspaceId);
      expect(specFor(handler).resource(collection)).toEqual({ kind: "workspace" });
    }
    for (const handler of ["update", "remove"] as const) {
      expect(specFor(handler).workspaceId(detail)).toBe(workspaceId);
      expect(specFor(handler).resource(detail)).toEqual({ kind: "tag", id: tagId });
    }
  });

  it("enforces trusted origin and an idempotency key before creating", async () => {
    const create = vi.fn().mockResolvedValue({ tag: { id: tagId } });
    const origin = vi.fn();
    await controller({ create }, origin).create(request({ workspaceId }), {
      name: "Roadmap",
      color: "#ABCDEF",
    });
    expect(origin).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: expect.objectContaining({ userId }),
        workspaceId,
        name: "Roadmap",
        color: "#abcdef",
        idempotencyKey: "tag-create-0000000001",
      }),
    );
  });

  it("rejects a create without a usable idempotency key", () => {
    const create = vi.fn();
    expect(() =>
      controller({ create }).create(request({ workspaceId }, "short"), {
        name: "Roadmap",
      }),
    ).toThrow("A valid Idempotency-Key header is required.");
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["create", { name: "" }],
    ["update", { color: "red" }],
  ] as const)("rejects invalid %s input before touching the service", (handler, body) => {
    const method = vi.fn();
    const origin = vi.fn();
    const instance = controller(
      handler === "create" ? { create: method } : { update: method },
      origin,
    );
    expect(() =>
      handler === "create"
        ? instance.create(request({ workspaceId }), body)
        : instance.update(request({ workspaceId, tagId }), body),
    ).toThrow("The request is invalid.");
    expect(origin).toHaveBeenCalledOnce();
    expect(method).not.toHaveBeenCalled();
  });

  it("enforces trusted origin on update and delete", async () => {
    const update = vi.fn().mockResolvedValue({ tag: { id: tagId } });
    const remove = vi.fn().mockResolvedValue({ tagId, deleted: true });
    const origin = vi.fn();
    const instance = controller({ update, remove }, origin);
    await instance.update(request({ workspaceId, tagId }), { name: "Later" });
    await instance.remove(request({ workspaceId, tagId }));
    expect(origin).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ tagId, name: "Later" }));
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ tagId, workspaceId }));
  });

  it("coerces and forwards the list query without accepting unknown filters", async () => {
    const list = vi.fn().mockResolvedValue({ items: [], page: 2, limit: 10, hasMore: false });
    await controller({ list }).list(request({ workspaceId }), {
      page: "2",
      limit: "10",
      name: "road",
      sortBy: "usage",
      sortDirection: "desc",
    });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        page: 2,
        limit: 10,
        name: "road",
        sortBy: "usage",
        sortDirection: "desc",
      }),
    );
    expect(() => controller({ list }).list(request({ workspaceId }), { workspaceId })).toThrow(
      "The request is invalid.",
    );
  });
});
