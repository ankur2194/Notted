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
});
