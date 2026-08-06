import type { NoteListQuery } from "@notted/shared-types";

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
