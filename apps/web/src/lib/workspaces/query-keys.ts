/**
 * Workspace-scoped TanStack Query keys, shaped like `noteQueryKeys` (Part 45).
 *
 * `storage` is nested under the workspace rather than living beside the note
 * keys because the usage aggregate is a property of the workspace, not of any
 * note — and because an upload finishing in one note invalidates the number for
 * every note in the workspace at once.
 */
export const workspaceQueryKeys = Object.freeze({
  all: (workspaceId: string) => ["workspaces", workspaceId] as const,
  storage: (workspaceId: string) => ["workspaces", workspaceId, "storage"] as const,
});
