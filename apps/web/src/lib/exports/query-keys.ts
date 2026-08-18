/**
 * Export jobs get their own query-key root (Part 64), deliberately NOT nested
 * under `noteQueryKeys` — the same reasoning that gave tags and tasks a sibling
 * root, but with a sharper consequence here.
 *
 * An export outlives the note it was taken from: it is a workspace-scoped
 * artefact that stays downloadable after the note is edited, renamed, moved, or
 * trashed. If its key started with `["notes", workspaceId, noteId, …]`, then
 * every ordinary note invalidation — an autosave, a share change, a tag edit —
 * would land on a running poll and refetch or discard it. A key root that no
 * note mutation can prefix-match is what keeps the poll a poll.
 */
export const exportQueryKeys = Object.freeze({
  all: (workspaceId: string) => ["exports", workspaceId] as const,
  detail: (workspaceId: string, exportId: string) =>
    ["exports", workspaceId, "detail", exportId] as const,
});
