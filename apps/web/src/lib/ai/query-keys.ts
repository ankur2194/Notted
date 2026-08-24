/**
 * Part 68 — AI cache keys.
 *
 * Their own root rather than a branch of `noteQueryKeys`: AI state is
 * workspace-scoped and is read by surfaces that have no note open at all
 * (workspace settings), so nesting it under `"notes"` would make a note
 * invalidation reach it and a settings invalidation reach every note.
 *
 * Only the member-readable status projection is keyed here. The admin config and
 * usage roll-up (Part 67) fetch directly and have no shared reader to key for.
 */
export const aiQueryKeys = Object.freeze({
  all: (workspaceId: string) => ["ai", workspaceId] as const,
  status: (workspaceId: string) => ["ai", workspaceId, "status"] as const,
});
