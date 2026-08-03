import { requestAllWorkspaceMembers } from "./requests";

import type { WorkspaceMemberPage } from "@notted/shared-types";

/**
 * The query function behind `noteQueryKeys.members`.
 *
 * Declared once and shared by every consumer of that key — the mention menu and
 * the share dialog — so the same cache entry can never hold a differently
 * truncated list depending on which component happened to populate it first.
 * `hasMore` on the result means "this client stopped before the server ran out",
 * never "these are all the members".
 */
export async function fetchWorkspaceMemberDirectory(
  workspaceId: string,
): Promise<WorkspaceMemberPage> {
  const result = await requestAllWorkspaceMembers(workspaceId);
  if (!result.ok) throw new Error(result.kind);
  return result.data;
}
