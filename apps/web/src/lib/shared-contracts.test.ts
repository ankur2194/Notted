import { paginationQuerySchema } from "@notted/shared-validators";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { PaginationQuery } from "@notted/shared-types";

import { DEFAULT_COLLECTION_PAGINATION, parseCollectionPagination } from "@/lib/shared-contracts";

describe("shared contract package integration", () => {
  it("consumes both packages through their public workspace barrels", () => {
    expect(DEFAULT_COLLECTION_PAGINATION).toEqual({ page: 1, limit: 25 });
    expect(parseCollectionPagination({ page: "2", limit: "100" })).toEqual({
      page: 2,
      limit: 100,
    });
    expect(paginationQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expectTypeOf(DEFAULT_COLLECTION_PAGINATION).toEqualTypeOf<PaginationQuery>();
  });
});
