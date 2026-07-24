import { paginationQuerySchema } from "@notted/shared-validators";

import type { PaginationQuery } from "@notted/shared-types";

/**
 * Backend transport adapter proving both shared packages resolve through their
 * public workspace barrels. Controllers may reuse this for collection queries.
 */
export function parseCollectionPagination(input: unknown): PaginationQuery {
  return paginationQuerySchema.parse(input);
}
