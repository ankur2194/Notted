import { WORKSPACE_API_PATHS } from "@notted/shared-types";

/**
 * Builds the Part 26 member endpoint path for a single workspace. `:id` is the
 * workspace UUID selector encoded for safe URL interpolation.
 */
export function workspaceMemberPath(workspaceId: string): string {
  return WORKSPACE_API_PATHS.member.replace(":id", encodeURIComponent(workspaceId));
}
