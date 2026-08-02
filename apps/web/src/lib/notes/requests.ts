import { MEMBERSHIP_API_PATHS, NOTE_API_PATHS } from "@notted/shared-types";
import {
  createFolderSchema,
  createNoteSchema,
  deleteFolderSchema,
  deleteNoteSchema,
  folderCreateResultSchema,
  folderDeleteResultSchema,
  folderPageSchema,
  folderUpdateResultSchema,
  moveNoteSchema,
  noteCreateResultSchema,
  noteDeleteResultSchema,
  noteListQuerySchema,
  noteMoveResultSchema,
  notePageSchema,
  notePermanentDeleteResultSchema,
  noteRestoreResultSchema,
  noteShareDeleteResultSchema,
  noteShareListSchema,
  noteShareUpsertResultSchema,
  noteUpdateResultSchema,
  permanentDeleteNoteSchema,
  restoreNoteSchema,
  updateFolderSchema,
  updateNoteSchema,
  upsertNoteShareSchema,
  uuidSchema,
  workspaceMemberPageSchema,
} from "@notted/shared-validators";

import type {
  FolderCreateResult,
  FolderDeleteResult,
  FolderPage,
  FolderUpdateResult,
  NoteCreateResult,
  NoteDeleteResult,
  NoteListQuery,
  NoteMoveResult,
  NotePage,
  NotePermanentDeleteResult,
  NoteRestoreResult,
  NoteShareDeleteResult,
  NoteShareList,
  NoteShareUpsertResult,
  NoteUpdateResult,
  WorkspaceMemberPage,
} from "@notted/shared-types";
import type {
  CreateFolderInput,
  CreateNoteInput,
  DeleteNoteInput,
  MoveNoteInput,
  PermanentDeleteNoteInput,
  RestoreNoteInput,
  UpdateFolderInput,
  UpdateNoteInput,
  UpsertNoteShareInput,
} from "@notted/shared-validators";

import { publicEnvironment } from "@/config/public-environment";

export type NoteRequestFailureKind =
  "invalid" | "forbidden-or-not-found" | "version-conflict" | "conflict" | "unavailable";
export type NoteRequestResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly kind: NoteRequestFailureKind };

type SafeParser<T> = (value: unknown) => { success: true; data: T } | { success: false };

async function conflictKind(response: Response): Promise<"version-conflict" | "conflict"> {
  try {
    const body: unknown = await response.json();
    const topCode =
      typeof body === "object" && body !== null && "code" in body ? body.code : undefined;
    const nested =
      typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
    const nestedCode =
      typeof nested === "object" && nested !== null && "code" in nested ? nested.code : undefined;
    if (topCode === "VERSION_CONFLICT" || nestedCode === "VERSION_CONFLICT") {
      return "version-conflict";
    }
  } catch {
    // The status remains a safe generic conflict when the error envelope is unavailable.
  }
  return "conflict";
}

async function requestJson<T>(
  path: string,
  init: RequestInit,
  parser: SafeParser<T>,
): Promise<NoteRequestResult<T>> {
  try {
    const response = await fetch(new URL(path, publicEnvironment.NEXT_PUBLIC_API_URL), {
      ...init,
      cache: "no-store",
      credentials: "include",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      if (response.status === 400 || response.status === 422) return { ok: false, kind: "invalid" };
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        return { ok: false, kind: "forbidden-or-not-found" };
      }
      if (response.status === 409) return { ok: false, kind: await conflictKind(response) };
      return { ok: false, kind: "unavailable" };
    }
    const parsed = parser(await response.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, kind: "invalid" };
  } catch {
    return { ok: false, kind: "unavailable" };
  }
}

function validIds(...ids: readonly string[]): boolean {
  return ids.every((id) => uuidSchema.safeParse(id).success);
}

