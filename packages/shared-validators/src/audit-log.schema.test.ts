import { describe, expect, it } from "vitest";

import {
  AUDIT_LOG_EXPORT_MAX_ROWS,
  auditLogEntrySchema,
  auditLogExportQuerySchema,
  auditLogListQuerySchema,
  auditLogPageSchema,
} from "./audit-log.schema";

const WORKSPACE_ID = "60000000-0000-4000-8000-000000000001";
const USER_ID = "60000000-0000-4000-8000-000000000002";
const ENTITY_ID = "60000000-0000-4000-8000-000000000003";

describe("auditLogListQuerySchema", () => {
  it("defaults pagination and accepts no filters", () => {
    expect(auditLogListQuerySchema.parse({})).toEqual({ page: 1, limit: 25 });
  });

  it("coerces query strings and keeps every filter", () => {
    expect(
      auditLogListQuerySchema.parse({
        page: "2",
        limit: "50",
        action: "apiKey.created",
        entityType: "api_key",
        entityId: ENTITY_ID,
        userId: USER_ID,
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-31T00:00:00.000Z",
      }),
    ).toEqual({
      page: 2,
      limit: 50,
      action: "apiKey.created",
      entityType: "api_key",
      entityId: ENTITY_ID,
      userId: USER_ID,
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-31T00:00:00.000Z",
    });
  });

  it("rejects an inverted range, an unknown key, a bad id, and a deep page", () => {
    expect(
      auditLogListQuerySchema.safeParse({
        from: "2026-08-31T00:00:00.000Z",
        to: "2026-08-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(auditLogListQuerySchema.safeParse({ unexpected: "1" }).success).toBe(false);
    expect(auditLogListQuerySchema.safeParse({ entityId: "not-a-uuid" }).success).toBe(false);
    expect(auditLogListQuerySchema.safeParse({ page: 10_001 }).success).toBe(false);
    expect(auditLogListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe("auditLogExportQuerySchema", () => {
  it("takes the filters but no pagination", () => {
    expect(auditLogExportQuerySchema.parse({ action: "export.download" })).toEqual({
      action: "export.download",
    });
    expect(auditLogExportQuerySchema.safeParse({ page: 1 }).success).toBe(false);
    expect(auditLogExportQuerySchema.safeParse({ limit: 10 }).success).toBe(false);
  });

  it("applies the same range rule as the list", () => {
    expect(
      auditLogExportQuerySchema.safeParse({
        from: "2026-08-31T00:00:00.000Z",
        to: "2026-08-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("caps one export at ten thousand rows", () => {
    expect(AUDIT_LOG_EXPORT_MAX_ROWS).toBe(10_000);
  });
});

describe("auditLogEntrySchema", () => {
  const entry = {
    id: ENTITY_ID,
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    userName: "Alpha Admin",
    action: "apiKey.created",
    entityType: "api_key",
    entityId: ENTITY_ID,
    metadata: { keyPrefix: "ntd_pk_a", scopes: ["read"] },
    ipAddress: "203.0.113.7",
    userAgent: "curl/8.7.1",
    requestId: "9bb58c7e-8f49-4a7d-b60c-0e32a30a2980",
    createdAt: "2026-08-25T10:00:00.000Z",
  };

  it("accepts a full row and a system-actor row", () => {
    expect(auditLogEntrySchema.parse(entry)).toEqual(entry);
    expect(
      auditLogEntrySchema.safeParse({
        ...entry,
        userId: null,
        userName: null,
        ipAddress: null,
        userAgent: null,
        requestId: null,
        metadata: {},
      }).success,
    ).toBe(true);
  });

  it("has no email field and rejects an unknown one", () => {
    expect("userEmail" in entry).toBe(false);
    expect(auditLogEntrySchema.safeParse({ ...entry, userEmail: "a@b.test" }).success).toBe(false);
  });

  it("bounds the address to the column width", () => {
    expect(auditLogEntrySchema.safeParse({ ...entry, ipAddress: "a".repeat(46) }).success).toBe(
      false,
    );
  });

  it("pages the rows with a bounded item count", () => {
    expect(
      auditLogPageSchema.parse({ items: [entry], page: 1, limit: 25, hasMore: false }),
    ).toMatchObject({ hasMore: false });
    expect(
      auditLogPageSchema.safeParse({ items: [], page: 1, limit: 101, hasMore: false }).success,
    ).toBe(false);
  });
});
