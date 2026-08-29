import "server-only";

import { MEMBERSHIP_API_PATHS, NOTE_API_PATHS } from "@notted/shared-types";
import {
  folderPageSchema,
  membershipListQuerySchema,
  noteDetailSchema,
  noteListQuerySchema,
  noteNavigationSchema,
  notePageSchema,
  uuidSchema,
  workspaceMemberPageSchema,
} from "@notted/shared-validators";
import { cache } from "react";

import type { ServerReadResult } from "@/lib/api/server-read";
import type {
  FolderPage,
  NoteDetail,
  NoteListQuery,
  NoteListView,
  NoteNavigation,
  NotePage,
  WorkspaceMemberPage,
} from "@notted/shared-types";

import { readJson } from "@/lib/api/server-read";

/** Re-exported so existing page and component imports stay unchanged. */
export type { ServerReadResult };

type RawSearchValue = string | readonly string[] | undefined;
export type NoteSearchParams = Readonly<Record<string, RawSearchValue>>;

function first(value: RawSearchValue): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

export function parseNoteSearchParams(
  raw: NoteSearchParams = {},
  options: { readonly view?: NoteListView; readonly projectId?: string } = {},
): NoteListQuery {
  const view = options.view ?? "normal";
  const orderByLifecycle =
    view === "trash"
      ? "deletedAt"
      : view === "recent" ||
          view === "pinned" ||
          view === "templates" ||
          first(raw.isArchived) === "true"
        ? "updatedAt"
        : "sortOrder";
  const defaultDirection = orderByLifecycle === "sortOrder" ? "asc" : "desc";
  const candidate = {
    page: first(raw.page) ?? "1",
    limit: "50",
    scope: options.projectId === undefined ? "workspace-root" : "project",
    projectId: options.projectId,
    folderId: first(raw.folderId),
    type: first(raw.type),
    tagId: first(raw.tagId),
    view,
    isArchived: first(raw.isArchived),
    sortBy: first(raw.sortBy) ?? orderByLifecycle,
    sortDirection: first(raw.sortDirection) ?? defaultDirection,
  };
  const parsed = noteListQuerySchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  // Every raw selector is dropped here, `tagId` included: the fallback exists
  // because one of them failed validation, and carrying a forged one forward
  // would only fail again. An unfiltered list is the safe degradation.
  return noteListQuerySchema.parse({
    page: 1,
    limit: 50,
    scope: options.projectId === undefined ? "workspace-root" : "project",
    projectId: options.projectId,
    view,
    sortBy: orderByLifecycle,
    sortDirection: defaultDirection,
  });
}

function noteSearch(query: NoteListQuery): string {
  const params = new URLSearchParams({
    page: String(query.page),
    limit: String(query.limit),
    scope: query.scope,
    view: query.view,
    sortBy: query.sortBy,
    sortDirection: query.sortDirection,
  });
  if (query.projectId !== undefined) params.set("projectId", query.projectId);
  if (query.folderId !== undefined && query.folderId !== null)
    params.set("folderId", query.folderId);
  if (query.type !== undefined) params.set("type", query.type);
  if (query.tagId !== undefined) params.set("tagId", query.tagId);
  if (query.isArchived !== undefined) params.set("isArchived", String(query.isArchived));
  return params.toString();
}

export function getServerNoteList(
  workspaceId: string,
  raw: NoteSearchParams = {},
  options: { readonly view?: NoteListView; readonly projectId?: string } = {},
): Promise<ServerReadResult<{ page: NotePage; query: NoteListQuery }>> {
  const workspace = uuidSchema.safeParse(workspaceId);
  const project =
    options.projectId === undefined ? undefined : uuidSchema.safeParse(options.projectId);
  if (!workspace.success || (project !== undefined && !project.success)) {
    return Promise.resolve({ status: "not-found" });
  }
  const query = parseNoteSearchParams(raw, { ...options, projectId: project?.data });
  return readJson<{ page: NotePage; query: NoteListQuery }>(
    `${NOTE_API_PATHS.collection(workspace.data)}?${noteSearch(query)}`,
    (value) => {
      const parsed = notePageSchema.safeParse(value);
      return parsed.success
        ? { success: true, data: { page: parsed.data, query } }
        : { success: false };
    },
  );
}

export function getServerNoteDetail(
  workspaceId: string,
  noteId: string,
): Promise<ServerReadResult<NoteDetail>> {
  const workspace = uuidSchema.safeParse(workspaceId);
  const note = uuidSchema.safeParse(noteId);
  if (!workspace.success || !note.success) return Promise.resolve({ status: "not-found" });
  return readJson(NOTE_API_PATHS.detail(workspace.data, note.data), (value) =>
    noteDetailSchema.safeParse(value),
  );
}

export function getServerNoteNavigation(
  workspaceId: string,
): Promise<ServerReadResult<NoteNavigation>> {
  const workspace = uuidSchema.safeParse(workspaceId);
  if (!workspace.success) return Promise.resolve({ status: "not-found" });
  return readJson(
    `${NOTE_API_PATHS.navigation(workspace.data)}?limit=500&includeArchived=false`,
    (value) => noteNavigationSchema.safeParse(value),
  );
}

/**
 * Wrapped in React `cache()`: the dashboard layout reads the folder list for the
 * sidebar and the dashboard page reads it again for the note browser, one
 * request apart, with no way to pass it down (App Router gives a layout no
 * channel to its page). Per request is precisely the window in which the second
 * read is redundant.
 */
export const getServerFolders = cache(function getServerFolders(
  workspaceId: string,
): Promise<ServerReadResult<FolderPage>> {
  const workspace = uuidSchema.safeParse(workspaceId);
  if (!workspace.success) return Promise.resolve({ status: "not-found" });
  return readJson(`${NOTE_API_PATHS.folders(workspace.data)}?page=1&limit=100`, (value) =>
    folderPageSchema.safeParse(value),
  );
});

export function getServerWorkspaceMembers(
  workspaceId: string,
): Promise<ServerReadResult<WorkspaceMemberPage>> {
  const workspace = uuidSchema.safeParse(workspaceId);
  if (!workspace.success) return Promise.resolve({ status: "not-found" });
  const query = membershipListQuerySchema.parse({ page: 1, limit: 100 });
  const path = MEMBERSHIP_API_PATHS.members.replace(
    ":workspaceId",
    encodeURIComponent(workspace.data),
  );
  return readJson(`${path}?page=${query.page}&limit=${query.limit}`, (value) =>
    workspaceMemberPageSchema.safeParse(value),
  );
}
