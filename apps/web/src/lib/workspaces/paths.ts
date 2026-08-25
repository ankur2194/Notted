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

/**
 * Builds the Part 72 logo path. `POST` replaces and `DELETE` removes; the
 * tokenised public `GET` beneath it is NEVER built here — the server hands the
 * browser the whole `logoUrl`, and reconstructing it client-side would mean
 * guessing a 128-bit token.
 */
export function workspaceLogoPath(workspaceId: string): string {
  return WORKSPACE_API_PATHS.logo.replace(":workspaceId", encodeURIComponent(workspaceId));
}

/**
 * Builds the Part 73 custom-domain path. A SINGLETON, so there is no id to
 * interpolate beyond the workspace: `GET` reads, `PUT` claims, `DELETE`
 * releases.
 */
export function workspaceDomainPath(workspaceId: string): string {
  return WORKSPACE_API_PATHS.domain.replace(":workspaceId", encodeURIComponent(workspaceId));
}

/**
 * Builds the Part 73 re-check path. Built from its OWN constant rather than by
 * appending `/verify` to the path above, so a future change to either route
 * cannot leave the two silently disagreeing.
 */
export function workspaceDomainVerifyPath(workspaceId: string): string {
  return WORKSPACE_API_PATHS.domainVerify.replace(":workspaceId", encodeURIComponent(workspaceId));
}
