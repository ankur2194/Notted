import { RequestMethod } from "@nestjs/common";
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { PROJECT_API_PATHS } from "@notted/shared-types";
import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import {
  AUTHORIZATION_HTTP_SPEC,
  type HttpAuthorizationSpec,
} from "../authorization/authorization-http.decorator";

import { ProjectsController } from "./projects.controller";

import type { ProjectsService } from "./projects.service";
import type { AuthService } from "../auth/auth.service";
import type { Request } from "express";

const userId = "20000000-0000-4000-8000-000000000001";
const workspaceId = "20000000-0000-4000-8100-000000000001";
const projectId = "20000000-0000-4000-8200-000000000001";

function request(params: Record<string, string> = {}): Request {
  const value = {
    params,
    header: (name: string) =>
      name.toLowerCase() === "idempotency-key"
        ? "project-create-000000001"
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

function controller(service: Partial<ProjectsService>, origin = vi.fn()): ProjectsController {
  return new ProjectsController(
    service as ProjectsService,
    { assertTrustedMutationOrigin: origin } as unknown as AuthService,
  );
}

describe("ProjectsController", () => {
  it("publishes the final canonical REST paths", () => {
    expect(PROJECT_API_PATHS).toEqual({
      collection: "/api/v1/workspaces/:workspaceId/projects",
      member: "/api/v1/workspaces/:workspaceId/projects/:projectId",
      archive: "/api/v1/workspaces/:workspaceId/projects/:projectId/archive",
      complete: "/api/v1/workspaces/:workspaceId/projects/:projectId/complete",
      restore: "/api/v1/workspaces/:workspaceId/projects/:projectId/restore",
    });
    expect(Reflect.getMetadata(PATH_METADATA, ProjectsController)).toBe(
      "workspaces/:workspaceId/projects",
    );
  });

  it("validates and delegates create after trusted-origin enforcement", async () => {
    const create = vi.fn().mockResolvedValue({ project: { id: projectId } });
    const origin = vi.fn();
    await controller({ create }, origin).create(request({ workspaceId }), {
      name: "Alpha",
      color: "#abcdef",
      dueAt: "2026-08-01T10:00:00+05:30",
      coverImageUrl: `/api/v1/attachments/${projectId}`,
    });
    expect(origin).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: expect.objectContaining({ userId }),
        workspaceId,
        name: "Alpha",
        color: "#abcdef",
        dueAt: "2026-08-01T10:00:00+05:30",
        coverImageUrl: `/api/v1/attachments/${projectId}`,
        idempotencyKey: "project-create-000000001",
      }),
    );
  });

  it("rejects unsafe mutation input and does not call the service", () => {
    const create = vi.fn();
    const origin = vi.fn();
    expect(() =>
      controller({ create }, origin).create(request({ workspaceId }), {
        name: "Alpha",
        color: "red",
        coverImageUrl: "javascript:alert(1)",
      }),
    ).toThrow("The request is invalid.");
    expect(origin).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it("maps pagination/filter/sort without accepting a duplicated workspace query selector", async () => {
    const list = vi.fn().mockResolvedValue({ items: [], page: 2, limit: 10, hasMore: false });
    await controller({ list }).list(request({ workspaceId }), {
      page: "2",
      limit: "10",
      archived: "true",
      sortBy: "dueAt",
      sortDirection: "asc",
    });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        page: 2,
        limit: 10,
        archived: true,
        sortBy: "dueAt",
        sortDirection: "asc",
      }),
    );
    expect(() => controller({ list }).list(request({ workspaceId }), { workspaceId })).toThrow(
      "The request is invalid.",
    );
  });

  it("requires trusted origin and maps every status/delete route to the service", async () => {
    const service = {
      archive: vi.fn().mockResolvedValue({}),
      complete: vi.fn().mockResolvedValue({}),
      restore: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({ id: projectId, deleted: true }),
    };
    const origin = vi.fn();
    const transport = controller(service, origin);
    const req = request({ workspaceId, projectId });
    await transport.archive(req);
    await transport.complete(req);
    await transport.restore(req);
    await transport.delete(req);
    for (const method of [service.archive, service.complete, service.restore, service.delete]) {
      expect(method).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, projectId }));
    }
    expect(origin).toHaveBeenCalledTimes(4);
  });

  it("returns the service-owned truthful detail projection without transport queries", async () => {
    const detail = {
      id: projectId,
      workspaceId,
      name: "Alpha",
      lastActivityAt: "2026-08-03T00:00:00.000Z",
      members: [],
      taskProgress: { coverage: "tasks-and-checklists", completed: 1, total: 2 },
    };
    const read = vi.fn().mockResolvedValue(detail);
    await expect(controller({ read }).read(request({ workspaceId, projectId }))).resolves.toBe(
      detail,
    );
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, projectId }));
  });

  it("wires centralized actions, resources, methods, and success statuses", () => {
    const specs = {
      list: { action: "workspace.read", kind: "workspace" },
      create: { action: "project.create", kind: "workspace" },
      read: { action: "project.read", kind: "project" },
      update: { action: "project.update", kind: "project" },
      archive: { action: "project.update", kind: "project" },
      complete: { action: "project.update", kind: "project" },
      restore: { action: "project.update", kind: "project" },
      delete: { action: "project.delete", kind: "project" },
    } as const;
    const req = request({ workspaceId, projectId });
    for (const [name, expected] of Object.entries(specs)) {
      const handler = ProjectsController.prototype[name as keyof typeof specs];
      const spec = Reflect.getMetadata(AUTHORIZATION_HTTP_SPEC, handler) as HttpAuthorizationSpec;
      expect(spec.action).toBe(expected.action);
      expect(spec.workspaceId(req)).toBe(workspaceId);
      expect(spec.resource(req)).toEqual(
        expected.kind === "workspace" ? { kind: "workspace" } : { kind: "project", id: projectId },
      );
    }
    expect(Reflect.getMetadata(METHOD_METADATA, ProjectsController.prototype.create)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, ProjectsController.prototype.create)).toBe(201);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, ProjectsController.prototype.archive)).toBe(200);
    expect(Reflect.getMetadata(METHOD_METADATA, ProjectsController.prototype.delete)).toBe(
      RequestMethod.DELETE,
    );
    expect(Reflect.getMetadata(PATH_METADATA, ProjectsController.prototype.read)).toBe(
      ":projectId",
    );
    expect(Reflect.getMetadata(PATH_METADATA, ProjectsController.prototype.archive)).toBe(
      ":projectId/archive",
    );
    expect(Reflect.getMetadata(PATH_METADATA, ProjectsController.prototype.complete)).toBe(
      ":projectId/complete",
    );
    expect(Reflect.getMetadata(PATH_METADATA, ProjectsController.prototype.restore)).toBe(
      ":projectId/restore",
    );
  });

  it("makes malformed and cross-workspace selectors indistinguishable to authorization", () => {
    const spec = Reflect.getMetadata(
      AUTHORIZATION_HTTP_SPEC,
      ProjectsController.prototype.read,
    ) as HttpAuthorizationSpec;
    expect(() => spec.workspaceId(request({ workspaceId: "not-a-uuid", projectId }))).toThrow();
    expect(spec.resource(request({ workspaceId, projectId }))).toEqual({
      kind: "project",
      id: projectId,
    });
    // The selector carries both IDs to Part 24; the repository then scopes the
    // project by active workspace and returns the same concealed 404 for a
    // guessed project or a real project in another workspace.
  });
});
