import { WORKSPACE_API_PATHS } from "@notted/shared-types";

/**
 * Builds the Part 26 member endpoint path for a single workspace. `:id` is the
 * workspace UUID selector encoded for safe URL interpolation.
 */
export function workspaceMemberPath(workspaceId: string): string {
  return WORKSPACE_API_PATHS.member.replace(":id", encodeURIComponent(workspaceId));
}

/**
 * Builds the Part 45 storage-usage path. A SEPARATE route from the workspace
 * detail (the numbers are an aggregate over the attachment rows), and its
 * selector is `:workspaceId` rather than the detail route's `:id`.
 */
export function workspaceStoragePath(workspaceId: string): string {
  return WORKSPACE_API_PATHS.storage.replace(":workspaceId", encodeURIComponent(workspaceId));
}
