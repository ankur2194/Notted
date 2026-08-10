import "server-only";

import { TAG_API_PATHS } from "@notted/shared-types";
import { tagPageSchema, uuidSchema } from "@notted/shared-validators";

import type { ServerReadResult } from "@/lib/api/server-read";
import type { TagPage } from "@notted/shared-types";

import { readJson } from "@/lib/api/server-read";

/**
 * Every tag in the workspace, for the sidebar and the tag manager.
 *
 * One page of 100 is the whole listing as far as the contract allows
 * (`tagPageSchema` caps `limit` at 100); a workspace past that reads its
 * remainder through the client `requestTagPage`.
 */
export function getServerTags(workspaceId: string): Promise<ServerReadResult<TagPage>> {
  const workspace = uuidSchema.safeParse(workspaceId);
  if (!workspace.success) return Promise.resolve({ status: "not-found" });
  return readJson(`${TAG_API_PATHS.collection(workspace.data)}?page=1&limit=100`, (value) =>
    tagPageSchema.safeParse(value),
  );
}
