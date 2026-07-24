import { describe, expect, it } from "vitest";

import {
  attachmentFilterSchema,
  createAttachmentIntentSchema,
  createNoteMetadataSchema,
  createProjectSchema,
  createTaskSchema,
  createUserProfileSchema,
  createWorkspaceSchema,
  noteMetadataFilterSchema,
  projectFilterSchema,
  searchQuerySchema,
  taskFilterSchema,
  updateAttachmentIntentSchema,
  updateNoteMetadataSchema,
  updateProjectSchema,
  updateTaskSchema,
  updateUserProfileSchema,
  updateWorkspaceSchema,
  userProfileFilterSchema,
  workspaceFilterSchema,
} from "./index";

const workspaceId = "3a202ed4-50ba-4e20-9d6f-8866eae8dd32";
const projectId = "d87953d0-d7db-4d69-8f94-dca8bc61ca68";
const noteId = "4fd034f1-c161-4c52-892b-606456f62390";
const userId = "e7f9b537-8dd7-4f72-b093-195b79fb57e0";
const tagId = "0b957ac0-516a-4b39-a4c1-fc67c415488d";

describe("user profile schemas", () => {
  it("accepts safe profile fields", () => {
    expect(createUserProfileSchema.parse({ name: "Ada Lovelace" })).toEqual({
      name: "Ada Lovelace",
    });
    expect(userProfileFilterSchema.safeParse({ id: userId, name: "Ada" }).success).toBe(true);
  });

  it("rejects empty updates, unknown fields and Better Auth authority fields", () => {
    expect(updateUserProfileSchema.safeParse({}).success).toBe(false);
    expect(updateUserProfileSchema.safeParse({ email: "new@example.com" }).success).toBe(false);
    expect(
      createUserProfileSchema.safeParse({ name: "Ada", password: "NeverCrossThisBoundary1!" })
        .success,
    ).toBe(false);
  });
});

describe("workspace schemas", () => {
  it("accepts bounded create, update and filter inputs", () => {
    expect(
      createWorkspaceSchema.safeParse({
        name: "Product",
        slug: "product-team",
        description: null,
        domain: "notes.example.com",
      }).success,
    ).toBe(true);
    expect(updateWorkspaceSchema.safeParse({ description: null }).success).toBe(true);
    expect(
      workspaceFilterSchema.safeParse({
        id: workspaceId,
        plan: "enterprise",
        currentUserRole: "admin",
      }).success,
    ).toBe(true);
  });

  it("rejects empty updates, invalid slugs/domains, and authority assignment", () => {
    expect(updateWorkspaceSchema.safeParse({}).success).toBe(false);
    expect(createWorkspaceSchema.safeParse({ name: "A", slug: "Upper Case" }).success).toBe(false);
    expect(
      createWorkspaceSchema.safeParse({
        name: "A",
        slug: "valid",
        domain: "https://example.com/private",
      }).success,
    ).toBe(false);
    expect(
      createWorkspaceSchema.safeParse({
        name: "A",
        slug: "valid",
        plan: "enterprise",
        role: "owner",
        createdById: userId,
      }).success,
    ).toBe(false);
  });
});

