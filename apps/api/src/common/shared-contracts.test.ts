import { describe, expect, expectTypeOf, it } from "vitest";

import { parseCollectionPagination } from "./shared-contracts";

import type { PaginationQuery } from "@notted/shared-types";

describe("shared workspace package integration", () => {
  it("uses the shared validator and response type barrels", () => {
    const pagination = parseCollectionPagination({ page: "2", limit: "100" });

    expect(pagination).toEqual({ page: 2, limit: 100 });
    expectTypeOf(pagination).toEqualTypeOf<PaginationQuery>();
  });
});
