import type { NoteListQuery } from "@notted/shared-types";

export function noteCollectionPath(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/notes`;
}

export function noteViewPath(
  workspaceId: string,
  view: "recent" | "pinned" | "templates" | "trash",
): string {
  return `${noteCollectionPath(workspaceId)}/${view}`;
}

export function standaloneNotePath(workspaceId: string, noteId: string): string {
  return `${noteCollectionPath(workspaceId)}/${encodeURIComponent(noteId)}`;
}

export function projectNotePath(workspaceId: string, projectId: string, noteId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/notes/${encodeURIComponent(noteId)}`;
}

export function noteDetailPath(
  workspaceId: string,
  note: { readonly id: string; readonly projectId: string | null },
): string {
  return note.projectId === null
    ? standaloneNotePath(workspaceId, note.id)
    : projectNotePath(workspaceId, note.projectId, note.id);
}

export function noteListHref(workspaceId: string, query: Partial<NoteListQuery> = {}): string {
  const params = new URLSearchParams();
  if (query.page !== undefined && query.page !== 1) params.set("page", String(query.page));
  if (query.folderId !== undefined && query.folderId !== null)
    params.set("folderId", query.folderId);
  // `NoteListQuery["tagId"]` is optional but never null (unlike `folderId`,
  // whose null means "unfiled"), so an `undefined` check is the whole guard.
  if (query.tagId !== undefined) params.set("tagId", query.tagId);
  if (query.type !== undefined) params.set("type", query.type);
  if (query.isArchived !== undefined) params.set("isArchived", String(query.isArchived));
  if (query.sortBy !== undefined) params.set("sortBy", query.sortBy);
  if (query.sortDirection !== undefined) params.set("sortDirection", query.sortDirection);
  const suffix = params.toString();
  const base =
    query.view !== undefined && query.view !== "normal"
      ? noteViewPath(workspaceId, query.view)
      : noteCollectionPath(workspaceId);
  return `${base}${suffix.length === 0 ? "" : `?${suffix}`}`;
}