describe("project schemas", () => {
  it("accepts valid body inputs without coercion and query defaults with coercion", () => {
    expect(
      createProjectSchema.safeParse({
        name: "Launch",
        color: "#3b82f6",
        dueAt: "2026-08-01T00:00:00Z",
      }).success,
    ).toBe(true);
    expect(
      projectFilterSchema.parse({
        workspaceId,
        isArchived: "false",
        page: "2",
      }),
    ).toMatchObject({
      isArchived: false,
      page: 2,
      limit: 25,
      sortBy: "updatedAt",
      sortDirection: "desc",
    });
  });

  it("rejects invalid bodies, empty updates, reversed ranges and mass assignment", () => {
    expect(createProjectSchema.safeParse({ name: "", color: "#fff" }).success).toBe(false);
    expect(updateProjectSchema.safeParse({}).success).toBe(false);
    expect(updateProjectSchema.safeParse({ isArchived: "true" }).success).toBe(false);
    expect(createProjectSchema.safeParse({ name: "Launch", createdById: userId }).success).toBe(
      false,
    );
    expect(createProjectSchema.safeParse({ workspaceId, name: "Launch" }).success).toBe(false);
    expect(
      projectFilterSchema.safeParse({
        workspaceId,
        dueFrom: "2026-08-02T00:00:00Z",
        dueTo: "2026-08-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });
});

describe("note metadata schemas", () => {
  it("accepts safe metadata while leaving content out of the contract", () => {
    expect(
      createNoteMetadataSchema.safeParse({
        projectId,
        title: "Architecture notes",
        type: "document",
        pageSize: "a4",
        isTemplate: false,
        tagIds: [tagId],
      }).success,
    ).toBe(true);
    expect(
      noteMetadataFilterSchema.parse({ workspaceId, isPinned: "true", limit: "100" }),
    ).toMatchObject({ isPinned: true, page: 1, limit: 100 });
  });

  it("rejects editor data, tenant authority, string booleans in bodies and empty updates", () => {
    expect(updateNoteMetadataSchema.safeParse({}).success).toBe(false);
    expect(updateNoteMetadataSchema.safeParse({ isPinned: "true" }).success).toBe(false);
    expect(
      createNoteMetadataSchema.safeParse({
        title: "Private",
        content: { type: "doc", content: [] },
      }).success,
    ).toBe(false);
    expect(
      updateNoteMetadataSchema.safeParse({ workspaceId, createdById: userId, title: "Changed" })
        .success,
    ).toBe(false);
  });
});

describe("attachment intent schemas", () => {
  it("accepts bounded metadata and supports strict filtering", () => {
    expect(
      createAttachmentIntentSchema.safeParse({
        noteId,
        displayName: "roadmap.pdf",
        mimeType: "application/pdf",
        sizeBytes: 5_000,
      }).success,
    ).toBe(true);
    expect(
      attachmentFilterSchema.parse({ workspaceId, noteId, page: "1", limit: "25" }),
    ).toMatchObject({ page: 1, limit: 25, sortBy: "createdAt" });
  });

  it("rejects unsafe names, oversized/string sizes, storage secrets and empty updates", () => {
    expect(updateAttachmentIntentSchema.safeParse({}).success).toBe(false);
    expect(
      createAttachmentIntentSchema.safeParse({
        noteId,
        displayName: "../secret.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
      }).success,
    ).toBe(false);
    expect(
      createAttachmentIntentSchema.safeParse({
        noteId,
        displayName: "file.txt",
        mimeType: "text/plain",
        sizeBytes: "10",
      }).success,
    ).toBe(false);
    expect(
      createAttachmentIntentSchema.safeParse({
        noteId,
        displayName: "large.zip",
        mimeType: "application/zip",
        sizeBytes: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect(
      createAttachmentIntentSchema.safeParse({
        noteId,
        displayName: "file.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
        storageKey: "workspace/private/file",
        signedUrl: "https://storage.example.invalid/signed",
      }).success,
    ).toBe(false);
    expect(
      createAttachmentIntentSchema.safeParse({
        workspaceId,
        noteId,
        displayName: "file.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
      }).success,
    ).toBe(false);
  });
});

describe("search schema", () => {
  it("accepts documented filters and explicit query coercion", () => {
    expect(
      searchQuerySchema.parse({
        workspaceId,
        query: "quarterly plan",
        projectId,
        hasAttachments: "true",
        page: "2",
      }),
    ).toMatchObject({
      mode: "full-text",
      hasAttachments: true,
      page: 2,
      limit: 25,
      sortBy: "relevance",
    });
  });

  it("rejects empty queries, unknown filters and reversed dates", () => {
    expect(searchQuerySchema.safeParse({ workspaceId, query: " " }).success).toBe(false);
    expect(
      searchQuerySchema.safeParse({ workspaceId, query: "plan", embedding: [0.1, 0.2] }).success,
    ).toBe(false);
    expect(
      searchQuerySchema.safeParse({
        workspaceId,
        query: "plan",
        createdFrom: "2026-08-02T00:00:00Z",
        createdTo: "2026-08-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });
});

describe("task schemas", () => {
  it("accepts standalone task metadata and documented filter coercion", () => {
    expect(
      createTaskSchema.safeParse({
        projectId,
        noteId,
        title: "Review proposal",
        priority: "high",
        assigneeId: userId,
        dueAt: "2026-08-01T12:00:00Z",
        position: 0,
        tagIds: [tagId],
        recurrence: "weekly",
      }).success,
    ).toBe(true);
    expect(
      taskFilterSchema.parse({
        workspaceId,
        isCompleted: "false",
        page: "3",
      }),
    ).toMatchObject({
      isCompleted: false,
      page: 3,
      limit: 25,
      sortBy: "position",
      sortDirection: "asc",
    });
  });

  it("rejects string body numbers, empty updates, unknown authority and reversed dates", () => {
    expect(updateTaskSchema.safeParse({}).success).toBe(false);
    expect(createTaskSchema.safeParse({ title: "Task", position: "0" }).success).toBe(false);
    expect(
      createTaskSchema.safeParse({
        title: "Task",
        position: 0,
        createdById: userId,
      }).success,
    ).toBe(false);
    expect(createTaskSchema.safeParse({ workspaceId, title: "Task", position: 0 }).success).toBe(
      false,
    );
    expect(
      taskFilterSchema.safeParse({
        workspaceId,
        dueFrom: "2026-08-02T00:00:00Z",
        dueTo: "2026-08-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });
});
