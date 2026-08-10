import { TAG_API_PATHS } from "@notted/shared-types";
import {
  createTagSchema,
  tagCreateResultSchema,
  tagDeleteResultSchema,
  tagListQuerySchema,
  tagPageSchema,
  tagUpdateResultSchema,
  updateTagSchema,
} from "@notted/shared-validators";

import type { ApiRequestResult } from "@/lib/api/request-json";
import type {
  TagCreateResult,
  TagDeleteResult,
  TagListQuery,
  TagPage,
  TagUpdateResult,
} from "@notted/shared-types";
import type { CreateTagInput, UpdateTagInput } from "@notted/shared-validators";

import { json, requestJson, validIds } from "@/lib/api/request-json";

function tagSearch(query: TagListQuery): string {
  const params = new URLSearchParams({
    page: String(query.page),
    limit: String(query.limit),
    sortBy: query.sortBy,
    sortDirection: query.sortDirection,
  });
  // Only sent when the caller is actually filtering: an empty `name` would be
  // rejected by `tagNameSchema` on the server rather than matching everything.
  if (query.name !== undefined) params.set("name", query.name);
  return params.toString();
}

/**
 * One page of workspace tags.
 *
 * Unlike `requestNotePage`, the already-parsed query needs no restatement
 * before re-validation: `tagListQuerySchema` accepts numbers as well as query
 * strings for `page`/`limit`, and it has no boolean or nullable selectors whose
 * output form would be rejected by its own input contract.
 */
export function requestTagPage(
  workspaceId: string,
  query: TagListQuery,
): Promise<ApiRequestResult<TagPage>> {
  const parsed = tagListQuerySchema.safeParse(query);
  if (!validIds(workspaceId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    `${TAG_API_PATHS.collection(workspaceId)}?${tagSearch(parsed.data)}`,
    {},
    (value) => tagPageSchema.safeParse(value),
  );
}

export function createTag(
  workspaceId: string,
  input: CreateTagInput,
  idempotencyKey: string,
): Promise<ApiRequestResult<TagCreateResult>> {
  const parsed = createTagSchema.safeParse(input);
  if (!validIds(workspaceId) || !parsed.success || idempotencyKey.length < 8) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    TAG_API_PATHS.collection(workspaceId),
    json("POST", parsed.data, { "Idempotency-Key": idempotencyKey }),
    (value) => tagCreateResultSchema.safeParse(value),
  );
}

export function updateTag(
  workspaceId: string,
  tagId: string,
  input: UpdateTagInput,
): Promise<ApiRequestResult<TagUpdateResult>> {
  const parsed = updateTagSchema.safeParse(input);
  if (!validIds(workspaceId, tagId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    TAG_API_PATHS.detail(workspaceId, tagId),
    json("PATCH", parsed.data),
    (value) => tagUpdateResultSchema.safeParse(value),
  );
}

export function deleteTag(
  workspaceId: string,
  tagId: string,
): Promise<ApiRequestResult<TagDeleteResult>> {
  if (!validIds(workspaceId, tagId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(TAG_API_PATHS.detail(workspaceId, tagId), { method: "DELETE" }, (value) =>
    tagDeleteResultSchema.safeParse(value),
  );
}
