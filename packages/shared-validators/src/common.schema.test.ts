import { describe, expect, it } from "vitest";

import { contrastRatio } from "./color-contrast";

import {
  dateRangeQuerySchema,
  explicitBooleanQuerySchema,
  hexColorSchema,
  idempotencyKeySchema,
  isoTimestampSchema,
  JSON_VALUE_LIMITS,
  jsonValueSchema,
  paginationQuerySchema,
  sortSchema,
  TAG_COLOR_PATTERN,
  tagColorSchema,
  taskStatusColorSchema,
  uuidSchema,
} from "./index";

import type { JsonValueInput } from "./index";

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

  /*
   * The barrel publishes `jsonValueSchema` as the package's general-purpose
   * "validate arbitrary JSON" answer, so its bounds are part of that promise.
   * Unbounded, it accepted 10 000-deep nesting in 14 ms and a 200 000-key
   * object in 162 ms. Its only consumer today is server-produced audit
   * metadata, so this is the guard for the first consumer that points it at
   * request input.
   */
  it("refuses JSON past its depth, breadth, and length bounds", () => {
    const deep = (levels: number): JsonValueInput => {
      let value: JsonValueInput = 1;
      for (let index = 0; index < levels; index += 1) value = { nested: value };
      return value;
    };
    expect(jsonValueSchema.safeParse(deep(JSON_VALUE_LIMITS.maxDepth - 1)).success).toBe(true);
    expect(jsonValueSchema.safeParse(deep(JSON_VALUE_LIMITS.maxDepth + 1)).success).toBe(false);

    const wide = Object.fromEntries(
      Array.from({ length: JSON_VALUE_LIMITS.maxKeys + 1 }, (_unused, index) => [`k${index}`, 1]),
    );
    expect(jsonValueSchema.safeParse(wide).success).toBe(false);

    expect(
      jsonValueSchema.safeParse(new Array(JSON_VALUE_LIMITS.maxItems + 1).fill(1)).success,
    ).toBe(false);

    expect(
      jsonValueSchema.safeParse("x".repeat(JSON_VALUE_LIMITS.maxStringLength + 1)).success,
    ).toBe(false);
    expect(
      jsonValueSchema.safeParse({ ["x".repeat(JSON_VALUE_LIMITS.maxStringLength + 1)]: 1 }).success,
    ).toBe(false);
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

/*
 * One rule, five call sites.
 *
 * The six-digit hex rule was written out five times in this package, and the
 * copies had already drifted: `TAG_COLOR_PATTERN` carried no `i` flag while the
 * other four did, so `#FFF000` was a valid highlight colour and a valid task
 * status colour but reached `tagColorSchema` only because that schema happens to
 * `.toLowerCase()` first. Delete that one `.toLowerCase()` and two rules that
 * read identically start disagreeing.
 *
 * This asserts they agree on the case that separated them, in both directions.
 */
describe("the six-digit hex colour rule", () => {
  const uppercase = "#FFF000";
  const lowercase = "#fff000";

  it("accepts an uppercase value everywhere a tenant can choose a colour", () => {
    expect(hexColorSchema.safeParse(uppercase).success).toBe(true);
    expect(taskStatusColorSchema.safeParse(uppercase).success).toBe(true);
    expect(TAG_COLOR_PATTERN.test(uppercase)).toBe(true);
    expect(contrastRatio(uppercase, "#ffffff")).not.toBeNull();

    // The tag schema normalises before it validates; that is a separate
    // guarantee (one stored value per colour) and it must keep working.
    expect(tagColorSchema.parse(uppercase)).toBe(lowercase);
  });

  it("rejects the same non-colours everywhere", () => {
    for (const value of ["#fff", "#ffffffff", "fff000", "#gggggg", ""]) {
      expect(hexColorSchema.safeParse(value).success, value).toBe(false);
      expect(taskStatusColorSchema.safeParse(value).success, value).toBe(false);
      expect(TAG_COLOR_PATTERN.test(value), value).toBe(false);
      expect(contrastRatio(value, "#ffffff"), value).toBeNull();
    }
  });
});
