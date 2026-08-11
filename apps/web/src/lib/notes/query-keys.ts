import type { NoteListQuery, TagListQuery, TaskListQuery } from "@notted/shared-types";

export const noteQueryKeys = Object.freeze({
  all: (workspaceId: string) => ["notes", workspaceId] as const,
  list: (workspaceId: string, query: NoteListQuery) =>
    ["notes", workspaceId, "list", query] as const,
  detail: (workspaceId: string, noteId: string) =>
    ["notes", workspaceId, "detail", noteId] as const,
  navigation: (workspaceId: string) => ["notes", workspaceId, "navigation"] as const,
  folders: (workspaceId: string) => ["notes", workspaceId, "folders"] as const,
  shares: (workspaceId: string, noteId: string) =>
    ["notes", workspaceId, noteId, "shares"] as const,
  members: (workspaceId: string) => ["workspace-members", workspaceId] as const,
  /**
   * Attachment metadata for one note (Part 42). Nested under the note rather
   * than the workspace because the listing endpoint is note-scoped and the
   * editor only ever needs the images of the note it has open.
   */
  attachments: (workspaceId: string, noteId: string) =>
    ["notes", workspaceId, noteId, "attachments"] as const,
});

/**
 * Tags are workspace-scoped, not note-scoped, so they get their own root (Part
 * 46). Folding them into `noteQueryKeys` would put keys that do not start with
 * `"notes"` inside it and break prefix invalidation for both.
 */
export const tagQueryKeys = Object.freeze({
  all: (workspaceId: string) => ["tags", workspaceId] as const,
  list: (workspaceId: string, query: TagListQuery) => ["tags", workspaceId, "list", query] as const,
});

/**
 * Tasks are workspace-scoped and reachable from a note, a project or on their
 * own, so they get their own root for the same reason tags did (Part 47).
 * Nesting them under `noteQueryKeys` would make a project task board invalidate
 * note caches it never touched.
 */
export const taskQueryKeys = Object.freeze({
  all: (workspaceId: string) => ["tasks", workspaceId] as const,
  list: (workspaceId: string, query: TaskListQuery) =>
    ["tasks", workspaceId, "list", query] as const,
  /**
   * The board's custom columns (Part 48). Deliberately under the same `all`
   * prefix as the rows: renaming a column changes the `statusLabel` carried on
   * every card, so one `invalidateQueries(all(...))` has to reach both.
   */
  statuses: (workspaceId: string, projectId: string | null) =>
    ["tasks", workspaceId, "statuses", projectId] as const,
});