function json(
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

function listSearch(query: NoteListQuery): string {
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
  if (query.isArchived !== undefined) params.set("isArchived", String(query.isArchived));
  return params.toString();
}

export function requestNotePage(
  workspaceId: string,
  query: NoteListQuery,
): Promise<NoteRequestResult<NotePage>> {
  const parsed = noteListQuerySchema.safeParse(query);
  if (!validIds(workspaceId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    `${NOTE_API_PATHS.collection(workspaceId)}?${listSearch(parsed.data)}`,
    {},
    (value) => notePageSchema.safeParse(value),
  );
}

export function createNote(
  workspaceId: string,
  input: CreateNoteInput,
  idempotencyKey: string,
): Promise<NoteRequestResult<NoteCreateResult>> {
  const parsed = createNoteSchema.safeParse(input);
  if (!validIds(workspaceId) || !parsed.success || idempotencyKey.length < 8) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(
    NOTE_API_PATHS.collection(workspaceId),
    json("POST", parsed.data, { "Idempotency-Key": idempotencyKey }),
    (value) => noteCreateResultSchema.safeParse(value),
  );
}

export function updateNote(
  workspaceId: string,
  noteId: string,
  input: UpdateNoteInput,
): Promise<NoteRequestResult<NoteUpdateResult>> {
  const parsed = updateNoteSchema.safeParse(input);
  if (!validIds(workspaceId, noteId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    NOTE_API_PATHS.detail(workspaceId, noteId),
    json("PATCH", parsed.data),
    (value) => noteUpdateResultSchema.safeParse(value),
  );
}

export function moveNote(
  workspaceId: string,
  noteId: string,
  input: MoveNoteInput,
): Promise<NoteRequestResult<NoteMoveResult>> {
  const parsed = moveNoteSchema.safeParse(input);
  if (!validIds(workspaceId, noteId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(NOTE_API_PATHS.move(workspaceId, noteId), json("POST", parsed.data), (value) =>
    noteMoveResultSchema.safeParse(value),
  );
}

export function trashNote(
  workspaceId: string,
  noteId: string,
  input: DeleteNoteInput,
): Promise<NoteRequestResult<NoteDeleteResult>> {
  const parsed = deleteNoteSchema.safeParse(input);
  if (!validIds(workspaceId, noteId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    NOTE_API_PATHS.detail(workspaceId, noteId),
    json("DELETE", parsed.data),
    (value) => noteDeleteResultSchema.safeParse(value),
  );
}

export function restoreNote(
  workspaceId: string,
  noteId: string,
  input: RestoreNoteInput,
): Promise<NoteRequestResult<NoteRestoreResult>> {
  const parsed = restoreNoteSchema.safeParse(input);
  if (!validIds(workspaceId, noteId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    NOTE_API_PATHS.restore(workspaceId, noteId),
    json("POST", parsed.data),
    (value) => noteRestoreResultSchema.safeParse(value),
  );
}

export function permanentlyDeleteNote(
  workspaceId: string,
  noteId: string,
  input: PermanentDeleteNoteInput,
): Promise<NoteRequestResult<NotePermanentDeleteResult>> {
  const parsed = permanentDeleteNoteSchema.safeParse(input);
  if (!validIds(workspaceId, noteId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    NOTE_API_PATHS.permanentDelete(workspaceId, noteId),
    json("POST", parsed.data),
    (value) => notePermanentDeleteResultSchema.safeParse(value),
  );
}

export function requestFolders(workspaceId: string): Promise<NoteRequestResult<FolderPage>> {
  if (!validIds(workspaceId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(`${NOTE_API_PATHS.folders(workspaceId)}?page=1&limit=100`, {}, (value) =>
    folderPageSchema.safeParse(value),
  );
}

export function createFolder(
  workspaceId: string,
  input: CreateFolderInput,
): Promise<NoteRequestResult<FolderCreateResult>> {
  const parsed = createFolderSchema.safeParse(input);
  if (!validIds(workspaceId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(NOTE_API_PATHS.folders(workspaceId), json("POST", parsed.data), (value) =>
    folderCreateResultSchema.safeParse(value),
  );
}

export function updateFolder(
  workspaceId: string,
  folderId: string,
  input: UpdateFolderInput,
): Promise<NoteRequestResult<FolderUpdateResult>> {
  const parsed = updateFolderSchema.safeParse(input);
  if (!validIds(workspaceId, folderId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    NOTE_API_PATHS.folder(workspaceId, folderId),
    json("PATCH", parsed.data),
    (value) => folderUpdateResultSchema.safeParse(value),
  );
}

export function deleteFolder(
  workspaceId: string,
  folderId: string,
): Promise<NoteRequestResult<FolderDeleteResult>> {
  const body = deleteFolderSchema.parse({ confirm: true });
  if (!validIds(workspaceId, folderId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(NOTE_API_PATHS.folder(workspaceId, folderId), json("DELETE", body), (value) =>
    folderDeleteResultSchema.safeParse(value),
  );
}

export function requestWorkspaceMembers(
  workspaceId: string,
): Promise<NoteRequestResult<WorkspaceMemberPage>> {
  if (!validIds(workspaceId)) return Promise.resolve({ ok: false, kind: "invalid" });
  const path = MEMBERSHIP_API_PATHS.members.replace(
    ":workspaceId",
    encodeURIComponent(workspaceId),
  );
  return requestJson(`${path}?page=1&limit=100`, {}, (value) =>
    workspaceMemberPageSchema.safeParse(value),
  );
}

export function requestNoteShares(
  workspaceId: string,
  noteId: string,
): Promise<NoteRequestResult<NoteShareList>> {
  if (!validIds(workspaceId, noteId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(NOTE_API_PATHS.shares(workspaceId, noteId), {}, (value) =>
    noteShareListSchema.safeParse(value),
  );
}

export function upsertNoteShare(
  workspaceId: string,
  noteId: string,
  userId: string,
  input: UpsertNoteShareInput,
): Promise<NoteRequestResult<NoteShareUpsertResult>> {
  const parsed = upsertNoteShareSchema.safeParse(input);
  if (!validIds(workspaceId, noteId, userId) || !parsed.success)
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    NOTE_API_PATHS.share(workspaceId, noteId, userId),
    json("PUT", parsed.data),
    (value) => noteShareUpsertResultSchema.safeParse(value),
  );
}

export function revokeNoteShare(
  workspaceId: string,
  noteId: string,
  userId: string,
): Promise<NoteRequestResult<NoteShareDeleteResult>> {
  if (!validIds(workspaceId, noteId, userId))
    return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(
    NOTE_API_PATHS.share(workspaceId, noteId, userId),
    { method: "DELETE" },
    (value) => noteShareDeleteResultSchema.safeParse(value),
  );
}
