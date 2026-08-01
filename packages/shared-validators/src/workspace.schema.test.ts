import { describe, expect, it } from "vitest";

import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  workspaceCreateResultSchema,
  workspaceDeleteResultSchema,
  workspaceDeleteSchema,
  workspaceDetailSchema,
  workspaceListQuerySchema,
  workspacePageSchema,
  workspaceSummarySchema,
} from "./workspace.schema";

const validSummary = {
  id: "20000000-0000-4000-8100-000000000001",
  name: "Notted Alpha",
  slug: "notted-alpha",
  description: "Isolation tenant",
  plan: "free",
  currentUserRole: "owner",
  logoUrl: null,
  updatedAt: "2026-07-31T00:00:00.000Z",
} as const;

describe("workspace lifecycle contracts", () => {
  it("accepts bounded create input and rejects forged/invalid fields", () => {
    expect(
      createWorkspaceSchema.parse({
        name: "Notted Alpha",
        slug: "notted-alpha",
        description: "Isolation tenant",
        settings: { defaultPageSize: "letter" },
      }),
    ).toEqual({
      name: "Notted Alpha",
      slug: "notted-alpha",
      description: "Isolation tenant",
      settings: { defaultPageSize: "letter" },
    });

    // slug must be lower-case + hyphenated, min length 2.
    expect(createWorkspaceSchema.safeParse({ name: "X", slug: "UPPER" }).success).toBe(false);
    expect(createWorkspaceSchema.safeParse({ name: "X", slug: "a" }).success).toBe(false);
    // strict: unknown fields are rejected (forged role/plan).
    expect(
      createWorkspaceSchema.safeParse({
        name: "X",
        slug: "notted-x",
        plan: "pro",
      }).success,
    ).toBe(false);
    // name is required.
    expect(createWorkspaceSchema.safeParse({ slug: "notted-x" }).success).toBe(false);
  });

  it("requires at least one field on update and keeps strict shape", () => {
    expect(updateWorkspaceSchema.parse({ name: "Renamed" })).toEqual({ name: "Renamed" });
    expect(updateWorkspaceSchema.safeParse({}).success).toBe(false);
    expect(updateWorkspaceSchema.safeParse({ plan: "pro" }).success).toBe(false);
    expect(updateWorkspaceSchema.parse({ settings: { defaultPageSize: "a4" } })).toEqual({
      settings: { defaultPageSize: "a4" },
    });
    expect(
      updateWorkspaceSchema.safeParse({ settings: { defaultPageSize: "legal" } }).success,
    ).toBe(false);
    expect(
      updateWorkspaceSchema.safeParse({
        settings: { defaultPageSize: "a4", forged: true },
      }).success,
    ).toBe(false);
  });

  it("coerces and bounds list query pagination with defaults and filters", () => {
    expect(
      workspaceListQuerySchema.parse({
        page: "2",
        limit: "50",
        name: "alpha",
        plan: "pro",
        currentUserRole: "owner",
        sortBy: "name",
        sortDirection: "asc",
      }),
    ).toEqual({
      page: 2,
      limit: 50,
      name: "alpha",
      plan: "pro",
      currentUserRole: "owner",
      sortBy: "name",
      sortDirection: "asc",
    });

    // defaults applied when omitted.
    expect(workspaceListQuerySchema.parse({})).toEqual({
      page: 1,
      limit: 25,
      sortBy: "updatedAt",
      sortDirection: "desc",
    });

    // boundary rejection: limit cap, page cap, invalid enum.
    expect(workspaceListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(workspaceListQuerySchema.safeParse({ page: "10001" }).success).toBe(false);
    expect(workspaceListQuerySchema.safeParse({ plan: "ultimate" }).success).toBe(false);
    expect(workspaceListQuerySchema.safeParse({ sortBy: "deletedAt" }).success).toBe(false);
  });

  it("validates summary, detail, and page response shapes", () => {
    expect(workspaceSummarySchema.parse(validSummary)).toEqual(validSummary);
    // logoUrl may be a URL string.
    expect(
      workspaceSummarySchema.parse({ ...validSummary, logoUrl: "https://cdn.test/logo.png" })
        .logoUrl,
    ).toBe("https://cdn.test/logo.png");
    // invalid plan / role / timestamp rejected.
    expect(workspaceSummarySchema.safeParse({ ...validSummary, plan: "ultimate" }).success).toBe(
      false,
    );
    expect(workspaceSummarySchema.safeParse({ ...validSummary, updatedAt: "today" }).success).toBe(
      false,
    );

    const validDetail = {
      ...validSummary,
      domain: "alpha.notted.test",
      settings: { defaultPageSize: "a4" },
      storageLimitBytes: null,
      createdById: "20000000-0000-4000-8000-000000000001",
      createdAt: "2026-07-29T00:00:00.000Z",
    };
    expect(workspaceDetailSchema.parse(validDetail)).toEqual(validDetail);
    expect(
      workspaceDetailSchema.safeParse({ ...validDetail, createdById: "not-a-uuid" }).success,
    ).toBe(false);
    expect(workspaceDetailSchema.safeParse({ ...validDetail, settings: {} }).success).toBe(false);
    expect(workspaceDetailSchema.safeParse({ ...validDetail, storageLimitBytes: -1 }).success).toBe(
      false,
    );

    expect(
      workspacePageSchema.parse({
        items: [validSummary],
        page: 1,
        limit: 25,
        hasMore: false,
      }).items,
    ).toHaveLength(1);
    expect(
      workspacePageSchema.safeParse({ items: [], page: 0, limit: 25, hasMore: false }).success,
    ).toBe(false);
  });

  it("requires the literal confirmation gate and optional name cross-check on delete", () => {
    expect(workspaceDeleteSchema.parse({ confirm: true })).toEqual({ confirm: true });
    expect(workspaceDeleteSchema.parse({ confirm: true, expectedName: "Notted Alpha" })).toEqual({
      confirm: true,
      expectedName: "Notted Alpha",
    });

    // confirm must be exactly true.
    expect(workspaceDeleteSchema.safeParse({ confirm: "true" }).success).toBe(false);
    expect(workspaceDeleteSchema.safeParse({ confirm: false }).success).toBe(false);
    expect(workspaceDeleteSchema.safeParse({}).success).toBe(false);
    // strict: forged fields rejected.
    expect(workspaceDeleteSchema.safeParse({ confirm: true, id: "forged" }).success).toBe(false);
  });

  it("exposes the final slug and discriminated delete result", () => {
    const createResult = workspaceCreateResultSchema.parse({
      workspace: {
        ...validSummary,
        domain: null,
        settings: { defaultPageSize: "a4" },
        storageLimitBytes: 10_000,
        createdById: "20000000-0000-4000-8000-000000000001",
        createdAt: "2026-07-29T00:00:00.000Z",
      },
      slug: "notted-alpha-2",
    });
    expect(createResult.slug).toBe("notted-alpha-2");

    expect(workspaceDeleteResultSchema.parse({ id: validSummary.id, deleted: true })).toEqual({
      id: validSummary.id,
      deleted: true,
    });
    expect(
      workspaceDeleteResultSchema.safeParse({ id: validSummary.id, deleted: false }).success,
    ).toBe(false);
  });
});
