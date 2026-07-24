import { paginationQuerySchema } from "@notted/shared-validators";

import type { PaginationQuery } from "@notted/shared-types";

/**
 * Web transport-boundary adapter. Feature clients can reuse this parser for
 * URL search parameters without importing validator package internals.
 */
export function parseCollectionPagination(input: unknown): PaginationQuery {
  return paginationQuerySchema.parse(input);
}

export const DEFAULT_COLLECTION_PAGINATION = parseCollectionPagination({});
