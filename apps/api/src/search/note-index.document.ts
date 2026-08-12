import { z } from "zod";

export const NOTE_INDEX_NAME = "notes";
export const NOTE_INDEX_VERSION = "v1";
export const NOTE_INDEX_PRIMARY_KEY = "id";

export function noteIndexUid(indexPrefix: string): string {
  return `${indexPrefix}${NOTE_INDEX_NAME}_${NOTE_INDEX_VERSION}`;
}

/**
 * Rebuildable Meilisearch projection only; PostgreSQL remains authoritative.
 * Timestamps are integer Unix epoch milliseconds in UTC.
 * Task 51.2 selects every non-deleted note, including archived and template
 * notes; those source-state flags are intentionally not provider metadata.
 */
export const noteIndexDocumentSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().max(500),
    content: z.string().max(2_000_000),
    tags: z.array(z.string().min(1).max(200)).max(250).readonly(),
    workspaceId: z.string().uuid(),
    projectId: z.string().uuid().nullable(),
    authorId: z.string().uuid(),
    createdAt: z.number().int().nonnegative().safe(),
    updatedAt: z.number().int().nonnegative().safe(),
    hasAttachments: z.boolean(),
  })
  .strict()
  .readonly();

export type NoteIndexDocument = z.infer<typeof noteIndexDocumentSchema>;

export const NOTE_INDEX_SETTINGS = Object.freeze({
  searchableAttributes: Object.freeze(["title", "tags", "content"]),
  filterableAttributes: Object.freeze([
    "id",
    "workspaceId",
    "projectId",
    "authorId",
    "createdAt",
    "updatedAt",
    "hasAttachments",
  ]),
  sortableAttributes: Object.freeze(["createdAt", "updatedAt"]),
  displayedAttributes: Object.freeze([
    "id",
    "title",
    "content",
    "tags",
    "workspaceId",
    "projectId",
    "authorId",
    "createdAt",
    "updatedAt",
    "hasAttachments",
  ]),
  // Standard relevance order. The searchable attribute order above is the
  // deterministic tie input for the `attribute` rule.
  rankingRules: Object.freeze(["words", "typo", "proximity", "attribute", "sort", "exactness"]),
  typoTolerance: Object.freeze({
    enabled: true,
    minWordSizeForTypos: Object.freeze({ oneTypo: 4, twoTypos: 8 }),
    disableOnWords: Object.freeze([]),
    disableOnAttributes: Object.freeze([]),
  }),
});
