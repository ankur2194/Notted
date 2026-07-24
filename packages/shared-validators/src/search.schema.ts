import { z } from "zod";

import {
  explicitBooleanQuerySchema,
  isoTimestampSchema,
  paginationQuerySchema,
  uuidSchema,
} from "./common.schema";

export const searchModeSchema = z.enum(["full-text", "semantic", "hybrid"]);
export const searchSortSchema = z.enum(["relevance", "createdAt", "updatedAt"]);

export const searchQuerySchema = z
  .object({
    workspaceId: uuidSchema,
    query: z.string().trim().min(1).max(500),
    mode: searchModeSchema.default("full-text"),
    projectId: uuidSchema.optional(),
    authorId: uuidSchema.optional(),
    createdFrom: isoTimestampSchema.optional(),
    createdTo: isoTimestampSchema.optional(),
    hasAttachments: explicitBooleanQuerySchema.optional(),
    page: paginationQuerySchema.shape.page,
    limit: paginationQuerySchema.shape.limit,
    sortBy: searchSortSchema.default("relevance"),
  })
  .strict()
  .refine(
    ({ createdFrom, createdTo }) =>
      createdFrom === undefined ||
      createdTo === undefined ||
      Date.parse(createdFrom) <= Date.parse(createdTo),
    {
      message: "createdFrom must be earlier than or equal to createdTo",
      path: ["createdTo"],
    },
  );
export type SearchQueryInput = z.input<typeof searchQuerySchema>;
