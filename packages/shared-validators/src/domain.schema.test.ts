import { describe, expect, it } from "vitest";

import {
  attachmentFilterSchema,
  bulkTaskSchema,
  copyNoteSchema,
  createAttachmentIntentSchema,
  createNoteMetadataSchema,
  createProjectSchema,
  createTagSchema,
  createTaskSchema,
  createUserProfileSchema,
  createWorkspaceSchema,
  noteMetadataFilterSchema,
  projectFilterSchema,
  searchQuerySchema,
  TAG_DEFAULT_COLOR,
  tagColorSchema,
  tagIdsSchema,
  tagListQuerySchema,
  tagNameSchema,
  taskListQuerySchema,
  taskRecurrenceSchema,
  taskStatusSchema,
  taskSummarySchema,
  updateAttachmentIntentSchema,
  updateNoteMetadataSchema,
  updateProjectSchema,
  updateTagSchema,
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
const taskId = "1f0a3c2e-9b41-4f7c-8f2a-6d5c4b3a2e10";

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

describe("note API schemas", () => {
  it("accepts safe metadata plus the Part 31 transitional document", () => {
    expect(
      createNoteMetadataSchema.safeParse({
        projectId,
        title: "Architecture notes",
        type: "document",
        pageSize: "a4",
        isTemplate: false,
        tagIds: [tagId],
        content: { type: "doc", content: [] },
      }).success,
    ).toBe(true);
    expect(
      noteMetadataFilterSchema.parse({ scope: "workspace-root", isPinned: "true", limit: "100" }),
    ).toMatchObject({ isPinned: true, page: 1, limit: 100 });
  });

  it("rejects forged projections, tenant authority, string booleans and missing versions", () => {
    expect(updateNoteMetadataSchema.safeParse({}).success).toBe(false);
    expect(updateNoteMetadataSchema.safeParse({ isPinned: "true" }).success).toBe(false);
    expect(
      createNoteMetadataSchema.safeParse({
        title: "Private",
        content: { type: "doc", content: [] },
        contentPlain: "forged",
      }).success,
    ).toBe(false);
    expect(
      updateNoteMetadataSchema.safeParse({
        expectedVersion: 1,
        workspaceId,
        createdById: userId,
        title: "Changed",
      }).success,
    ).toBe(false);
  });
});

describe("note copy schema", () => {
  it("defaults the template flag and tag carry-over, and accepts explicit null placement", () => {
    expect(copyNoteSchema.parse({})).toEqual({ asTemplate: false, includeTags: true });
    expect(
      copyNoteSchema.safeParse({
        asTemplate: true,
        title: "Weekly review template",
        projectId: null,
        folderId: null,
        parentId: null,
        includeTags: false,
      }).success,
    ).toBe(true);
  });

  it("rejects unknown fields such as a forged source link", () => {
    expect(copyNoteSchema.safeParse({ sourceNoteId: noteId }).success).toBe(false);
    expect(copyNoteSchema.safeParse({ asTemplate: "true" }).success).toBe(false);
  });
});

describe("tag schemas", () => {
  it("normalizes colors, trims names and applies documented defaults", () => {
    expect(tagColorSchema.parse("#6b7280")).toBe("#6b7280");
    expect(tagColorSchema.parse("#FFF000")).toBe("#fff000");
    expect(tagNameSchema.parse("  Roadmap  ")).toBe("Roadmap");
    expect(tagNameSchema.safeParse("a".repeat(50)).success).toBe(true);
    expect(createTagSchema.parse({ name: "Roadmap" })).toEqual({
      name: "Roadmap",
      color: TAG_DEFAULT_COLOR,
    });
    expect(tagListQuerySchema.parse({ page: "2", limit: "50" })).toMatchObject({
      page: 2,
      limit: 50,
      sortBy: "name",
      sortDirection: "asc",
    });
  });

  it("rejects shorthand colors, empty names, empty updates, unknown fields and duplicate tag ids", () => {
    expect(tagColorSchema.safeParse("#fff").success).toBe(false);
    expect(tagColorSchema.safeParse("red").success).toBe(false);
    expect(tagColorSchema.safeParse("#12345g").success).toBe(false);
    expect(tagColorSchema.safeParse("").success).toBe(false);
    expect(tagNameSchema.safeParse("").success).toBe(false);
    expect(tagNameSchema.safeParse("   ").success).toBe(false);
    expect(tagNameSchema.safeParse("a".repeat(51)).success).toBe(false);
    expect(createTagSchema.safeParse({ name: "Roadmap", workspaceId }).success).toBe(false);
    expect(updateTagSchema.safeParse({}).success).toBe(false);
    expect(tagIdsSchema.safeParse([tagId]).success).toBe(true);
    expect(tagIdsSchema.safeParse([tagId, tagId]).success).toBe(false);
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
  it("accepts standalone task metadata and documented query coercion", () => {
    expect(
      createTaskSchema.safeParse({
        projectId,
        noteId,
        title: "Review proposal",
        priority: "high",
        assigneeId: userId,
        dueDate: "2026-08-01T12:00:00Z",
        beforeTaskId: null,
        tagIds: [tagId],
        recurrence: "weekly",
      }).success,
    ).toBe(true);
    expect(
      taskListQuerySchema.parse({
        isCompleted: "false",
        page: "3",
      }),
    ).toMatchObject({
      isCompleted: false,
      page: 3,
      limit: 25,
      grouping: "none",
      sortBy: "sortOrder",
      sortDirection: "asc",
    });
  });

  it("tracks the database enum spelling and rejects the Part-06 aliases", () => {
    expect(taskStatusSchema.safeParse("canceled").success).toBe(true);
    expect(taskStatusSchema.safeParse("cancelled").success).toBe(false);
    expect(taskRecurrenceSchema.safeParse("none").success).toBe(true);
    expect(taskRecurrenceSchema.safeParse("custom").success).toBe(true);
  });

  it("binds custom recurrence to a cron expression in both directions", () => {
    expect(createTaskSchema.safeParse({ title: "Task", recurrence: "custom" }).success).toBe(false);
    expect(
      createTaskSchema.safeParse({
        title: "Task",
        recurrence: "custom",
        recurrenceCron: "0 9 * * 1",
      }).success,
    ).toBe(true);
    expect(
      updateTaskSchema.safeParse({ recurrence: "weekly", recurrenceCron: "0 9 * * 1" }).success,
    ).toBe(false);
    expect(updateTaskSchema.safeParse({ recurrence: "none", recurrenceCron: null }).success).toBe(
      true,
    );
    // A cron with no recurrence would be silently discarded by the service, so
    // it is rejected at the boundary rather than accepted as a no-op.
    expect(updateTaskSchema.safeParse({ recurrenceCron: "0 9 * * 1" }).success).toBe(false);
  });

  it("accepts fractional sort orders from midpoint inserts", () => {
    expect(
      taskSummarySchema.safeParse({
        id: taskId,
        workspaceId,
        projectId: null,
        noteId: null,
        parentId: null,
        title: "Task",
        status: "todo",
        customStatusId: null,
        statusLabel: null,
        priority: "low",
        assigneeId: null,
        dueDate: null,
        completedAt: null,
        sortOrder: 1.5,
        recurrence: "none",
        recurrenceCron: null,
        tagIds: [],
        createdById: userId,
        createdAt: "2026-08-01T12:00:00Z",
        updatedAt: "2026-08-01T12:00:00Z",
      }).success,
    ).toBe(true);
  });

  it("rejects string body numbers, empty updates, unknown authority and reversed dates", () => {
    expect(updateTaskSchema.safeParse({}).success).toBe(false);
    // `position` was the Part-06 field name and no longer exists.
    expect(createTaskSchema.safeParse({ title: "Task", position: 0 }).success).toBe(false);
    expect(createTaskSchema.safeParse({ title: "Task", createdById: userId }).success).toBe(false);
    expect(createTaskSchema.safeParse({ workspaceId, title: "Task" }).success).toBe(false);
    expect(
      taskListQuerySchema.safeParse({
        dueFrom: "2026-08-02T00:00:00Z",
        dueTo: "2026-08-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("bounds bulk selections and rejects duplicate identifiers", () => {
    expect(
      bulkTaskSchema.safeParse({ taskIds: [taskId], action: { kind: "delete" } }).success,
    ).toBe(true);
    expect(
      bulkTaskSchema.safeParse({ taskIds: [taskId, taskId], action: { kind: "delete" } }).success,
    ).toBe(false);
    expect(bulkTaskSchema.safeParse({ taskIds: [], action: { kind: "delete" } }).success).toBe(
      false,
    );
    expect(
      bulkTaskSchema.safeParse({
        // Distinct ids, so this exercises the 100-id cap rather than the
        // duplicate rejection asserted just above. Built as literals because
        // this package's tsconfig has neither the DOM nor the Node globals.
        taskIds: Array.from(
          { length: 101 },
          (_unused, index) =>
            `1f0a3c2e-9b41-4f7c-8f2a-6d5c4b3a${index.toString(16).padStart(4, "0")}`,
        ),
        action: { kind: "delete" },
      }).success,
    ).toBe(false);
    expect(
      bulkTaskSchema.safeParse({
        taskIds: [taskId],
        action: { kind: "status", status: "cancelled" },
      }).success,
    ).toBe(false);
  });
});
