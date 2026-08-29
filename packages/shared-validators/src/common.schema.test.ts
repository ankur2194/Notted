import { describe, expect, it } from "vitest";

import {
  dateRangeQuerySchema,
  explicitBooleanQuerySchema,
  idempotencyKeySchema,
  isoTimestampSchema,
  jsonValueSchema,
  paginationQuerySchema,
  sortSchema,
  uuidSchema,
} from "./index";

describe("common schemas", () => {
  it("accepts UUIDs and offset-aware ISO timestamps", () => {
    expect(uuidSchema.safeParse("9bb58c7e-8f49-4a7d-b60c-0e32a30a2980").success).toBe(true);
    expect(isoTimestampSchema.safeParse("2026-07-24T12:30:00Z").success).toBe(true);
    expect(isoTimestampSchema.safeParse("2026-07-24T18:00:00+05:30").success).toBe(true);
  });

  it("rejects malformed identifiers and timestamps without offsets", () => {
    expect(uuidSchema.safeParse("workspace-1").success).toBe(false);
    expect(isoTimestampSchema.safeParse("2026-07-24").success).toBe(false);
    expect(isoTimestampSchema.safeParse("2026-07-24T12:30:00").success).toBe(false);
  });

  it("accepts bounded opaque idempotency keys and rejects unsafe values", () => {
    expect(idempotencyKeySchema.parse("workspace-create-00000001")).toBe(
      "workspace-create-00000001",
    );
    expect(idempotencyKeySchema.safeParse("short").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("key with spaces 00000001").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("x".repeat(129)).success).toBe(false);
  });

  it("applies bounded pagination defaults and documented query coercion", () => {
    expect(paginationQuerySchema.parse({})).toEqual({ page: 1, limit: 25 });
    expect(paginationQuerySchema.parse({ page: "2", limit: "100" })).toEqual({
      page: 2,
      limit: 100,
    });
    // `docs/API.md` documents a maximum page of 10 000, which the schema did not
    // enforce: `page` had a `.min(1)` and no ceiling, so any integer reached
    // `offset: (page - 1) * limit` and produced an unbounded database offset.
    expect(paginationQuerySchema.parse({ page: 10_000, limit: 25 })).toEqual({
      page: 10_000,
      limit: 25,
    });
    expect(paginationQuerySchema.parse({ page: 3, limit: 10 })).toEqual({
      page: 3,
      limit: 10,
    });
  });

  it.each([
    { page: "01" },
    { page: "1.5" },
    { page: " 2" },
    { page: 0 },
    { page: 10_001 },
    { limit: 101 },
    { limit: "-1" },
    { extra: "rejected" },
  ])("rejects invalid pagination input %#", (input) => {
    expect(paginationQuerySchema.safeParse(input).success).toBe(false);
  });

  it("coerces only explicit lower-case boolean query strings", () => {
    expect(explicitBooleanQuerySchema.parse("true")).toBe(true);
    expect(explicitBooleanQuerySchema.parse("false")).toBe(false);
    expect(explicitBooleanQuerySchema.safeParse(true).success).toBe(false);
    expect(explicitBooleanQuerySchema.safeParse("TRUE").success).toBe(false);
    expect(explicitBooleanQuerySchema.safeParse("1").success).toBe(false);
  });

  it("accepts recursively JSON-safe data and rejects non-JSON values", () => {
    expect(
      jsonValueSchema.safeParse({
        enabled: true,
        count: 2,
        nested: ["value", null, { ok: false }],
      }).success,
    ).toBe(true);
    expect(jsonValueSchema.safeParse({ missing: undefined }).success).toBe(false);
    expect(jsonValueSchema.safeParse(Number.NaN).success).toBe(false);
    expect(jsonValueSchema.safeParse(new Date()).success).toBe(false);
  });

  it("validates sorting and rejects unknown keys", () => {
    expect(sortSchema.parse({ field: "updatedAt" })).toEqual({
      field: "updatedAt",
      direction: "asc",
    });
    expect(sortSchema.safeParse({ field: "updatedAt", direction: "sideways" }).success).toBe(false);
    expect(sortSchema.safeParse({ field: "updatedAt", sql: "DROP TABLE" }).success).toBe(false);
  });

  it("rejects an inverted date range", () => {
    expect(
      dateRangeQuerySchema.safeParse({
        from: "2026-07-25T00:00:00Z",
        to: "2026-07-24T00:00:00Z",
      }).success,
    ).toBe(false);
  });
});
