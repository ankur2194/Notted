import { describe, expect, it } from "vitest";

import {
  createProjectSchema,
  projectCoverImageUrlSchema,
  projectCreateResultSchema,
  projectDeleteResultSchema,
  projectDetailSchema,
  projectListQuerySchema,
  projectPageSchema,
  projectStatusResultSchema,
  projectUpdateResultSchema,
  updateProjectSchema,
} from "./project.schema";

const id = "20000000-0000-4000-8000-000000000001";
const timestamp = "2026-08-01T10:15:30+05:30";

describe("project schemas", () => {
  it("accepts strict six-digit colors and rejects malformed colors", () => {
    expect(createProjectSchema.safeParse({ name: "Alpha", color: "#a1B2c3" }).success).toBe(true);
    for (const color of ["a1b2c3", "#fff", "#gg0000", "#1234567"]) {
      expect(createProjectSchema.safeParse({ name: "Alpha", color }).success).toBe(false);
    }
  });

  it("accepts offset timestamps and null clears while rejecting timezone-less values", () => {
    expect(createProjectSchema.safeParse({ name: "Alpha", dueAt: timestamp }).success).toBe(true);
    expect(updateProjectSchema.safeParse({ dueAt: null }).success).toBe(true);
    expect(updateProjectSchema.safeParse({ dueAt: "2026-08-01T10:15:30" }).success).toBe(false);
  });

  it("allows only canonical app-relative attachment references", () => {
    expect(projectCoverImageUrlSchema.safeParse(`/api/v1/attachments/${id}`).success).toBe(true);
    for (const value of [
      "javascript:alert(1)",
      "data:image/png;base64,AA==",
      "http://cdn.example.test/cover.png",
      "https://cdn.example.test/covers/alpha.webp",
      "https://user:password@example.test/cover.png",
      "//example.test/cover.png",
      `/api/v1/files/${id}`,
      `/api/v1/attachments/${id}?token=secret`,
      `/api/v1/attachments/${id}#fragment`,
      "https://example.test/cover\u0000.png",
    ]) {
      expect(projectCoverImageUrlSchema.safeParse(value).success).toBe(false);
    }
  });

  it("parses bounded route-scoped filters, pagination, and stable sort defaults", () => {
    const parsed = projectListQuerySchema.parse({
      page: "2",
      limit: "50",
      status: "completed",
      archived: "false",
      dueFrom: "2026-08-01T00:00:00Z",
      dueTo: "2026-09-01T00:00:00Z",
      name: "Launch",
    });
    expect(parsed).toMatchObject({
      page: 2,
      limit: 50,
      archived: false,
      sortBy: "updatedAt",
      sortDirection: "desc",
    });
    expect(projectListQuerySchema.safeParse({ workspaceId: id }).success).toBe(false);
    expect(projectListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(projectListQuerySchema.safeParse({ page: "10001" }).success).toBe(false);
    expect(
      projectListQuerySchema.safeParse({
        dueFrom: "2026-09-01T00:00:00Z",
        dueTo: "2026-08-01T00:00:00Z",
      }).success,
    ).toBe(false);
    expect(projectListQuerySchema.safeParse({ sortBy: "description" }).success).toBe(false);
  });

  it("validates public output, dueAt naming, status mirror, and strict fields", () => {
    const detail = {
      id,
      workspaceId: "20000000-0000-4000-8100-000000000001",
      name: "Alpha",
      description: null,
      coverImageUrl: null,
      color: "#3b82f6",
      status: "archived",
      isArchived: true,
      isRestricted: true,
      dueAt: timestamp,
      createdById: "20000000-0000-4000-8200-000000000001",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: "2026-08-02T00:00:00.000Z",
      members: [
        {
          userId: "20000000-0000-4000-8200-000000000002",
          name: "Ada Lovelace",
          avatarUrl: null,
          workspaceRole: "editor",
          projectRole: "editor",
          accessSource: "project",
        },
      ],
      taskProgress: { coverage: "tasks-and-checklists", completed: 2, total: 3 },
    };
    expect(projectDetailSchema.safeParse(detail).success).toBe(true);
    expect(projectDetailSchema.safeParse({ ...detail, dueDate: timestamp }).success).toBe(false);
    expect(projectDetailSchema.safeParse({ ...detail, isArchived: false }).success).toBe(false);
    const summary = {
      id: detail.id,
      workspaceId: detail.workspaceId,
      name: detail.name,
      description: detail.description,
      coverImageUrl: detail.coverImageUrl,
      color: detail.color,
      status: detail.status,
      isArchived: detail.isArchived,
      isRestricted: detail.isRestricted,
      dueAt: detail.dueAt,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
    };
    expect(
      projectPageSchema.safeParse({ items: [summary], page: 1, limit: 25, hasMore: false }).success,
    ).toBe(true);
    expect(
      projectPageSchema.safeParse({ items: [detail], page: 1, limit: 25, hasMore: false }).success,
    ).toBe(false);
    const mutationDetail = {
      id: detail.id,
      workspaceId: detail.workspaceId,
      name: detail.name,
      description: detail.description,
      coverImageUrl: detail.coverImageUrl,
      color: detail.color,
      status: detail.status,
      isArchived: detail.isArchived,
      isRestricted: detail.isRestricted,
      dueAt: detail.dueAt,
      createdById: detail.createdById,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
    };
    for (const schema of [
      projectCreateResultSchema,
      projectUpdateResultSchema,
      projectStatusResultSchema,
    ]) {
      expect(schema.safeParse({ project: mutationDetail }).success).toBe(true);
      expect(schema.safeParse({ project: mutationDetail, internal: true }).success).toBe(false);
    }
    expect(projectDeleteResultSchema.safeParse({ id, deleted: true }).success).toBe(true);
    expect(projectDeleteResultSchema.safeParse({ id, deleted: false }).success).toBe(false);
  });

  it("requires truthful member, activity, and standalone-task detail projections", () => {
    const base = {
      id,
      workspaceId: "20000000-0000-4000-8100-000000000001",
      name: "Alpha",
      description: null,
      coverImageUrl: null,
      color: "#3b82f6",
      status: "active",
      isArchived: false,
      isRestricted: false,
      dueAt: null,
      createdById: "20000000-0000-4000-8200-000000000001",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
      members: [],
      taskProgress: { coverage: "tasks-and-checklists", completed: 0, total: 0 },
    };
    expect(projectDetailSchema.safeParse(base).success).toBe(true);
    expect(
      projectDetailSchema.safeParse({
        ...base,
        taskProgress: { ...base.taskProgress, completed: 1 },
      }).success,
    ).toBe(false);
    expect(
      projectDetailSchema.safeParse({
        ...base,
        members: [
          {
            userId: id,
            name: "A",
            avatarUrl: null,
            workspaceRole: "viewer",
            projectRole: null,
            accessSource: "project",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      projectDetailSchema.safeParse({
        ...base,
        members: [
          {
            userId: id,
            name: "A",
            avatarUrl: null,
            workspaceRole: "viewer",
            projectRole: "viewer",
            accessSource: "project",
          },
        ],
      }).success,
    ).toBe(true);
    expect(projectDetailSchema.safeParse({ ...base, taskProgress: undefined }).success).toBe(false);
  });

  it("keeps create and update bodies strict and update non-empty", () => {
    expect(createProjectSchema.safeParse({ name: "Alpha", unknown: true }).success).toBe(false);
    expect(updateProjectSchema.safeParse({}).success).toBe(false);
    expect(updateProjectSchema.safeParse({ coverImageUrl: null }).success).toBe(true);
  });
});
